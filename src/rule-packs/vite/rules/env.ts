import { dirname, relative, resolve } from "pathe";
import { createRule, type RuleContext } from "../../../core/index.js";
import { analyzeScript } from "../../../core/internal/script-scope.js";
import { VITE_CONFIG_FILES } from "../../../core/internal/vite-config-file.js";
import { diagnostics } from "../../../diagnostics.js";
import {
  clientDefineObjects,
  objectProperties,
  resolveConst,
  staticConfig,
} from "./static-config.js";
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
        const prefixes =
          contract.prefixes.map((prefix) => `"${prefix}"`).join(", ") || "none configured";
        const serverOnly = `Read ${name} in server-only code.`;
        const publicPrefix = contract.prefixes[0];
        ctx.report(
          diagnostics.VITE0030({
            why: `import.meta.env.${name} is undefined at runtime: Vite exposes only env variables whose names start with an envPrefix (${prefixes}) and keys set through define.`,
            fix:
              !publicPrefix || SECRET_NAME_RE.test(name)
                ? serverOnly
                : `If ${name} is public, rename it with the ${publicPrefix} prefix in both the .env file and the code. Otherwise, read it in server-only code.`,
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
  const configFile = projectViteConfig(ctx);
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

function projectViteConfig(ctx: RuleContext): string | undefined {
  const { root, workspacePackages } = ctx.project;
  const path = relative(root, ctx.file.path);
  if (path === ".." || path.startsWith("../")) return;
  const owner = (workspacePackages ?? [])
    .filter(({ root }) => root !== "." && path.startsWith(`${root}/`))
    .sort((left, right) => right.root.length - left.root.length)[0];
  if (owner && owner.framework !== "vite") return;
  const configRoot = owner ? resolve(root, owner.root) : root;
  return VITE_CONFIG_FILES.map((name) => resolve(configRoot, name)).find((file) =>
    ctx.fs.stat(file)?.isFile(),
  );
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
  const scope = analyzeScript(text, "ts");
  if (!scope) return null;
  const config = staticConfig(scope);
  if (!config || config.has("root")) return null;
  for (const node of scope.ast.body) {
    if (node.type === "ImportDeclaration" && String(node.source.value).startsWith(".")) {
      const local = readRelativeModule(ctx, configFile, String(node.source.value));
      if (local === undefined || /\benvPrefix\b|\bdefine\b|import\.meta\.env\b/.test(local))
        return null;
    }
  }
  const prefixes = config.has("envPrefix")
    ? staticStrings(resolveConst(scope, config.get("envPrefix")))
    : ["VITE_"];
  const defines = clientDefineObjects(scope, config);
  if (!prefixes || prefixes.includes("") || !defines) return null;
  const defineKeys: string[] = [];
  for (const define of defines) {
    const entries = objectProperties(scope, define);
    if (!entries) return null;
    for (const name of entries.keys()) {
      if (name === "import.meta.env" || name === "import.meta") return null;
      if (name.startsWith("import.meta.env.")) defineKeys.push(name.slice(16));
    }
  }
  return { prefixes: [...new Set(prefixes)], defineKeys };
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
