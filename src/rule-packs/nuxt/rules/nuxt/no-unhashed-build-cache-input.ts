import { dirname, isAbsolute, join, relative, resolve } from "pathe";
import type {
  AutoImportEntry,
  Confidence,
  DiagnosticEvidence,
  NuxtProjectInfo,
  ProjectInfo,
  RuleContext,
  SourceRange,
  TemplateRootNode,
} from "../../../../core/index.js";
import { evaluateRuntimeRange } from "../../../../core/internal/applicability.js";
import { parseScript } from "../../../../core/internal/script.js";
import { analyzeScript, scopeDialect } from "../../../../core/internal/script-scope.js";
import {
  createVueScriptForParsing,
  parseSfcFile,
  parseVueScripts,
} from "../../../../core/internal/sfc.js";
import {
  TemplateNodeType,
  parseTemplateExpression,
  walkTemplate,
} from "../../../../core/internal/template.js";
import { diagnostics } from "../../diagnostics.js";
import {
  FUNCTION_TYPES,
  buildCacheSource,
  declaredNames,
  exportedConfigObject,
  isNonReference,
  objectExpression,
  propertyValue,
  topLevelBindings,
  unwrap,
} from "./nuxt-config-ast.js";
import { NUXT_APP_DIRS, createRule, toPosixPath, walkScriptLocal, type AnyNode } from "./shared.js";

const RULE_ID = "nuxt/config/no-unhashed-build-cache-input";
const SOURCE_GLOB = "**/*.{vue,ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
// Tests and stories sit in srcDir but never reach the Vue build.
const OUTSIDE_BUILD = /(?:^|\/)__tests__\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"];
const CONFIG_FILES = ["ts", "mts", "js", "mjs", "cts", "cjs"].map((ext) => `nuxt.config.${ext}`);
// getVueHash hashes these files at each local layer root next to srcDir.
const HASHED_ROOT_FILES = new Set([
  ".nuxtrc",
  ".npmrc",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "bun.lock",
  "bun.lockb",
]);
// nuxt/nuxt#36704 adds dir.shared to the key on main. No release up to 4.6.2 includes it, and a
// later 4.x release may or may not, so shared/ is reported only where the gap is proven.
const SHARED_UNHASHED_NUXT = "<=4.6.2";
const RELATED_LIMIT = 10;
const FOLLOW_LIMIT = 2000;
const ALL_EXPORTS = "*";

interface Layer {
  root: string;
  /** Unset when Doctor cannot tell which directory Nuxt hashes for the layer. */
  srcDir?: string;
  srcDirFrom: "manifest" | "config" | "layout";
  serverDir: string;
  publicDir: string;
  sharedDir: string;
}

interface Site {
  file: string;
  range?: SourceRange;
  target: string;
  how: "import" | "auto-import" | "plugin";
  /** Import specifier or auto-imported name. */
  name: string;
}

interface Group {
  path: string;
  directory: boolean;
  layer: Layer;
  shared: boolean;
  sites: Site[];
}

interface ImportUse {
  node: AnyNode;
  specifier: string;
  /** Imported binding names, or null for a side-effect import. */
  names: Set<string> | null;
}

interface ParsedFile {
  text: string;
  program: AnyNode;
  script?: { text: string; dialect: "ts" | "tsx" | "jsx" };
  template?: TemplateRootNode | null;
}

export const noUnhashedBuildCacheInput = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep Vue build inputs inside the Nuxt build cache key",
    category: "cache",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/going-further/experimental-features#buildcache",
    execution: "workspace",
    requires: { nuxt: true, crossFile: true },
    requiresContext: ["cross-file", "manifest"],
    consumesEvidence: ["ast", "manifest"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onProjectEnd(project) {
        if (project.nuxt) await reportUnhashedInputs(ctx, project, project.nuxt);
      },
    };
  },
});

async function reportUnhashedInputs(ctx: RuleContext, project: ProjectInfo, nuxt: NuxtProjectInfo) {
  // A stale inventory cannot prove the current layout or any registered build inputs.
  if (nuxt.manifest?.hasManifest && !nuxt.manifest.isCurrent) return;
  const appRoot = absolute(project.root, primaryLayerRoot(nuxt) ?? project.root);
  const config = readConfig(ctx, appRoot);
  const enabledBy = buildCacheSource(
    nuxt.productionBuildCache,
    config?.object ?? null,
    config?.bindings ?? new Map(),
  );
  if (!enabledBy) return;
  const layers = localLayers(ctx, project, nuxt, appRoot, config);
  if (!layers?.some((layer) => layer.srcDir && layer.srcDir !== layer.root)) return;
  const nuxtVersion = project.runtimeGraph?.packages.nuxt?.version;
  const sharedUnhashed =
    evaluateRuntimeRange(project, "nuxt", SHARED_UNHASHED_NUXT).state === "active";
  const analysis = new InputAnalysis(ctx, nuxt, appRoot, layers, sharedUnhashed);
  await analysis.run();

  for (const group of analysis.groups.values()) {
    const sites = group.sites.toSorted(
      (a, b) => a.file.localeCompare(b.file) || (a.range?.start ?? 0) - (b.range?.start ?? 0),
    );
    const [first, ...rest] = sites;
    if (!first) continue;
    const label = displayPath(appRoot, group.path, group.directory);
    const srcLabel = displayPath(appRoot, group.layer.srcDir!, true);
    const files = new Set(sites.map((site) => site.file)).size;
    const version = nuxtVersion ? `Nuxt ${nuxtVersion}` : "This Nuxt version";
    const coverage = group.shared
      ? `${version} hashes only ${srcLabel} for this layer; nuxt/nuxt#36704 adds ${label} to the key, but no release up to 4.6.2 includes it.`
      : `Nuxt hashes only ${srcLabel} for this layer, plus its package.json, lockfiles, tsconfig.json, .npmrc, .nuxtrc and the raw nuxt.config.`;
    ctx.report(
      diagnostics.NUXT0093({
        why: `${label} feeds the Vue build but is not part of the experimental.buildCache key: ${describeSite(appRoot, first)}${files > 1 ? `, and ${files - 1} more file${files > 2 ? "s use" : " uses"} it` : ""}. ${coverage} A commit that only changes ${label} keeps the same cache key, so the build restores the old client and SSR bundles next to a freshly built server.`,
        fix: fixFor(label, srcLabel, group.shared),
      }),
      {
        ruleId: RULE_ID,
        severity: ctx.severity,
        category: "cache",
        file: first.file,
        range: first.range,
        confidence: confidenceFor(group, sites),
        related: rest.slice(0, RELATED_LIMIT).map((site) => ({
          file: site.file,
          range: site.range,
          message: relatedMessage(appRoot, site),
        })),
        evidence: [
          enabledBy === "manifest"
            ? {
                kind: "manifest",
                summary: "The resolved Nuxt config enables experimental.buildCache.",
              }
            : { kind: "ast", summary: "nuxt.config sets experimental.buildCache to true." },
          {
            kind: group.layer.srcDirFrom === "manifest" ? "manifest" : "facts",
            summary: `${group.layer.root === appRoot ? "The root layer" : `The layer at ${displayPath(appRoot, group.layer.root, true)}`} has srcDir ${srcLabel}, so the cache key covers ${srcLabel} and not ${label}.`,
          },
          ...(group.shared
            ? [
                {
                  kind: "facts" as const,
                  summary: `Installed ${version} predates nuxt/nuxt#36704, which adds shared/ to the cache key.`,
                },
              ]
            : []),
          ...sites.slice(0, RELATED_LIMIT + 1).map(
            (site): DiagnosticEvidence => ({
              kind: site.how === "import" ? "ast" : "manifest",
              file: site.file,
              range: site.range,
              summary: describeSite(appRoot, site),
            }),
          ),
        ],
      },
    );
  }
}

class InputAnalysis {
  readonly groups = new Map<string, Group>();
  private readonly parsed = new Map<string, Promise<ParsedFile | null>>();
  private readonly followed = new Set<string>();
  private readonly queue: string[] = [];

  constructor(
    private readonly ctx: RuleContext,
    private readonly nuxt: NuxtProjectInfo,
    private readonly appRoot: string,
    private readonly layers: Layer[],
    private readonly sharedUnhashed: boolean,
  ) {}

  async run() {
    const autoImports = this.autoImports();
    for (const file of this.importers()) this.enqueue(file);
    for (const plugin of this.nuxt.manifest?.pluginFiles ?? []) {
      const target = this.resolveFile(absolute(this.appRoot, plugin));
      if (!target) continue;
      this.add({ file: target, target, how: "plugin", name: target });
      this.enqueue(target);
    }
    while (this.queue.length) {
      const file = this.queue.shift()!;
      const parsed = await this.parse(file);
      if (!parsed) continue;
      await this.addImports(file, parsed);
      if (autoImports.size) this.addAutoImports(file, parsed, autoImports);
    }
  }

  private enqueue(file: string) {
    if (this.followed.has(file) || this.followed.size >= FOLLOW_LIMIT) return;
    if (!/\.(?:[cm]?[jt]sx?|vue)$/.test(file)) return;
    this.followed.add(file);
    this.queue.push(file);
  }

  private add(site: Site) {
    const found = this.classify(site.target);
    if (!found) return;
    // An unhashed file importing its own group adds noise, not evidence.
    if (site.how === "plugin" || this.classify(site.file)?.path !== found.path) {
      const group = this.groups.get(found.path) ?? { ...found, sites: [] };
      group.sites.push(site);
      this.groups.set(found.path, group);
    }
    this.enqueue(site.target);
  }

  /** Script and SFC files in each hashed srcDir that can reach the Vue build. */
  private *importers(): Generator<string> {
    for (const layer of this.layers) {
      const srcDir = layer.srcDir;
      if (!srcDir) continue;
      const files = this.ctx.fs.glob(SOURCE_GLOB, { cwd: srcDir, exclude: ["**/node_modules/**"] });
      for (const file of files.map(toPosixPath).sort()) {
        const path = relative(srcDir, file);
        if (OUTSIDE_BUILD.test(path) || path.split("/").some((part) => part.startsWith(".")))
          continue;
        if (isInside(file, layer.serverDir) || isInside(file, layer.publicDir)) continue;
        if (this.owningLayer(file) !== layer) continue;
        // Seed Nuxt conventions only; other source files must be reached through imports.
        if (!isAppPath(path)) continue;
        yield file;
      }
    }
  }

  private canFollow(target: string): boolean {
    if (this.classify(target)) return true;
    const layer = this.owningLayer(target);
    return !!(
      layer?.srcDir &&
      isInside(target, layer.srcDir) &&
      !isInside(target, layer.serverDir) &&
      !isInside(target, layer.publicDir) &&
      !relative(layer.srcDir, target)
        .split("/")
        .some((part) => part.startsWith(".") || part === "node_modules")
    );
  }

  private async addImports(file: string, parsed: ParsedFile) {
    for (const use of importUses(parsed.program)) {
      const target = this.resolveSpecifier(use.specifier, file);
      if (!target) continue;
      if (!this.canFollow(target)) continue;
      if (!(await this.loadsRuntimeCode(target, use.names))) continue;
      this.enqueue(target);
      this.add({
        file,
        range: this.range(file, parsed.text, use.node),
        target,
        how: "import",
        name: use.specifier,
      });
    }
  }

  private addAutoImports(file: string, parsed: ParsedFile, autoImports: Map<string, string>) {
    const names = [...autoImports.keys()].filter((name) => parsed.text.includes(name));
    if (!names.length || !parsed.script) return;
    const scope = analyzeScript(parsed.script.text, parsed.script.dialect);
    // Without scope analysis a local binding could shadow the name, so stay silent.
    if (!scope) return;
    const wanted = new Set(names);
    for (const reference of scope.scopeManager.globalScope?.through ?? []) {
      const name = reference.identifier.name;
      if (!wanted.has(name) || !reference.isValueReference) continue;
      this.addAutoImport(
        file,
        parsed.text,
        name,
        autoImports.get(name)!,
        reference.identifier.range,
      );
    }
    if (!parsed.template) return;
    const declared = new Set(
      (scope.scopeManager.globalScope?.childScopes ?? []).flatMap((child) =>
        child.variables.map((variable) => variable.name),
      ),
    );
    const aliases = templateAliases(parsed.template);
    walkTemplate(parsed.template, (node: any) => {
      const expression =
        node.type === TemplateNodeType.INTERPOLATION
          ? node.content
          : node.type === TemplateNodeType.DIRECTIVE
            ? node.exp
            : undefined;
      const root = expression ? parseTemplateExpression(expression) : null;
      if (!root) return;
      const locals = new Set<string>();
      walkScriptLocal(root, (child) => {
        if (FUNCTION_TYPES.has(child.type))
          for (const name of declaredNames(child)) locals.add(name);
      });
      walkScriptLocal(root, (child) => {
        if (child.type !== "Identifier" || !wanted.has(child.name) || isNonReference(child)) return;
        if (declared.has(child.name) || aliases.has(child.name) || locals.has(child.name)) return;
        this.addAutoImport(file, parsed.text, child.name, autoImports.get(child.name)!, [
          child.start,
          child.end,
        ]);
      });
    });
  }

  private addAutoImport(
    file: string,
    text: string,
    name: string,
    target: string,
    [start, end]: readonly [number, number] | number[],
  ) {
    this.enqueue(target);
    this.add({
      file,
      range: this.ctx.helpers.rangeFromOffsets(file, text, start!, end),
      target,
      how: "auto-import",
      name,
    });
  }

  /** Selected local auto-import sources, including hashed files with unhashed dependencies. */
  private autoImports(): Map<string, string> {
    const byName = new Map<string, AutoImportEntry[]>();
    for (const entry of this.nuxt.autoImportEntries ?? []) {
      if (entry.type || (entry as { disabled?: boolean }).disabled) continue;
      const name = entry.as ?? entry.name;
      byName.set(name, [...(byName.get(name) ?? []), entry]);
    }
    const found = new Map<string, string>();
    for (const [name, entries] of byName) {
      // Unimport selects the last highest-priority value; types occupy a separate space.
      const priority = Math.max(...entries.map((entry) => entry.priority ?? 1));
      const selected = entries.findLast((entry) => (entry.priority ?? 1) === priority)!;
      const target = this.autoImportTarget(selected.from);
      if (target) found.set(name, target);
    }
    return found;
  }

  private autoImportTarget(from: string): string | undefined {
    // Modules may register sources through an alias such as ~~/lib instead of a path.
    const target = isAbsolute(from)
      ? this.resolveFile(from)
      : this.resolveSpecifier(from, join(this.appRoot, "nuxt.config.ts"));
    return target && this.canFollow(target) ? target : undefined;
  }

  /**
   * The group an unhashed local file belongs to, or null when the cache key covers it or Doctor
   * cannot tell: node_modules, generated files, srcDir, serverDir and public are all skipped.
   */
  classify(file: string): Omit<Group, "sites"> | null {
    if (file.includes("/node_modules/")) return null;
    const layer = this.owningLayer(file);
    if (!layer?.srcDir) return null;
    if (this.layers.some((other) => other.srcDir && isInside(file, other.srcDir))) return null;
    if (isInside(file, layer.serverDir) || isInside(file, layer.publicDir)) return null;
    const path = relative(layer.root, file);
    if (path.split("/").some((part) => part.startsWith("."))) return null;
    if (HASHED_ROOT_FILES.has(path) || path.startsWith("nuxt.config.")) return null;
    if (isInside(file, layer.sharedDir)) {
      return this.sharedUnhashed
        ? { path: layer.sharedDir, directory: true, layer, shared: true }
        : null;
    }
    const [top, ...rest] = path.split("/");
    return rest.length
      ? { path: join(layer.root, top!), directory: true, layer, shared: false }
      : { path: file, directory: false, layer, shared: false };
  }

  private owningLayer(file: string): Layer | undefined {
    return this.layers
      .filter((layer) => isInside(file, layer.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  private resolveSpecifier(specifier: string, importer: string): string | undefined {
    const bare = specifier.split("?")[0]!;
    if (bare.startsWith("./") || bare.startsWith("../"))
      return this.resolveFile(resolve(dirname(importer), bare));
    const layer = this.owningLayer(importer);
    const aliases = this.aliasesFor(layer);
    const alias = Object.keys(aliases)
      .filter((key) => bare === key || bare.startsWith(`${key}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!alias) return;
    const base = aliases[alias]!;
    if (!isAbsolute(base)) return;
    return this.resolveFile(resolve(base, bare.slice(alias.length + 1)));
  }

  private aliasesFor(layer: Layer | undefined): Record<string, string> {
    const root = this.layers[0]!;
    const aliases: Record<string, string> = {
      "~~": this.appRoot,
      "@@": this.appRoot,
      "~": root.srcDir ?? this.appRoot,
      "@": root.srcDir ?? this.appRoot,
      "#shared": root.sharedDir,
      ...this.nuxt.manifest?.aliases,
    };
    // Nuxt 4 points a local layer's own ~ and ~~ aliases at that layer.
    if (layer && layer !== root && layer.srcDir && this.nuxt.localLayerAliases !== false) {
      Object.assign(aliases, {
        "~~": layer.root,
        "@@": layer.root,
        "~": layer.srcDir,
        "@": layer.srcDir,
      });
    }
    return Object.fromEntries(
      Object.entries(aliases).map(([key, value]) => [
        key.replace(/\/$/, ""),
        toPosixPath(value).replace(/\/$/, ""),
      ]),
    );
  }

  private resolveFile(path: string): string | undefined {
    const file = toPosixPath(path);
    const isFile = (candidate: string) => this.ctx.fs.stat(candidate)?.isFile() === true;
    if (isFile(file)) return file;
    for (const extension of RESOLVE_EXTENSIONS)
      if (isFile(file + extension)) return file + extension;
    const typescript = file.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
    if (typescript !== file && isFile(typescript)) return typescript;
    if (this.ctx.fs.stat(file)?.isDirectory()) {
      for (const extension of RESOLVE_EXTENSIONS) {
        if (isFile(`${file}/index${extension}`)) return `${file}/index${extension}`;
      }
    }
  }

  /** Whether an import of `names` from `target` puts runtime code in the bundle. */
  private async loadsRuntimeCode(target: string, names: Set<string> | null): Promise<boolean> {
    if (DECLARATION_FILE.test(target)) return false;
    if (!names) return true;
    if (!SCRIPT_FILE.test(target)) return true;
    const exports = await this.exportsOf(target);
    if (!exports || exports.opaque) return true;
    if (names.has(ALL_EXPORTS)) return exports.values.size > 0;
    return [...names].some((name) => exports.values.has(name));
  }

  private async exportsOf(
    file: string,
    visiting = new Set<string>(),
  ): Promise<ModuleExports | null> {
    if (visiting.has(file) || visiting.size >= 100) return null;
    const parsed = await this.parse(file);
    if (!parsed) return null;
    const next = new Set(visiting).add(file);
    return moduleExports(parsed.program, async (specifier) => {
      const target = this.resolveSpecifier(specifier, file);
      return target ? this.exportsOf(target, next) : null;
    });
  }

  private parse(file: string): Promise<ParsedFile | null> {
    let parsed = this.parsed.get(file);
    if (!parsed) {
      parsed = parseFile(this.ctx, file);
      this.parsed.set(file, parsed);
    }
    return parsed;
  }

  private range(file: string, text: string, node: AnyNode): SourceRange | undefined {
    if (typeof node?.start !== "number") return undefined;
    return this.ctx.helpers.rangeFromOffsets(file, text, node.start, node.end);
  }
}

async function parseFile(ctx: RuleContext, file: string): Promise<ParsedFile | null> {
  const text = ctx.fs.readText(file);
  if (text === undefined) return null;
  if (file.endsWith(".vue")) {
    const sfc = await parseSfcFile(file, text);
    const program = parseVueScripts(file, sfc.descriptor, text);
    const script = createVueScriptForParsing(sfc.descriptor, text);
    return {
      text,
      program: program ?? { type: "Program", body: [] },
      script: {
        text: script.text,
        dialect: script.lang === "jsx" || script.lang === "tsx" ? "tsx" : "ts",
      },
      template: sfc.getTemplateAst(),
    };
  }
  if (!SCRIPT_FILE.test(file)) return null;
  const program = parseScript(file, text);
  if (!program) return null;
  return { text, program, script: { text, dialect: scopeDialect(file) } };
}

function importUses(program: AnyNode): ImportUse[] {
  const uses: ImportUse[] = [];
  walkScriptLocal(program, (node) => {
    const source = node.type === "ExportNamedDeclaration" && !node.source ? null : node.source;
    const specifier = staticString(source);
    if (!specifier) return;
    if (node.type === "ImportExpression") {
      uses.push({ node: source, specifier, names: new Set([ALL_EXPORTS]) });
      return;
    }
    if (node.type === "ExportAllDeclaration") {
      if (node.exportKind !== "type")
        uses.push({ node: source, specifier, names: new Set([ALL_EXPORTS]) });
      return;
    }
    if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration") return;
    if ((node.importKind ?? node.exportKind) === "type") return;
    const specifiers: AnyNode[] = node.specifiers ?? [];
    if (!specifiers.length) {
      uses.push({ node: source, specifier, names: null });
      return;
    }
    const names = new Set<string>();
    for (const item of specifiers) {
      if ((item.importKind ?? item.exportKind) === "type") continue;
      if (item.type === "ImportDefaultSpecifier") names.add("default");
      else if (item.type === "ImportNamespaceSpecifier") names.add(ALL_EXPORTS);
      else {
        const name = moduleName(item.type === "ImportSpecifier" ? item.imported : item.local);
        if (name) names.add(name);
      }
    }
    if (names.size) uses.push({ node: source, specifier, names });
  });
  return uses;
}

interface ModuleExports {
  values: Set<string>;
  /** `export *` or a re-export whose kind Doctor did not resolve. */
  opaque: boolean;
}

const TYPE_DECLARATIONS = new Set(["TSTypeAliasDeclaration", "TSInterfaceDeclaration"]);

async function moduleExports(
  program: AnyNode,
  resolveExports: (specifier: string) => Promise<ModuleExports | null>,
): Promise<ModuleExports> {
  const types = new Set<string>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration && isTypeDeclaration(declaration) && declaration.id?.name)
      types.add(declaration.id.name);
    if (statement.type === "ImportDeclaration") {
      for (const item of statement.specifiers ?? []) {
        if ((statement.importKind === "type" || item.importKind === "type") && item.local?.name)
          types.add(item.local.name);
      }
    }
  }
  const values = new Set<string>();
  let opaque = false;
  for (const statement of program.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = unwrap(statement.declaration);
      if (declaration?.type === "TSInterfaceDeclaration") continue;
      if (declaration?.type === "Identifier" && types.has(declaration.name)) continue;
      values.add("default");
    } else if (statement.type === "TSExportAssignment") {
      values.add("default");
    } else if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") continue;
      const source = await resolveExports(statement.source.value);
      if (!source || source.opaque) opaque = true;
      const namespace = moduleName(statement.exported);
      if (namespace && source?.values.size) values.add(namespace);
      if (!namespace)
        for (const name of source?.values ?? []) {
          if (name !== "default") values.add(name);
        }
    } else if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
      const declaration = statement.declaration;
      if (declaration) {
        if (!isTypeDeclaration(declaration))
          for (const name of declaredValueNames(declaration)) values.add(name);
        continue;
      }
      for (const item of statement.specifiers ?? []) {
        if (item.exportKind === "type") continue;
        if (!statement.source && types.has(moduleName(item.local)!)) continue;
        const name = moduleName(item.exported);
        if (!name) continue;
        if (statement.source) {
          const source = await resolveExports(statement.source.value);
          if (!source || source.opaque) opaque = true;
          if (!source?.values.has(moduleName(item.local)!)) continue;
        }
        values.add(name);
      }
    }
  }
  return { values, opaque };
}

function isTypeDeclaration(node: AnyNode): boolean {
  return TYPE_DECLARATIONS.has(node.type) || node.declare === true;
}

function declaredValueNames(declaration: AnyNode): string[] {
  if (declaration.type !== "VariableDeclaration") {
    return declaration.id?.name ? [declaration.id.name] : [];
  }
  const names: string[] = [];
  for (const declarator of declaration.declarations ?? []) {
    walkScriptLocal(declarator.id, (node) => {
      if (node.type === "Identifier" && !isNonReference(node)) names.push(node.name);
    });
  }
  return names;
}

/** Names bound by v-for and v-slot, which can shadow an auto-import inside their element. */
function templateAliases(template: TemplateRootNode): Set<string> {
  const names = new Set<string>();
  walkTemplate(template, (node: any) => {
    if (node.type !== TemplateNodeType.DIRECTIVE) return;
    const sources =
      node.name === "for"
        ? [node.forParseResult?.value, node.forParseResult?.key, node.forParseResult?.index]
        : node.name === "slot"
          ? [node.exp]
          : [];
    for (const source of sources) {
      for (const match of String(source?.content ?? "").matchAll(/[A-Za-z_$][\w$]*/g))
        names.add(match[0]);
    }
  });
  return names;
}

function readConfig(ctx: RuleContext, root: string) {
  for (const name of CONFIG_FILES) {
    const file = join(root, name);
    const text = ctx.fs.readText(file);
    if (text === undefined) continue;
    const program = parseScript(file, text);
    if (!program) return null;
    const bindings = topLevelBindings(program);
    return { object: exportedConfigObject(program, bindings), bindings };
  }
  return null;
}

type NuxtConfigAst = NonNullable<ReturnType<typeof readConfig>>;

/**
 * The local layers getVueHash walks. Layers under node_modules are skipped, as Nuxt does. Without
 * a manifest only a literal nuxt.config layout is trusted; anything computed returns null.
 */
function localLayers(
  ctx: RuleContext,
  project: ProjectInfo,
  nuxt: NuxtProjectInfo,
  appRoot: string,
  config: NuxtConfigAst | null,
): Layer[] | null {
  if (nuxt.manifest?.hasManifest) {
    return nuxt.layers
      .toSorted((a, b) => a.priority - b.priority)
      .map((layer) => {
        const root = absolute(appRoot, layer.root);
        const srcDir = layer.srcDir
          ? absolute(appRoot, layer.srcDir)
          : root === appRoot
            ? toPosixPath(nuxt.appDir)
            : inferSrcDir(ctx, project, root);
        return {
          root,
          srcDir,
          srcDirFrom: layer.srcDir || root === appRoot ? "manifest" : "layout",
          serverDir: absolute(appRoot, layer.serverDir ?? join(root, "server")),
          publicDir: absolute(appRoot, layer.publicDir ?? join(root, "public")),
          sharedDir: absolute(appRoot, layer.sharedDir ?? join(root, "shared")),
        } satisfies Layer;
      })
      .filter((layer) => !layer.root.includes("/node_modules/"));
  }
  const options = config?.object;
  if (!options) return null;
  const bindings = config.bindings;
  const srcDir = literalOption(options, "srcDir", bindings);
  const serverDir = literalOption(options, "serverDir", bindings);
  const dir = propertyValue(options, "dir");
  const dirs = dir ? objectExpression(dir, bindings) : undefined;
  if (dir && !dirs) return null;
  const sharedDir = dirs ? literalOption(dirs, "shared", bindings) : undefined;
  const publicDir = dirs ? literalOption(dirs, "public", bindings) : undefined;
  if ([srcDir, serverDir, sharedDir, publicDir].includes(null)) return null;
  const extended = extendedLayerRoots(options, bindings, appRoot);
  if (!extended) return null;
  const autoRegistered = (ctx.fs.readDir(join(appRoot, "layers")) ?? [])
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appRoot, "layers", entry.name));
  return [
    {
      root: appRoot,
      srcDir: srcDir ? absolute(appRoot, srcDir) : inferSrcDir(ctx, project, appRoot),
      srcDirFrom: srcDir ? "config" : "layout",
      serverDir: absolute(appRoot, serverDir ?? "server"),
      publicDir: absolute(appRoot, publicDir ?? "public"),
      sharedDir: absolute(appRoot, sharedDir ?? "shared"),
    },
    // Their srcDir is unknown without the manifest, so their files are neither scanned nor reported.
    ...[...extended, ...autoRegistered].map(
      (root): Layer => ({
        root,
        srcDirFrom: "layout",
        serverDir: join(root, "server"),
        publicDir: join(root, "public"),
        sharedDir: join(root, "shared"),
      }),
    ),
  ];
}

/** A string option's value, undefined when unset, or null when Doctor cannot read it. */
function literalOption(
  object: AnyNode,
  name: string,
  bindings: Map<string, AnyNode>,
): string | null | undefined {
  const value = propertyValue(object, name);
  if (!value) return undefined;
  const literal = unwrap(value);
  if (literal?.type === "Literal" && typeof literal.value === "string") return literal.value;
  const bound = literal?.type === "Identifier" ? unwrap(bindings.get(literal.name)) : null;
  return bound?.type === "Literal" && typeof bound.value === "string" ? bound.value : null;
}

function extendedLayerRoots(
  options: AnyNode,
  bindings: Map<string, AnyNode>,
  appRoot: string,
): string[] | null {
  const value = unwrap(propertyValue(options, "extends"));
  if (!value) return [];
  const entries = value.type === "ArrayExpression" ? value.elements : [value];
  const roots: string[] = [];
  for (const entry of entries) {
    const item = unwrap(entry);
    const source = item?.type === "ArrayExpression" ? unwrap(item.elements?.[0]) : item;
    if (source?.type !== "Literal" || typeof source.value !== "string") return null;
    if (source.value.startsWith(".")) roots.push(absolute(appRoot, source.value));
    else if (!/^[\w@]/.test(source.value)) return null;
  }
  return roots;
}

/** Nuxt 4 resolves srcDir to app/ when it has files; Nuxt 3 keeps it at the root. */
function inferSrcDir(ctx: RuleContext, project: ProjectInfo, root: string): string | undefined {
  const compatibility = project.nuxtCompatibility;
  if (compatibility?.state !== "resolved" || compatibility.version === undefined) return undefined;
  if (compatibility.version < 4) return root;
  const app = join(root, "app");
  const entries = ctx.fs.readDir(app);
  const files = (entries ?? []).filter(
    (entry) =>
      entry.name !== "spa-loading-template.html" && !entry.name.startsWith("router.options"),
  );
  return files.length ? app : root;
}

function primaryLayerRoot(nuxt: NuxtProjectInfo): string | undefined {
  return nuxt.layers.toSorted((a, b) => a.priority - b.priority)[0]?.root;
}

function isAppPath(path: string): boolean {
  const [top, ...rest] = path.split("/");
  if (rest.length) {
    if (!NUXT_APP_DIRS.has(top!)) return false;
    if (["plugins", "composables", "utils", "middleware"].includes(top!)) return rest.length === 1;
    return path.endsWith(".vue");
  }
  return /^(?:app|error)\.vue$|^app\.config\.[cm]?[jt]s$/.test(path);
}

function staticString(node: AnyNode): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked ?? undefined;
}

function moduleName(node: AnyNode): string | undefined {
  return node?.type === "Identifier"
    ? node.name
    : typeof node?.value === "string"
      ? node.value
      : undefined;
}

function confidenceFor(group: Group, sites: Site[]): Confidence {
  if (group.layer.srcDirFrom === "layout") return "heuristic-high";
  return sites.some((site) => site.how === "import") ? "proven" : "manifest-backed";
}

function describeSite(appRoot: string, site: Site): string {
  const file = displayPath(appRoot, site.file);
  const at = site.range ? `${file}:${site.range.line}` : file;
  if (site.how === "plugin") return `Nuxt registers ${file} as a plugin of the Vue app`;
  if (site.how === "auto-import")
    return `${at} uses the auto-imported ${site.name} from ${displayPath(appRoot, site.target)}`;
  return `${at} imports ${site.name}`;
}

function relatedMessage(appRoot: string, site: Site): string {
  if (site.how === "plugin") return "Registered as a Vue app plugin";
  if (site.how === "auto-import")
    return `Uses the auto-imported ${site.name} from ${displayPath(appRoot, site.target)}`;
  return `Imports ${site.name}`;
}

function fixFor(label: string, srcLabel: string, shared: boolean): string {
  const cacheKey = `add ${label} to the CI cache key of node_modules/.cache/nuxt/builds (for example with hashFiles('${label}${label.endsWith("/") ? "**" : ""}'))`;
  if (shared) {
    return `Upgrade to a Nuxt release that includes nuxt/nuxt#36704 once one ships. Until then, ${cacheKey}, or turn off experimental.buildCache.`;
  }
  return `Move the code the app uses under ${srcLabel}, ${cacheKey}, or turn off experimental.buildCache.`;
}

function displayPath(appRoot: string, path: string, directory = false): string {
  const relativePath = relative(appRoot, path) || ".";
  return directory ? `${relativePath}/` : relativePath;
}

function absolute(root: string, path: string): string {
  return toPosixPath(isAbsolute(path) ? path : resolve(root, path));
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}
