import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join, relative, resolve } from "pathe";
import type {
  AutoImportEntry,
  DoctorFramework,
  NuxtDoctorManifest,
  NuxtProjectInfo,
  ProjectInfo,
  ProjectLanguage,
  WorkspaceNuxtInventory,
  WorkspacePackage,
} from "../primitives.js";
import {
  detectWorkspacePackages,
  nuxtInventoryOwner,
  owningWorkspacePackage,
  runtimeGraphPackage,
  workspaceFramework,
} from "./workspace-packages.js";
import { createNuxtProjectInventory, normalizeNuxtModuleSources } from "./nuxt-inventory.js";
import { detectNuxtModuleDefinitions } from "./nuxt-module-inventory.js";
import type { RuntimeTarget } from "../primitives.js";
import { ProjectFileWalk, rememberProjectFileWalk, type ProjectEntry } from "./project-files.js";
import { loadTypeScript } from "./lazy-parsers.js";
import {
  applyRuntimeTarget,
  isNuxtManifestCurrent,
  readNuxtConfigSsr,
  resolveNuxtCompatibility,
  resolveRuntimeGraph,
  type NuxtConfigCache,
} from "./runtime-graph.js";

export async function detectProject(
  root: string,
  requested: "auto" | DoctorFramework = "auto",
  runtimeTarget?: RuntimeTarget,
): Promise<ProjectInfo> {
  const packageJson = readJson<{
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>(join(root, "package.json"));
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.optionalDependencies,
    ...packageJson?.devDependencies,
  };
  const nuxtVersion = deps.nuxt ?? deps["@nuxt/kit"];
  const vueVersion = deps.vue ?? ">=3.5";
  const workspacePackages = await detectWorkspacePackages(root);
  const framework = requested === "auto" ? workspaceFramework(workspacePackages) : requested;
  const detectedOwner = nuxtInventoryOwner(workspacePackages);
  const graphPackage = runtimeGraphPackage(workspacePackages, framework);
  if (requested !== "auto") workspacePackages[0]!.framework = requested;
  // An explicit Nuxt run with several nested Nuxt apps treats the workspace root as the owner.
  const nuxtOwnerRoot =
    framework !== "nuxt"
      ? undefined
      : (detectedOwner?.root ?? (requested === "nuxt" ? "." : undefined));
  const ssr = framework === "nuxt" || framework === "nitro" || hasVueSsrEvidence(packageJson, deps);
  const isMonorepo =
    workspacePackages.length > 1 ||
    existsSync(join(root, "pnpm-workspace.yaml")) ||
    existsSync(join(root, "turbo.json"));
  const owner =
    nuxtOwnerRoot === undefined
      ? undefined
      : await detectNuxtInventory(
          root,
          nuxtOwnerRoot,
          workspacePackages.find((item) => item.root === nuxtOwnerRoot)?.packages ?? deps,
          nuxtVersion,
          runtimeTarget,
        );
  const runtime = owner
    ? { graph: owner.runtimeGraph, compatibility: owner.nuxtCompatibility }
    : applyRuntimeTarget(
        resolveRuntimeGraph(root, framework, join(root, graphPackage?.root ?? ".", "package.json")),
        undefined,
        runtimeTarget,
      );
  const workspaceNuxt =
    framework === "nuxt"
      ? await Promise.all(
          workspacePackages
            .filter((item) => item.framework === "nuxt" && item.root !== nuxtOwnerRoot)
            .map((item) =>
              detectNuxtInventory(root, item.root, item.packages, nuxtVersion, runtimeTarget),
            ),
        )
      : [];
  const tsconfigPath = existsSync(join(root, "tsconfig.json"))
    ? join(root, "tsconfig.json")
    : undefined;
  const walk = new ProjectFileWalk(root);
  const project: ProjectInfo = {
    root: resolve(root),
    framework,
    ssr: ssr && owner?.nuxt?.ssr !== false,
    vueVersion: runtime.graph.packages.vue?.version ?? cleanVersion(vueVersion),
    nuxtVersion: owner?.nuxtVersion,
    isMonorepo,
    packageName: packageJson?.name,
    workspacePackages,
    ...(workspaceNuxt.length ? { workspaceNuxt } : {}),
    tsconfigPath,
    languages: await detectProjectLanguages(walk, Boolean(tsconfigPath)),
    nuxt: owner?.nuxt,
    nuxtModuleDefinitions: owner?.nuxtModuleDefinitions,
    runtimeGraph: runtime.graph,
    nuxtCompatibility: runtime.compatibility,
    inventory: { packages: deps },
  };
  const unappliedConfigs = workspaceNuxt.filter((item) => item.nuxt.doctorConfig);
  const evidenceGaps: NonNullable<ProjectInfo["evidenceGaps"]> = [
    ...(owner ? missingNuxtManifestGaps(root, owner.root, owner.nuxt, workspacePackages) : []),
    ...unappliedConfigs.map((item) => ({
      source: "vite-doctor/workspace-nuxt",
      message: `Doctor options from the vite-doctor/nuxt module in ${item.root} only apply when Doctor runs from that package. Run Doctor from ${item.root} to apply them.`,
      files: [relative(root, item.nuxt.manifestPath ?? join(root, item.root))],
    })),
  ];
  if (evidenceGaps.length) project.evidenceGaps = evidenceGaps;
  rememberProjectFileWalk(project, walk);
  return project;
}

/** Nuxt Project Inventory and runtime graph of the Nuxt app at workspace package `packageRoot`. */
async function detectNuxtInventory(
  workspaceRoot: string,
  packageRoot: string,
  packageDeps: Record<string, string | undefined>,
  fallbackVersion: string | undefined,
  runtimeTarget: RuntimeTarget | undefined,
): Promise<WorkspaceNuxtInventory & Required<Pick<WorkspaceNuxtInventory, "runtimeGraph">>> {
  const appRoot = join(workspaceRoot, packageRoot);
  const declaredVersion = packageDeps.nuxt ?? packageDeps["@nuxt/kit"];
  const facts = readNuxtRunFacts(appRoot);
  const nuxt = await detectNuxt(
    appRoot,
    declaredVersion ?? fallbackVersion ?? ">=4",
    packageDeps,
    facts,
  );
  const graph = resolveRuntimeGraph(workspaceRoot, "nuxt", join(appRoot, "package.json"));
  const targeted = applyRuntimeTarget(
    graph,
    resolveNuxtCompatibility(appRoot, graph, facts.manifest, facts.configs, facts.manifestCurrent),
    runtimeTarget,
  );
  return {
    root: packageRoot,
    nuxt,
    nuxtVersion:
      targeted.graph.packages.nuxt?.version ?? cleanVersion(fallbackVersion ?? nuxt.version),
    nuxtModuleDefinitions: await detectNuxtModuleDefinitions(appRoot, nuxt.appRoots),
    runtimeGraph: targeted.graph,
    nuxtCompatibility: targeted.compatibility,
  };
}

const LANGUAGE_SOURCE = /\.(?:vue|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// Matches `fs.glob("**/*.{vue,ts,...}")` with node_modules, dist, coverage, generated, and dot
// directories excluded, which is exactly what the shared walk skips.
async function detectProjectLanguages(
  walk: ProjectFileWalk,
  hasTsconfig: boolean,
): Promise<ProjectLanguage[]> {
  let hasTypeScript = hasTsconfig;
  let hasJavaScript = false;
  for (const entry of walk.entries()) {
    for (const path of languageSources(walk, entry)) {
      if (/\.(?:ts|tsx|mts|cts)$/.test(path)) hasTypeScript = true;
      if (/\.(?:js|jsx|mjs|cjs)$/.test(path)) hasJavaScript = true;
      if (path.endsWith(".vue")) {
        const languages = await detectVueScriptLanguages(walk.root, path);
        hasTypeScript ||= languages.includes("typescript");
        hasJavaScript ||= languages.includes("javascript");
      }
    }
    if (hasTypeScript && hasJavaScript) break;
  }
  return [
    ...(hasTypeScript ? (["typescript"] as const) : []),
    ...(hasJavaScript ? (["javascript"] as const) : []),
  ];
}

// `fs.glob` steps one level into a symlinked directory whose name matches the last segment.
function languageSources(walk: ProjectFileWalk, entry: ProjectEntry): string[] {
  if (!LANGUAGE_SOURCE.test(entry.name)) return [];
  if (entry.kind !== "symlinked-directory") return [entry.path];
  return [
    entry.path,
    ...walk
      .children(entry.path)
      .filter((name) => LANGUAGE_SOURCE.test(name))
      .map((name) => `${entry.path}/${name}`),
  ];
}

async function detectVueScriptLanguages(root: string, file: string): Promise<ProjectLanguage[]> {
  try {
    let hasTypeScript = false;
    let hasJavaScript = false;
    const source = readFileSync(join(root, file), "utf8");
    const { parse } = await import("@vue/compiler-sfc");
    const { descriptor, errors } = parse(source, { filename: file, sourceMap: false });
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      const lang = (block.lang ?? "js").toLowerCase();
      if (lang === "ts" || lang === "tsx") hasTypeScript = true;
      if (lang === "js" || lang === "jsx") hasJavaScript = true;
    }
    if (errors.length && !hasTypeScript && !hasJavaScript) {
      for (const lang of recoverVueScriptLanguages(source)) {
        if (lang === "typescript") hasTypeScript = true;
        if (lang === "javascript") hasJavaScript = true;
      }
    }
    return [
      ...(hasTypeScript ? (["typescript"] as const) : []),
      ...(hasJavaScript ? (["javascript"] as const) : []),
    ];
  } catch {
    return [];
  }
}

function recoverVueScriptLanguages(source: string): ProjectLanguage[] {
  const languages = new Set<ProjectLanguage>();
  let quote = "";
  for (let index = 0; index < source.length; index++) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source[index] === "<" && /^<script(?:\s|>)/i.test(source.slice(index))) {
      let cursor = index + 1;
      let attributeQuote = "";
      for (; cursor < source.length; cursor++) {
        const character = source[cursor];
        if (attributeQuote) {
          if (character === attributeQuote) attributeQuote = "";
        } else if (character === '"' || character === "'") {
          attributeQuote = character;
        } else if (character === ">") {
          break;
        }
      }
      const attributes = source.slice(index + 7, cursor);
      const langMatch = attributes.match(/\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i);
      const lang = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? "js").toLowerCase();
      if (lang === "ts" || lang === "tsx") languages.add("typescript");
      if (lang === "js" || lang === "jsx") languages.add("javascript");
      const close = source.indexOf("</script", cursor + 1);
      index = close === -1 ? cursor : close + 8;
      quote = "";
      continue;
    }
    if (source[index] === "<" && /^<template(?:\s|>)/i.test(source.slice(index))) {
      index = skipVueTemplate(source, index) - 1;
      continue;
    }
    if (quote) {
      if (source[index] === quote) quote = "";
      continue;
    }
    if (source[index] === '"' || source[index] === "'") {
      quote = source[index];
      continue;
    }
    const customBlock = source.slice(index).match(/^<([A-Za-z][\w-]*)(?:\s[^>]*)?>/);
    if (
      customBlock &&
      !/^(?:template|script|div|p|span|section|main|header|footer|component)$/i.test(customBlock[1])
    ) {
      const contentStart = index + customBlock[0].length;
      const close = new RegExp(`</${customBlock[1]}\\s*>`, "i").exec(source.slice(contentStart));
      index = close ? contentStart + close.index + close[0].length - 1 : source.length;
      continue;
    }
  }
  return [...languages];
}

function skipVueTemplate(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end === -1) return source.length;
      index = end + 2;
      continue;
    }
    if (source[index] !== "<") continue;
    const tag = source.slice(index).match(/^<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/);
    if (!tag) continue;
    let cursor = index + tag[0].length;
    let quote = "";
    for (; cursor < source.length; cursor++) {
      const character = source[cursor];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (cursor === source.length) return source.length;
    const name = tag[2].toLowerCase();
    const closing = tag[1] === "/";
    const selfClosing = source[cursor - 1] === "/";
    if (name === "template") {
      if (closing) depth--;
      else if (!selfClosing) depth++;
      if (depth === 0) return cursor + 1;
    } else if (!closing && !selfClosing && (name === "script" || name === "style")) {
      const close = new RegExp(`</${name}\\s*>`, "i").exec(source.slice(cursor + 1));
      if (!close) return source.length;
      cursor += close.index + close[0].length;
    }
    index = cursor;
  }
  return source.length;
}

function hasVueSsrEvidence(
  packageJson: { scripts?: Record<string, string> } | null,
  deps: Record<string, string | undefined>,
): boolean {
  const packageNames = Object.keys(deps);
  if (
    packageNames.some((name) =>
      /^(vitepress|vuepress|@vuepress\/|@vue\/server-renderer|vite-ssg|vite-plugin-ssr|vike|nuxt)$/.test(
        name,
      ),
    )
  )
    return true;
  return Object.values(packageJson?.scripts ?? {}).some((script) =>
    /\b(vitepress|vuepress|vite-ssg|vike|vite\s+build\s+--ssr)\b/.test(script),
  );
}

interface NuxtRunFacts {
  manifest: NuxtDoctorManifest | null;
  manifestPath?: string;
  manifestCurrent: boolean;
  configs: NuxtConfigCache;
}

// Created per Doctor Run, so the manifest freshness check (a recursive server directory scan) and
// nuxt.config reads run once without outliving the run.
function readNuxtRunFacts(root: string): NuxtRunFacts {
  const manifestPath = join(root, ".nuxt/doctor.manifest.json");
  const manifest = readJson<NuxtDoctorManifest>(manifestPath);
  const configs: NuxtConfigCache = new Map();
  return {
    manifest,
    manifestPath: manifest || existsSync(manifestPath) ? manifestPath : undefined,
    manifestCurrent: isNuxtManifestCurrent(root, manifest, configs),
    configs,
  };
}

async function detectNuxt(
  root: string,
  version: string,
  deps: Record<string, string | undefined>,
  { manifest, manifestPath, manifestCurrent, configs }: NuxtRunFacts,
): Promise<NuxtProjectInfo> {
  const config = readNuxtConfigText(root);
  const autoImportEntries = (manifest?.autoImports ?? coreAutoImports()) as AutoImportEntry[];
  const detectedAppRoots = await detectNuxtAppRoots(root);
  const appRoots = [
    ...(manifest?.layers ?? []).map((layer) => resolve(root, layer.root)),
    ...detectedAppRoots,
  ];
  return {
    version: cleanVersion(manifest?.nuxtVersion ?? version),
    appDir: resolve(root, manifest?.appDir ?? (existsSync(join(root, "app")) ? "app" : ".")),
    appRoots: [...new Set(appRoots)].sort(),
    autoImportEnabled: manifest ? manifest.autoImportEnabled === true : true,
    autoImportsAuthoritative: manifest?.autoImportEnabled !== undefined && manifestCurrent,
    autoImports: new Map(autoImportEntries.map((entry) => [entry.as ?? entry.name, entry])),
    autoImportEntries,
    components: new Map(
      (manifest?.components ?? []).map((component: any) => [component.name, component]),
    ),
    layers: manifest?.layers ?? [{ root, priority: 0 }],
    localLayerAliases: manifest?.localLayerAliases,
    routeRules: manifest?.routeRules ?? readRouteRules(config.primary),
    ssr: (manifestCurrent ? manifest?.ssr : undefined) ?? readNuxtConfigSsr(root, configs),
    runtimeConfig: manifest?.runtimeConfig,
    serverDirs: await serverDirs(root),
    doctorConfig: manifest?.doctorConfig,
    manifestPath,
    modules: mergeDetectedModules(manifest?.modules ?? [], deps, config.anyFormat),
    moduleSources: normalizeNuxtModuleSources(manifest?.moduleSources ?? []),
    manifest: createNuxtProjectInventory(
      root,
      manifest,
      manifestPath,
      readNuxtImportsDirs(config.primary),
      manifestCurrent,
    ),
  };
}

async function detectNuxtAppRoots(root: string): Promise<string[]> {
  const configs = await globFiles(root, [
    "nuxt.config.{ts,js,mjs,cjs,mts,cts}",
    "*/nuxt.config.{ts,js,mjs,cjs,mts,cts}",
    "*/*/nuxt.config.{ts,js,mjs,cjs,mts,cts}",
  ]);
  if (!configs.length) return [root];
  return [...new Set(configs.map((file) => resolve(file, "..")))].sort();
}

// The module hands nuxt.config `doctor` options and Nuxt's resolved inventory to the CLI only
// through this manifest, so without it a run silently ignores the developer's configuration.
function missingNuxtManifestGaps(
  root: string,
  packageRoot: string,
  nuxt: NuxtProjectInfo,
  workspacePackages: readonly WorkspacePackage[],
): NonNullable<ProjectInfo["evidenceGaps"]> {
  const appRoot = join(root, packageRoot);
  // A nuxt.config inside another workspace package writes its manifest to that package's .nuxt,
  // so it cannot be what this app's missing manifest is about.
  const ownAppRoots = nuxt.appRoots.filter(
    (appDir) =>
      owningWorkspacePackage(workspacePackages, relative(root, appDir)) === packageRoot ||
      isNuxtLayerAppRoot(appRoot, appDir, workspacePackages, root),
  );
  if (nuxt.manifestPath || !registersDoctorModule(appRoot, { ...nuxt, appRoots: ownAppRoots }))
    return [];
  const manifest = relative(root, join(appRoot, ".nuxt/doctor.manifest.json"));
  return [
    {
      source: "vite-doctor/nuxt",
      message: `nuxt.config registers vite-doctor/nuxt, but ${manifest} does not exist, so this Doctor Run ignored the doctor options in nuxt.config and Nuxt's resolved auto-imports, components, and server handlers. Run nuxt prepare first; it does not need a build.`,
      files: [manifest],
    },
  ];
}

function isNuxtLayerAppRoot(
  appRoot: string,
  candidateRoot: string,
  workspacePackages: readonly WorkspacePackage[],
  workspaceRoot: string,
): boolean {
  if (candidateRoot === appRoot) return false;
  const config = readNuxtConfigText(appRoot).anyFormat;
  if (!config) return false;
  const extendsValues = [...config.matchAll(/\bextends\s*:\s*(?:\[([^\]]*)\]|(['"])(.*?)\2)/gs)]
    .flatMap((match) =>
      match[1] ? [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]) : [match[3]],
    )
    .filter((value): value is string => Boolean(value));
  const candidatePackage = owningWorkspacePackage(
    workspacePackages,
    relative(workspaceRoot, candidateRoot),
  );
  const candidate = workspacePackages.find((item) => item.root === candidatePackage);
  return extendsValues.some((value) => {
    const resolved = resolve(appRoot, value);
    return resolved === candidateRoot || value === candidate?.name;
  });
}

function registersDoctorModule(appRoot: string, nuxt: NuxtProjectInfo): boolean {
  const roots = new Set([
    appRoot,
    ...nuxt.appRoots,
    ...nuxt.layers.map((layer) => resolve(appRoot, layer.root)),
  ]);
  return [...roots].some((root) =>
    registersDoctorModuleInConfig(readNuxtConfigText(root).anyFormat),
  );
}

function registersDoctorModuleInConfig(config: string | null): boolean {
  if (!config) return false;
  const ts = loadTypeScript();
  const source = ts.createSourceFile("nuxt.config.ts", config, ts.ScriptTarget.Latest, true);
  type Expr = import("typescript").Expression;
  type Scope = { parent: Scope | null; bindings: Map<string, Expr> };
  const nodeScopes = new WeakMap<import("typescript").Node, Scope>();
  const rootScope: Scope = { parent: null, bindings: new Map() };
  const scopeNodes = new Set([
    ts.SyntaxKind.SourceFile,
    ts.SyntaxKind.Block,
    ts.SyntaxKind.ModuleBlock,
    ts.SyntaxKind.CatchClause,
  ]);
  const collectScopes = (node: import("typescript").Node, scope: Scope) => {
    const current =
      scopeNodes.has(node.kind) && node !== source
        ? { parent: scope, bindings: new Map<string, Expr>() }
        : scope;
    nodeScopes.set(node, current);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      current.bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, (child) => collectScopes(child, current));
  };
  collectScopes(source, rootScope);

  const resolve = (name: string, scope: Scope | null | undefined): Expr | undefined => {
    for (let current = scope; current; current = current.parent) {
      const binding = current.bindings.get(name);
      if (binding) return binding;
    }
    return undefined;
  };
  const resolving = new Set<Expr>();
  const hasDoctorModule = (value: Expr, scope: Scope | undefined): boolean => {
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return value.text === "vite-doctor/nuxt";
    }
    if (ts.isIdentifier(value)) {
      const binding = resolve(value.text, scope);
      if (!binding || resolving.has(binding)) return false;
      resolving.add(binding);
      const found = hasDoctorModule(binding, nodeScopes.get(binding));
      resolving.delete(binding);
      return found;
    }
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.some((element) =>
        ts.isSpreadElement(element)
          ? hasDoctorModule(element.expression, scope)
          : element.kind !== ts.SyntaxKind.OmittedExpression &&
            hasDoctorModule(element as Expr, scope),
      );
    }
    return false;
  };
  const inspectConfig = (value: Expr, scope: Scope | undefined): boolean => {
    if (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertionExpression(value) ||
      ts.isSatisfiesExpression(value)
    ) {
      return inspectConfig(value.expression, scope);
    }
    if (ts.isIdentifier(value)) {
      const binding = resolve(value.text, scope);
      if (!binding || resolving.has(binding)) return false;
      resolving.add(binding);
      const found = inspectConfig(binding, nodeScopes.get(binding));
      resolving.delete(binding);
      return found;
    }
    if (ts.isCallExpression(value)) {
      return value.arguments.some((arg) => inspectConfig(arg, scope));
    }
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      if (ts.isBlock(value.body)) {
        return value.body.statements.some((statement) =>
          ts.isReturnStatement(statement) && statement.expression
            ? inspectConfig(statement.expression, nodeScopes.get(statement))
            : false,
        );
      }
      return inspectConfig(value.body, nodeScopes.get(value.body));
    }
    if (!ts.isObjectLiteralExpression(value)) return false;
    return value.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        const name = property.name.getText(source).replace(/["']/g, "");
        return name === "modules" ? hasDoctorModule(property.initializer, scope) : false;
      }
      return ts.isShorthandPropertyAssignment(property) && property.name.text === "modules"
        ? hasDoctorModule(property.name, nodeScopes.get(property))
        : false;
    });
  };
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (inspectConfig(statement.expression, nodeScopes.get(statement))) return true;
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(statement.expression.left) &&
      ts.isIdentifier(statement.expression.left.expression) &&
      statement.expression.left.expression.text === "module" &&
      statement.expression.left.name.text === "exports" &&
      inspectConfig(statement.expression.right, nodeScopes.get(statement))
    )
      return true;
  }
  return false;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readNuxtConfigText(root: string): { primary: string | null; anyFormat: string | null } {
  const primary =
    readFileSyncIfExists(join(root, "nuxt.config.ts")) ??
    readFileSyncIfExists(join(root, "nuxt.config.js"));
  return {
    primary,
    anyFormat:
      primary ??
      readFileSyncIfExists(join(root, "nuxt.config.mjs")) ??
      readFileSyncIfExists(join(root, "nuxt.config.mts")) ??
      readFileSyncIfExists(join(root, "nuxt.config.cjs")) ??
      readFileSyncIfExists(join(root, "nuxt.config.cts")),
  };
}

function readRouteRules(config: string | null): Record<string, unknown> {
  if (!config?.includes("routeRules")) return {};
  return { __staticDetection: true };
}

function readNuxtImportsDirs(config: string | null): string[] {
  const importsBlock = config?.match(/\bimports\s*:\s*\{[\s\S]*?\n\s*\}/)?.[0];
  const dirsBlock = importsBlock?.match(/\bdirs\s*:\s*\[([\s\S]*?)\]/)?.[1];
  if (!dirsBlock) return [];
  return [...dirsBlock.matchAll(/["'`]([^"'`]+)["'`]/g)].map((match) => match[1]!).filter(Boolean);
}

const SERVER_DIRECTORIES = ["api", "routes", "middleware", "plugins"] as const;

async function serverDirs(root: string): Promise<NuxtProjectInfo["serverDirs"]> {
  const directories: NuxtProjectInfo["serverDirs"] = {
    api: [],
    routes: [],
    middleware: [],
    plugins: [],
  };
  const files = await globFiles(
    root,
    SERVER_DIRECTORIES.flatMap((directory) => [
      `server/${directory}/**/*.{ts,js,mjs,mts,cts,cjs}`,
      `app/server/${directory}/**/*.{ts,js,mjs,mts,cts,cjs}`,
    ]),
  );
  for (const file of files) {
    const path = relative(root, file).replace(/^app\//, "");
    const directory = SERVER_DIRECTORIES.find((name) => path.startsWith(`server/${name}/`));
    if (directory) directories[directory].push(file);
  }
  return directories;
}

async function globFiles(root: string, patterns: string[]): Promise<string[]> {
  const files = new Set<string>();
  for await (const entry of glob(patterns, { cwd: root })) {
    if (typeof entry === "string") files.add(resolve(root, entry));
  }
  return [...files].sort();
}

function coreAutoImports(): AutoImportEntry[] {
  return [
    "useFetch",
    "useAsyncData",
    "useRoute",
    "useRouter",
    "useRuntimeConfig",
    "useNuxtApp",
    "navigateTo",
    "defineNuxtRouteMiddleware",
    "definePageMeta",
    "useState",
  ].map((name) => ({ name, from: "#imports", kind: "nuxt" as const }));
}

function readFileSyncIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function cleanVersion(version: string): string {
  return version.replace(/^[^\d]*/, "") || version;
}

function mergeDetectedModules(
  modules: Array<{ name: string; version?: string; doctorPlugin?: string }>,
  deps: Record<string, string | undefined>,
  config: string | null,
) {
  const detected = new Map(modules.map((module) => [module.name, module]));
  for (const [name, version] of Object.entries(deps)) {
    if (!version) continue;
    if (
      name === "nuxt" ||
      name === "docus" ||
      name === "shadcn-nuxt" ||
      name === "@vueuse/core" ||
      name.startsWith("@nuxt/") ||
      name.startsWith("@nuxtjs/") ||
      name.startsWith("nuxt-")
    ) {
      detected.set(name, detected.get(name) ?? { name, version: cleanVersion(version) });
    }
  }
  if (extendsDocus(config)) detected.set("docus", detected.get("docus") ?? { name: "docus" });
  return [...detected.values()];
}

function extendsDocus(config: string | null): boolean {
  return Boolean(config && /extends\s*:\s*(?:\[[^\]]*["']docus["']|["']docus["'])/.test(config));
}
