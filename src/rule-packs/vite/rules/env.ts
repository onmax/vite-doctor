import { basename, dirname, relative, resolve } from "pathe";
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
// Vitest exposes process.env as import.meta.env and sets these, so app code reads them to detect a
// test run and expects them to be undefined in the browser.
const vitestEnvKeys = new Set([
  "TEST",
  "VITEST",
  "VITEST_MODE",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
]);

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
        if (vitestEnvKeys.has(name) && owningProjectUsesVitest(ctx)) return;
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

function owningWorkspacePackage(ctx: RuleContext) {
  const { root, workspacePackages } = ctx.project;
  const path = relative(root, ctx.file.path);
  return (workspacePackages ?? [])
    .filter(({ root }) => root !== "." && path.startsWith(`${root}/`))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

function owningProjectUsesVitest(ctx: RuleContext): boolean {
  const owner = owningWorkspacePackage(ctx);
  const projectRoot = ctx.project.root;
  const root = owner ? resolve(projectRoot, owner.root) : projectRoot;
  const key = `vite:uses-vitest:${root}`;
  const cached = ctx.cache.get<boolean>(key);
  if (cached !== undefined) return cached;
  const localConfig = findConfig(ctx, root, VITEST_CONFIG_FILES);
  const usesVitest =
    declaresDependency(ctx, root, "vitest") ||
    (localConfig !== undefined && vitestConfigRoot(ctx, localConfig) === root) ||
    ((declaresDependency(ctx, root, "vite-plus") ||
      (root !== projectRoot && declaresDependency(ctx, projectRoot, "vite-plus"))) &&
      readTestConfig(ctx, root, VITE_CONFIG_FILES)?.test !== undefined) ||
    (root !== projectRoot && selectsVitestProject(ctx, projectRoot, root));
  ctx.cache.set(key, usesVitest);
  return usesVitest;
}

const VITEST_CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (extension) => `vitest.config.${extension}`,
);
const VITEST_ROOT_CONFIG_FILES = [
  ...VITEST_CONFIG_FILES,
  ...VITEST_CONFIG_FILES.map((name) => name.replace("vitest.", "vite.")),
];

function declaresDependency(ctx: RuleContext, root: string, name: string): boolean {
  const manifest = ctx.fs.readJson(resolve(root, "package.json"));
  if (manifest && typeof manifest === "object") {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const deps = (manifest as Record<string, unknown>)[field];
      if (deps && typeof deps === "object" && Object.hasOwn(deps, name)) return true;
    }
  }
  return false;
}

function findConfig(ctx: RuleContext, dir: string, names: readonly string[]) {
  return names.map((name) => resolve(dir, name)).find((file) => ctx.fs.stat(file)?.isFile());
}

function readTestConfig(ctx: RuleContext, dir: string, names: readonly string[]) {
  const file = findConfig(ctx, dir, names);
  return file ? readVitestConfig(ctx, file) : undefined;
}

function readVitestConfig(ctx: RuleContext, file: string) {
  const text = ctx.fs.readText(file);
  const scope = text === undefined ? null : analyzeScript(text, "ts");
  if (!scope) return;
  const config = staticConfig(scope, "vitest");
  if (!config) return;
  const test = config.has("test") ? objectProperties(scope, config.get("test")) : undefined;
  if (test !== null) return { scope, config, test };
}

function vitestRootOption({
  scope,
  config,
  test,
}: NonNullable<ReturnType<typeof readVitestConfig>>) {
  const testRoot = test?.get("root");
  if (testRoot) {
    const path = staticString(resolveConst(scope, testRoot));
    if (path !== "") return path;
  }
  const root = config.get("root");
  return root ? staticString(resolveConst(scope, root)) : ".";
}

function vitestConfigRoot(ctx: RuleContext, file: string): string | undefined {
  const config = readVitestConfig(ctx, file);
  const path = config && vitestRootOption(config);
  if (typeof path === "string") return resolve(dirname(file), path);
}

function selectedVitestRoot(ctx: RuleContext, path: string): string | undefined {
  const stat = ctx.fs.stat(path);
  if (stat?.isDirectory()) {
    const config = findConfig(ctx, path, VITEST_ROOT_CONFIG_FILES);
    return config ? vitestConfigRoot(ctx, config) : path;
  }
  if (stat?.isFile() && /^vite(?:st)?(?:\.[\w-]+)?\.config\./.test(basename(path))) {
    return vitestConfigRoot(ctx, path);
  }
}

function selectsVitestProject(ctx: RuleContext, dir: string, ownerRoot: string): boolean {
  const testConfig = readTestConfig(ctx, dir, VITEST_ROOT_CONFIG_FILES);
  if (!testConfig?.test) return false;
  const { scope, test } = testConfig;
  const rootPath = vitestRootOption(testConfig);
  if (rootPath === null) return false;
  const root = resolve(dir, rootPath);
  const projects = resolveConst(scope, test.get("projects"));
  if (projects?.type !== "ArrayExpression") return false;

  const entries: AnyNode[] = projects.elements.map((element: AnyNode) =>
    resolveConst(scope, element),
  );
  const paths = entries.flatMap((entry) => {
    const path = staticString(entry);
    return path === null ? [] : [path.replace("<rootDir>", () => root)];
  });
  const exclude = [
    "**/node_modules/**",
    ...paths.filter((path) => path.startsWith("!")).map((path) => path.slice(1)),
  ];
  const matchesOwner = (path: string) => selectedVitestRoot(ctx, path) === ownerRoot;
  return (
    paths.some((path) => {
      if (path.startsWith("!")) return false;
      if (!/[*?{[()]/.test(path)) return matchesOwner(resolve(root, path));
      return ctx.fs.glob(path, { cwd: root, exclude }).some(matchesOwner);
    }) ||
    entries.some((entry) => {
      const project = objectProperties(scope, entry);
      const options = project && objectProperties(scope, project.get("test"));
      const path = staticString(resolveConst(scope, options?.get("root") ?? project?.get("root")));
      return path !== null && resolve(root, path) === ownerRoot;
    })
  );
}

function projectViteConfig(ctx: RuleContext): string | undefined {
  const { root } = ctx.project;
  const path = relative(root, ctx.file.path);
  if (path === ".." || path.startsWith("../")) return;
  const owner = owningWorkspacePackage(ctx);
  if (owner && owner.framework !== "vite" && owner.framework !== "vue") return;
  const configRoot = owner ? resolve(root, owner.root) : root;
  return findConfig(ctx, configRoot, VITE_CONFIG_FILES);
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
