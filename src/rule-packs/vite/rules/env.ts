import { dirname, relative, resolve } from "pathe";
import { parseSync } from "oxc-parser";
import { createRule, type RuleContext } from "../../../core/index.js";
import { walkScriptLocal } from "../../../core/rule-authoring.js";
import { diagnostics } from "../../../diagnostics.js";
import {
  hasTypeDeclaration,
  isLikelySsrFile,
  isViteConfigFile,
  memberPath,
  propertyName,
  readViteConfigFacts,
  SECRET_NAME_RE,
  staticString,
  type AnyNode,
} from "./shared.js";

export const noUntypedEnv = createRule({
  meta: {
    id: "vite/env/no-untyped-env",
    title: "Type Vite environment variables",
    category: "types",
    severity: "warn",
    confidence: "heuristic-medium",
    docsUrl: "https://vite.dev/guide/env-and-mode#intellisense-for-typescript",
    requires: { script: true },
  },
  create(ctx) {
    return {
      MemberExpression(node: AnyNode) {
        const name = importMetaEnvKey(node);
        if (!name || builtInEnvKeys.has(name) || hasTypeDeclaration(ctx, name, true)) return;
        // Declaring a key Vite never exposes would type a value that is always undefined.
        const contract = clientEnvContract(ctx);
        if (contract && !contract.exposes(name)) return;
        ctx.report(
          diagnostics.VITE0011({
            why: `import.meta.env.${name} is used but not declared on ImportMetaEnv.`,
            fix: `Declare ${name} in vite-env.d.ts or env.d.ts.`,
          }),
          {
            ruleId: "vite/env/no-untyped-env",
            severity: ctx.severity,
            category: "types",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const noClientSecretPattern = createRule({
  meta: {
    id: "vite/env/no-client-secret-pattern",
    title: "Do not read secret-looking env vars in client code",
    category: "security",
    severity: "error",
    confidence: "heuristic-medium",
    docsUrl: "https://vite.dev/guide/env-and-mode#env-variables",
    requires: { script: true },
  },
  create(ctx) {
    const exposure = envExposureEvidence(ctx.project.runtimeEvidence?.vite, ctx.project.root);
    return {
      MemberExpression(node: AnyNode) {
        const name = importMetaEnvKey(node);
        if (!name || !SECRET_NAME_RE.test(name)) return;
        if (
          exposure &&
          !exposure.hasObjectDefine &&
          !exposure.defineKeys.includes(name) &&
          !exposure.prefixes.some((prefix) => name.startsWith(prefix))
        )
          return;
        ctx.report(
          diagnostics.VITE0009({
            why: `import.meta.env.${name} looks like a secret and may be exposed to the browser.`,
            fix: "Read secrets only in server-only code and expose deliberate public values.",
          }),
          {
            ruleId: "vite/env/no-client-secret-pattern",
            severity: ctx.severity,
            category: "security",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

interface EnvExposureEvidence {
  root: string;
  prefixes: string[];
  defineKeys: string[];
  hasObjectDefine: boolean;
}

function envExposureEvidence(runtime: unknown, root: string): EnvExposureEvidence | undefined {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return;
  const evidence = (runtime as Record<string, unknown>).envExposure;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return;
  const {
    root: owner,
    prefixes,
    defineKeys,
    hasObjectDefine,
  } = evidence as Record<string, unknown>;
  if (
    owner !== root ||
    !Array.isArray(prefixes) ||
    ![...prefixes].every((prefix) => typeof prefix === "string") ||
    !Array.isArray(defineKeys) ||
    ![...defineKeys].every((key) => typeof key === "string") ||
    typeof hasObjectDefine !== "boolean"
  )
    return;
  return { root, prefixes, defineKeys, hasObjectDefine };
}

export const preferDirectImportMetaEnvAccess = createRule({
  meta: {
    id: "vite/env/prefer-direct-import-meta-env-access",
    title: "Prefer direct import.meta.env access",
    category: "configuration",
    severity: "info",
    confidence: "proven",
    docsUrl: "https://vite.dev/guide/env-and-mode#env-variables",
    requires: { script: true },
  },
  create(ctx) {
    return {
      VariableDeclarator(node: AnyNode) {
        if (node.id?.type !== "ObjectPattern") return;
        if (memberPath(node.init) !== "import.meta.env") return;
        ctx.report(
          diagnostics.VITE0012({
            why: "Destructuring import.meta.env hides individual compile-time env reads.",
            fix: "Read Vite env values directly as import.meta.env.VITE_NAME.",
          }),
          {
            ruleId: "vite/env/prefer-direct-import-meta-env-access",
            severity: ctx.severity,
            category: "configuration",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const noEmptyEnvPrefix = createRule({
  meta: {
    id: "vite/env/no-empty-env-prefix",
    title: "Do not set an empty env prefix",
    description:
      'Reports envPrefix: "" in Vite config, which Vite rejects when it resolves the config.',
    category: "configuration",
    severity: "error",
    confidence: "heuristic-medium",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#envprefix",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        for (const config of await readViteConfigFacts(ctx)) {
          for (const prefix of config.envPrefixes) {
            if (prefix.value !== "") continue;
            ctx.report(
              diagnostics.VITE0010({
                why: 'Vite throws while resolving a config whose envPrefix contains "", so vite dev and vite build stop before loading any env variable.',
                fix: 'Remove "" from envPrefix and keep the default VITE_ prefix or a narrow public prefix.',
              }),
              {
                ruleId: "vite/env/no-empty-env-prefix",
                severity: ctx.severity,
                category: "configuration",
                file: config.file,
                range: prefix.range,
              },
            );
          }
        }
      },
    };
  },
});

export const noBroadEnvPrefix = createRule({
  meta: {
    id: "vite/env/no-broad-env-prefix",
    title: "Avoid broad Vite env prefixes",
    description: "Keep Vite client env prefixes narrow enough to avoid accidental exposure.",
    category: "security",
    severity: "warn",
    confidence: "heuristic-medium",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#envprefix",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        for (const config of await readViteConfigFacts(ctx)) {
          for (const prefix of config.envPrefixes) {
            // VITE0010 owns "", which Vite rejects instead of exposing anything.
            if (prefix.value === "" || !isBroadPrefix(prefix.value)) continue;
            ctx.report(
              diagnostics.VITE0008({
                why: `Vite envPrefix "${prefix.value}" is broad enough to expose unrelated variables.`,
                fix: "Use a narrow public prefix and keep secret names outside client env prefixes.",
              }),
              {
                ruleId: "vite/env/no-broad-env-prefix",
                severity: ctx.severity,
                category: "security",
                file: config.file,
                range: prefix.range,
              },
            );
          }
        }
      },
    };
  },
});

const builtInEnvKeys = new Set(["MODE", "BASE_URL", "PROD", "DEV", "SSR"]);

function importMetaEnvKey(node: AnyNode): string | null {
  if (node?.type !== "MemberExpression") return null;
  if (memberPath(node.object) !== "import.meta.env") return null;
  return node.computed ? staticString(node.property) : propertyName(node.property);
}

function isBroadPrefix(value: string): boolean {
  return value.length <= 1 || value === "APP_" || value === "PUBLIC_";
}

export const noUnprefixedClientEnv = createRule({
  meta: {
    id: "vite/env/no-unprefixed-client-env",
    title: "Read only exposed env variables in client code",
    description:
      "Reports import.meta.env reads of keys that Vite never exposes because they miss every envPrefix and no define sets them.",
    category: "configuration",
    severity: "warn",
    confidence: "heuristic-high",
    docsUrl: "https://vite.dev/guide/env-and-mode#env-variables",
    requires: { script: true },
    prefilter: { names: ["env"] },
  },
  create(ctx) {
    return {
      MemberExpression(node: AnyNode) {
        const name = importMetaEnvKey(node);
        if (!name || builtInEnvKeys.has(name) || isAssignmentTarget(node)) return;
        const contract = clientEnvContract(ctx);
        if (!contract || contract.exposes(name)) return;
        // Without host evidence VITE0009 reports secret-looking names as possibly exposed.
        if (contract.source === "config" && SECRET_NAME_RE.test(name)) return;
        const prefixes = contract.prefixes.map((prefix) => `"${prefix}"`).join(", ");
        ctx.report(
          diagnostics.VITE0030({
            why: `import.meta.env.${name} is undefined at runtime: Vite exposes only env variables whose names start with an envPrefix (${prefixes}) and keys set through define.`,
            fix: `Rename the variable so it starts with ${contract.prefixes[0]} in both the .env file and the code, or read ${name} in server-only code. Add a prefix to envPrefix only if every variable it matches is public.`,
          }),
          {
            ruleId: "vite/env/no-unprefixed-client-env",
            severity: ctx.severity,
            category: "configuration",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

interface ClientEnvContract {
  source: "host" | "config";
  prefixes: string[];
  exposes(name: string): boolean;
}

const VITE_CONFIG_NAMES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (extension) => `vite.config.${extension}`,
);
// Frameworks that load env into import.meta.env themselves, or set envPrefix from plugin hooks
// Doctor cannot read without the host config.
const ENV_OWNING_PACKAGES = new Set([
  "nuxt",
  "nitropack",
  "nitro",
  "astro",
  "@sveltejs/kit",
  "vike",
  "vite-plugin-ssr",
  "@analogjs/platform",
  "@builder.io/qwik-city",
  "@qwik.dev/router",
  "@solidjs/start",
  "@tanstack/react-start",
  "@tanstack/solid-start",
  "@react-router/dev",
  "@remix-run/dev",
  "@storybook/builder-vite",
  "electron-vite",
]);
const ENV_PLUGIN_RE =
  /import-meta-env|env-compatible|runtime-env|vite-plugin-(?:[\w-]*-)?env(?:ironment)?(?:-|$)/;
// Keys that published plugins set through their own config hook, such as @vitejs/plugin-legacy.
const PLUGIN_ENV_KEYS = new Set(["LEGACY"]);
const NON_CLIENT_PATH_RE =
  /(?:^|\/)(?:server|api|scripts|\.storybook)\/|\.stories\.[cm]?[jt]sx?$|\.server\.[cm]?[jt]sx?$/;

/**
 * What Vite puts on import.meta.env for the current client file, or null when Doctor cannot know:
 * the file is not client code, a framework owns env, or the config computes envPrefix or define.
 */
function clientEnvContract(ctx: RuleContext): ClientEnvContract | null {
  const path = ctx.file.relativePath;
  if (isViteConfigFile(path) || isLikelySsrFile(path) || NON_CLIENT_PATH_RE.test(path)) return null;
  if (ctx.project.framework === "nuxt" || ctx.project.framework === "nitro" || ctx.project.nuxt)
    return null;
  const exposure = envExposureEvidence(ctx.project.runtimeEvidence?.vite, ctx.project.root);
  if (exposure) {
    if (exposure.hasObjectDefine) return null;
    return {
      source: "host",
      prefixes: exposure.prefixes,
      exposes: (name) =>
        exposure.defineKeys.includes(name) ||
        exposure.prefixes.some((prefix) => name.startsWith(prefix)),
    };
  }
  const configFile = nearestViteConfig(ctx, dirname(ctx.file.path));
  if (!configFile) return null;
  const key = `vite:client-env-contract:${configFile}`;
  let facts = ctx.cache.get<StaticEnvFacts | null>(key);
  if (facts === undefined) {
    facts = readStaticEnvFacts(ctx, configFile);
    ctx.cache.set(key, facts);
  }
  if (!facts) return null;
  const { prefixes, defineKeys } = facts;
  return {
    source: "config",
    prefixes,
    exposes: (name) =>
      PLUGIN_ENV_KEYS.has(name) ||
      defineKeys.includes(name) ||
      prefixes.some((prefix) => name.startsWith(prefix)),
  };
}

function nearestViteConfig(ctx: RuleContext, dir: string): string | undefined {
  const root = ctx.project.root;
  while (true) {
    for (const name of VITE_CONFIG_NAMES) {
      const file = resolve(dir, name);
      if (ctx.fs.exists(file)) return file;
    }
    if (dir === root || relative(root, dir).startsWith("..")) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

interface StaticEnvFacts {
  prefixes: string[];
  defineKeys: string[];
}

function readStaticEnvFacts(ctx: RuleContext, configFile: string): StaticEnvFacts | null {
  for (const dir of new Set([dirname(configFile), ctx.project.root])) {
    const manifest = ctx.fs.readJson(resolve(dir, "package.json"));
    if (!manifest || typeof manifest !== "object") continue;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = (manifest as Record<string, unknown>)[field];
      if (!deps || typeof deps !== "object") continue;
      if (
        Object.keys(deps).some((name) => ENV_OWNING_PACKAGES.has(name) || ENV_PLUGIN_RE.test(name))
      )
        return null;
    }
  }
  const text = ctx.fs.readText(configFile);
  if (text === undefined) return null;
  const { program, errors } = parseSync(configFile, text, { sourceType: "module", astType: "ts" });
  if (errors.some((error) => error.severity === "Error")) return null;
  const prefixes: string[] = [];
  const defineKeys: string[] = [];
  let prefixProperties = 0;
  let defineProperties = 0;
  let unknown = false;
  walkScriptLocal(program, (node: AnyNode) => {
    if (unknown) return;
    if (node.type === "CallExpression" && memberPath(node.callee)?.endsWith("mergeConfig"))
      unknown = true;
    if (node.type === "ImportDeclaration" && String(node.source.value).startsWith(".")) {
      const local = readRelativeModule(ctx, configFile, String(node.source.value));
      if (local === undefined || /\benvPrefix\b|import\.meta\.env\b/.test(local)) unknown = true;
    }
    if (node.type !== "Property" || node.computed) return;
    const key = propertyName(node.key);
    if (key === "envPrefix") {
      prefixProperties++;
      const values = staticStrings(node.value);
      if (!values) unknown = true;
      else prefixes.push(...values);
    }
    if (key === "define") {
      defineProperties++;
      if (node.value.type !== "ObjectExpression") return void (unknown = true);
      for (const entry of node.value.properties) {
        const name = entry.type === "Property" ? propertyName(entry.key) : null;
        if (name === null || (entry.computed && staticString(entry.key) === null)) {
          unknown = true;
          continue;
        }
        if (name === "import.meta.env" || name === "import.meta") unknown = true;
        else if (name.startsWith("import.meta.env.")) defineKeys.push(name.slice(16));
      }
    }
  });
  // A mention outside a plain property, such as `config.envPrefix = ...`, can change the result.
  if (
    unknown ||
    prefixProperties !== (text.match(/\benvPrefix\b/g)?.length ?? 0) ||
    defineProperties !== (text.match(/(?<![.\w$])define\b(?!\s*[(\w$])/g)?.length ?? 0)
  )
    return null;
  if (prefixProperties === 0) return { prefixes: ["VITE_"], defineKeys };
  return prefixes.length ? { prefixes: [...new Set(prefixes)], defineKeys } : null;
}

function readRelativeModule(ctx: RuleContext, from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    ...["ts", "mts", "js", "mjs"].flatMap((extension) => [
      `${base}.${extension}`,
      `${base}/index.${extension}`,
    ]),
  ]) {
    if (ctx.fs.stat(candidate)?.isFile()) return ctx.fs.readText(candidate);
  }
}

function staticStrings(node: AnyNode): string[] | null {
  const value = staticString(node);
  if (value !== null) return [value];
  if (node?.type !== "ArrayExpression") return null;
  const values = node.elements.map((element: AnyNode) => staticString(element));
  return values.every((item: string | null) => item !== null) ? values : null;
}

function isAssignmentTarget(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  return (
    (parent?.type === "AssignmentExpression" && parent.left === node) ||
    (parent?.type === "UpdateExpression" && parent.argument === node) ||
    (parent?.type === "UnaryExpression" && parent.operator === "delete")
  );
}
