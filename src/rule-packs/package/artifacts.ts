import { isBuiltin } from "node:module";
import { basename } from "node:path";
import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "pathe";
import { parseSync } from "oxc-parser";
import type { ProjectInfo, SourceRange } from "../../core/primitives.js";

export interface PackageManifest {
  name?: string;
  type?: string;
  private?: boolean;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  types?: string;
  typings?: string;
  exports?: unknown;
  imports?: Record<string, unknown>;
  bin?: string | string[] | Record<string, string>;
  typesVersions?: Record<string, Record<string, string[]>>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
}

export interface PackageReference {
  specifier: string;
  packageName: string;
  typeReference: boolean;
  kind: "runtime" | "types";
  required: boolean;
  file: string;
  range: SourceRange;
}

export interface PackageArtifacts {
  manifest: PackageManifest;
  references: PackageReference[];
  missing: string[];
}

interface ImportEdge {
  specifier: string;
  start: number;
  end: number;
  kind: "runtime" | "types";
  required: boolean;
  typeReference?: boolean;
  probe?: boolean | "commonjs";
  resolutionOnly?: boolean;
}

const runs = new WeakMap<ProjectInfo, PackageArtifacts | null>();
const scriptExtension = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const declarationExtension = /\.d\.[cm]?ts$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function recordOf(value: unknown, accepts: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(accepts);
}

function parsePackageManifest(value: unknown): PackageManifest {
  if (!isRecord(value)) throw new TypeError("package.json must contain an object");
  const fields: Record<string, (entry: unknown) => boolean> = {
    name: isString,
    type: isString,
    private: (entry) => typeof entry === "boolean",
    main: isString,
    module: isString,
    browser: (entry) =>
      isString(entry) || recordOf(entry, (target) => isString(target) || target === false),
    types: isString,
    typings: isString,
    imports: isRecord,
    bin: (entry) =>
      isString(entry) ||
      (Array.isArray(entry) && entry.every(isString)) ||
      recordOf(entry, isString),
    typesVersions: (entry) =>
      recordOf(entry, (version) =>
        recordOf(version, (targets) => Array.isArray(targets) && targets.every(isString)),
      ),
    dependencies: (entry) => recordOf(entry, isString),
    optionalDependencies: (entry) => recordOf(entry, isString),
    peerDependencies: (entry) => recordOf(entry, isString),
    peerDependenciesMeta: (entry) =>
      recordOf(
        entry,
        (meta) =>
          isRecord(meta) && (meta.optional === undefined || typeof meta.optional === "boolean"),
      ),
    devDependencies: (entry) => recordOf(entry, isString),
  };
  for (const [field, accepts] of Object.entries(fields)) {
    if (value[field] !== undefined && !accepts(value[field]))
      throw new TypeError(`Invalid package.json field: ${field}`);
  }
  return value;
}

export function packageArtifacts(project: ProjectInfo): PackageArtifacts | null {
  if (runs.has(project)) return runs.get(project)!;
  const inventory = readPackageArtifacts(project.root);
  runs.set(project, inventory);
  if (inventory) project.inventory = { ...project.inventory, packageArtifacts: inventory };
  if (inventory?.missing.length) {
    project.evidenceGaps = [
      ...(project.evidenceGaps ?? []),
      {
        source: "vite-doctor/package",
        message:
          "Build the package before running package rules; some referenced artifacts are missing.",
        files: inventory.missing,
      },
    ];
  }
  return inventory;
}

export function readPackageArtifacts(root: string): PackageArtifacts | null {
  const active = readPackageArtifactsForMode(root, true);
  if (!active) return null;
  const inactive = readPackageArtifactsForMode(root, false)!;
  const requiredInActive = new Set(
    active.references
      .filter((reference) => reference.required)
      .map((reference) => reference.packageName),
  );
  const requiredInBoth = new Set(
    inactive.references
      .filter((reference) => reference.required && requiredInActive.has(reference.packageName))
      .map((reference) => reference.packageName),
  );
  const references = new Map<string, PackageReference>();
  for (const reference of [...active.references, ...inactive.references]) {
    const key = `${reference.file}:${reference.range.start}:${reference.specifier}:${reference.kind}`;
    const previous = references.get(key);
    references.set(key, {
      ...reference,
      required:
        (reference.required || previous?.required === true) &&
        requiredInBoth.has(reference.packageName),
    });
  }
  return {
    manifest: active.manifest,
    references: [...references.values()],
    missing: [...new Set([...active.missing, ...inactive.missing])],
  };
}

function readPackageArtifactsForMode(root: string, addons: boolean): PackageArtifacts | null {
  root = realpathSync(root);
  const manifestPath = resolve(root, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = parsePackageManifest(JSON.parse(manifestText));
  if (manifest.private) return null;
  const references: PackageReference[] = [];
  const missing = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ path: string; kind: "runtime" | "types"; required: boolean }> = [];
  const rootPath = realpathSync(root);

  function inside(path: string) {
    const rel = relative(rootPath, path);
    return (
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith("../") &&
      !rel.split("/").includes("node_modules")
    );
  }

  function commonjsModule(path: string): boolean {
    if (/\.c(?:js|ts)$/.test(path)) return true;
    if (/\.m(?:js|ts)$/.test(path)) return false;
    for (let directory = dirname(path); inside(directory); directory = dirname(directory)) {
      const manifestPath = resolve(directory, "package.json");
      if (existsSync(manifestPath))
        return JSON.parse(readFileSync(manifestPath, "utf8")).type !== "module";
      if (directory === rootPath) break;
    }
    return true;
  }

  function explicitCommonjsModule(path: string): boolean {
    if (/\.c(?:js|ts)$/.test(path)) return true;
    for (let directory = dirname(path); inside(directory); directory = dirname(directory)) {
      const manifestPath = resolve(directory, "package.json");
      if (existsSync(manifestPath))
        return JSON.parse(readFileSync(manifestPath, "utf8")).type === "commonjs";
      if (directory === rootPath) break;
    }
    return false;
  }

  function packageScope(path: string): { directory: string; manifest: PackageManifest } {
    for (let directory = dirname(path); inside(directory); directory = dirname(directory)) {
      const scopedManifest = resolve(directory, "package.json");
      if (existsSync(scopedManifest))
        return {
          directory,
          manifest:
            directory === rootPath
              ? manifest
              : parsePackageManifest(JSON.parse(readFileSync(scopedManifest, "utf8"))),
        };
      if (directory === rootPath) break;
    }
    return { directory: rootPath, manifest };
  }

  function commonjsFile(path: string): string | undefined {
    const suffixes = ["", ".js", ".json", ".node"];
    const findFile = (paths: string[]) =>
      paths.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    const file = findFile(suffixes.map((suffix) => path + suffix));
    if (file) return file;
    if (!existsSync(path) || !statSync(path).isDirectory() || !inside(realpathSync(path))) return;
    const manifestPath = resolve(path, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (isRecord(manifest) && typeof manifest.main === "string" && manifest.main) {
        const main = resolve(path, manifest.main);
        if (!inside(main)) return;
        const entry = findFile([
          ...suffixes.map((suffix) => main + suffix),
          ...suffixes.slice(1).map((suffix) => resolve(main, "index" + suffix)),
        ]);
        if (entry) return entry;
      }
    }
    return findFile(suffixes.slice(1).map((suffix) => resolve(path, "index" + suffix)));
  }

  function enqueue(
    target: string,
    kind: "runtime" | "types",
    required: boolean,
    from = root,
    probe: boolean | "main" | "commonjs" = true,
    adjacentDeclaration = false,
    sourceResolution = false,
  ) {
    const path = resolve(from, target);
    if (!inside(path)) return;
    if (target.includes("*")) {
      const matches = globSync(path.replace("*", "**/*")).filter((match) =>
        statSync(match).isFile(),
      );
      if (!matches.length) missing.add(relative(root, path));
      for (const match of matches) enqueue(match, kind, required);
      return;
    }
    const candidates = probe
      ? kind === "types"
        ? typeCandidates(path)
        : probe === "main" || (probe === "commonjs" && !sourceResolution)
          ? [
              commonjsFile(path),
              ...(probe === "main" && manifest.exports == null
                ? [".js", ".json", ".node"].map((suffix) => resolve(root, `index${suffix}`))
                : []),
            ].filter((file): file is string => file !== undefined)
          : [
              ...(sourceResolution ? sourceCandidates(path) : []),
              path,
              ...[
                ...(sourceResolution ? [".ts", ".tsx"] : []),
                ".js",
                ".mjs",
                ".cjs",
                ".jsx",
                ...(sourceResolution ? ["/index.ts", "/index.tsx"] : []),
                "/index.js",
                "/index.mjs",
                "/index.cjs",
                "/index.jsx",
              ].map((ext) => path + ext),
            ]
      : [path];
    const file = candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (!file) {
      missing.add(relative(root, path));
      return;
    }
    if (!inside(realpathSync(file)) || !scriptExtension.test(file)) return;
    const resolvedKind = declarationExtension.test(file) ? "types" : kind;
    queue.push({
      path: file,
      kind: resolvedKind,
      required: required && resolvedKind === "runtime",
    });
    if (resolvedKind === "runtime") {
      const declaration = typeCandidates(file).find(
        (candidate) => declarationExtension.test(candidate) && existsSync(candidate),
      );
      if (adjacentDeclaration && declaration)
        queue.push({ path: declaration, kind: "types", required: false });
    }
  }

  function targets(
    value: unknown,
    kind: "runtime" | "types" = "runtime",
    mode: "import" | "require" = "import",
    addons = true,
  ): string[] | "blocked" | undefined {
    if (typeof value === "string") {
      if (!validExportTarget(value, root) || !inside(resolve(root, value))) return "blocked";
      return [value];
    }
    if (value === null) return "blocked";
    if (Array.isArray(value)) {
      let blocked = value.length === 0;
      for (const item of value) {
        const result = targets(item, kind, mode, addons);
        if (Array.isArray(result)) return result;
        if (result === "blocked") blocked = true;
      }
      return blocked ? "blocked" : undefined;
    }
    if (value && typeof value === "object") {
      if (kind === "runtime")
        for (const [condition, item] of Object.entries(value))
          if (condition === "types" || condition.startsWith("types@")) {
            const declarations = targets(item, "types", mode, addons);
            if (Array.isArray(declarations))
              for (const declaration of declarations)
                enqueue(declaration, "types", false, root, false, true);
          }
      for (const [condition, item] of Object.entries(value)) {
        if (
          condition !== "default" &&
          condition !== "node" &&
          !(addons && condition === "node-addons") &&
          condition !== mode
        )
          continue;
        const resolved = targets(item, kind, mode, addons);
        if (resolved) return resolved;
      }
    }
    return undefined;
  }

  function addTargets(value: unknown, required: boolean, mode: "import" | "require") {
    const selected = targets(value, "runtime", mode, addons);
    if (Array.isArray(selected))
      for (const target of selected) enqueue(target, "runtime", required, root, false, true);
  }

  if (manifest.exports != null) {
    const exports = manifest.exports;
    if (
      exports &&
      typeof exports === "object" &&
      !Array.isArray(exports) &&
      Object.keys(exports).some((key) => key.startsWith("."))
    ) {
      for (const [subpath, value] of Object.entries(exports)) {
        addTargets(value, subpath === ".", "import");
        addTargets(value, subpath === ".", "require");
      }
    } else {
      addTargets(exports, true, "import");
      addTargets(exports, true, "require");
    }
  } else if (!manifest.main && !manifest.module) {
    if (existsSync(resolve(root, "index.js"))) enqueue("index.js", "runtime", true);
  }
  if (manifest.main) enqueue(manifest.main, "runtime", true, root, "main", true);
  if (manifest.module) enqueue(manifest.module, "runtime", true, root, true, true);
  if (typeof manifest.browser === "string")
    enqueue(manifest.browser, "runtime", true, root, false, true);
  else if (manifest.browser) {
    for (const entry of Object.values(manifest.browser))
      if (entry && entry.startsWith(".")) enqueue(entry, "runtime", false, root, false, true);
  }
  for (const entry of [manifest.types, manifest.typings])
    if (entry) enqueue(entry, "types", false, root, false);
  const bin = Array.isArray(manifest.bin)
    ? Object.fromEntries(manifest.bin.map((entry) => [basename(entry), entry]))
    : manifest.bin;
  if (typeof bin === "string") enqueue(bin, "runtime", false, root, false, true);
  else if (bin)
    for (const entry of Object.values(bin)) enqueue(entry, "runtime", false, root, false, true);
  for (const version of Object.values(manifest.typesVersions ?? {}))
    for (const entries of Object.values(version))
      for (const entry of entries) enqueue(entry, "types", false, root, false);

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const key = `${current.path}:${current.kind}:${current.required}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (current.required && manifest.browser && typeof manifest.browser === "object") {
      for (const [original, replacement] of Object.entries(manifest.browser)) {
        if (!replacement || resolve(root, original) !== current.path) continue;
        if (replacement.startsWith(".")) {
          enqueue(replacement, "runtime", true, root, false, true);
          continue;
        }
        const packageName = externalPackageName(replacement);
        if (!packageName) continue;
        const keyOffset = manifestText.indexOf(JSON.stringify(original));
        const offset = manifestText.indexOf(JSON.stringify(replacement), keyOffset);
        const start = offset < 0 ? 0 : offset;
        const before = manifestText.slice(0, start);
        references.push({
          specifier: replacement,
          packageName,
          typeReference: false,
          kind: "runtime",
          required: true,
          file: manifestPath,
          range: {
            start,
            end: start + JSON.stringify(replacement).length,
            line: before.split("\n").length,
            column: start - before.lastIndexOf("\n"),
          },
        });
      }
    }
    const text = readFileSync(current.path, "utf8");
    const parsed = parseModule(current.path, text);
    const commonjs =
      commonjsModule(current.path) &&
      (explicitCommonjsModule(current.path) || !hasRuntimeModuleSyntax(parsed.program));
    const scope = packageScope(current.path);
    for (const edge of importEdges(
      parsed,
      current.kind,
      commonjs,
      explicitCommonjsModule(current.path),
    )) {
      const required = current.required && edge.required;
      const executionRequired = required && !edge.resolutionOnly;
      for (const { specifier, kind, required: selectedRequired } of resolvePackageImport(
        edge.specifier,
        scope.manifest.imports,
        edge.kind,
        edge.probe === "commonjs" ? "require" : "import",
        new Set(),
        undefined,
        scope.directory,
        addons,
      )) {
        if (specifier.startsWith(".")) {
          enqueue(
            specifier,
            kind,
            executionRequired && selectedRequired && kind === "runtime",
            edge.specifier.startsWith("#") ? scope.directory : dirname(current.path),
            edge.specifier.startsWith("#")
              ? false
              : edge.probe || kind === "types" || /\.(?:[cm]?ts|tsx|jsx)$/.test(current.path),
            false,
            /\.(?:[cm]?ts|tsx)$/.test(current.path),
          );
          continue;
        }
        const packageName = edge.typeReference ? specifier : externalPackageName(specifier);
        if (!packageName) continue;
        if (packageName === scope.manifest.name) {
          const exports = scope.manifest.exports;
          const entries =
            exports &&
            typeof exports === "object" &&
            !Array.isArray(exports) &&
            Object.keys(exports).some((key) => key.startsWith("."))
              ? exports
              : { ".": exports ?? scope.manifest.main };
          const aliases = Object.fromEntries(
            Object.entries(entries).map(([key, value]) => [`#self${key.slice(1)}`, value]),
          );
          for (const target of resolvePackageImport(
            `#self${specifier.slice(packageName.length)}`,
            aliases,
            kind,
            edge.probe === "commonjs" ? "require" : "import",
            new Set(),
            scope.directory,
            undefined,
            addons,
          )) {
            if (target.specifier.startsWith("."))
              enqueue(
                target.specifier,
                target.kind,
                executionRequired &&
                  selectedRequired &&
                  target.required &&
                  target.kind === "runtime",
                scope.directory,
                exports === undefined ? "main" : false,
              );
          }
          continue;
        }
        const position = positionOf(parsed, edge.start);
        references.push({
          specifier,
          packageName,
          typeReference: edge.typeReference ?? false,
          kind,
          required: required && selectedRequired && kind === "runtime",
          file: current.path,
          range: {
            start: edge.start,
            end: edge.end,
            line: position.line + 1,
            column: position.character + 1,
          },
        });
      }
    }
  }
  const unique = new Map<string, PackageReference>();
  for (const reference of references) {
    const key = `${reference.file}:${reference.range.start}:${reference.packageName}:${reference.kind}`;
    const previous = unique.get(key);
    unique.set(key, { ...reference, required: reference.required || Boolean(previous?.required) });
  }
  return { manifest, references: [...unique.values()], missing: [...missing] };
}

function typeCandidates(path: string) {
  const stem = path.replace(/\.(?:[cm]?js|jsx)$/, "");
  const declarations = path.endsWith(".mjs")
    ? [stem + ".d.mts"]
    : path.endsWith(".cjs")
      ? [stem + ".d.cts"]
      : [stem + ".d.ts"];
  return [
    ...declarations,
    path,
    ...[".d.ts", ".d.mts", ".d.cts", "/index.d.ts", "/index.d.mts", "/index.d.cts"].map(
      (ext) => path + ext,
    ),
  ];
}

function sourceCandidates(path: string): string[] {
  if (path.endsWith(".jsx")) return [path.replace(/\.jsx$/, ".tsx"), path.replace(/\.jsx$/, ".ts")];
  if (path.endsWith(".js")) return [path.replace(/\.js$/, ".ts"), path.replace(/\.js$/, ".tsx")];
  if (/\.[cm]js$/.test(path)) return [path.replace(/js$/, "ts")];
  return [];
}

function externalPackageName(specifier: string): string | null {
  if (!specifier || isBuiltin(specifier) || /^(?:[.#/]|[a-zA-Z][\w+.-]*:)/.test(specifier))
    return null;
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
}

function validExportTarget(value: string, root: string): boolean {
  return (
    value.startsWith("./") &&
    !value
      .slice(2)
      .split(/[\\/]/)
      .some((segment) => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          return true;
        }
        return /^(\.|\.\.|node_modules)$/i.test(decoded) || /[\\/]/.test(decoded);
      }) &&
    !relative(root, resolve(root, value)).startsWith("../")
  );
}

type ResolvedPackageImport = {
  specifier: string;
  kind: PackageReference["kind"];
  required: boolean;
};

function resolvePackageImport(
  specifier: string,
  imports: PackageManifest["imports"],
  kind: PackageReference["kind"],
  mode: "import" | "require",
  seen = new Set<string>(),
  selfRoot?: string,
  importsRoot?: string,
  addons = true,
): ResolvedPackageImport[] {
  if (!specifier.startsWith("#")) return [{ specifier, kind, required: true }];
  if (seen.has(specifier)) return [];
  seen.add(specifier);
  const entries = Object.entries(imports ?? {}).sort(
    ([a], [b]) =>
      b.replace(/\*.*/, "").length - a.replace(/\*.*/, "").length || b.length - a.length,
  );
  const match =
    entries.find(([key]) => key === specifier) ??
    entries.find(
      ([key]) =>
        key.includes("*") &&
        specifier.startsWith(key.split("*")[0]!) &&
        specifier.endsWith(key.split("*")[1]!),
    );
  if (!match) return [];
  const [key, target] = match;
  const wildcard = key.includes("*")
    ? specifier.slice(key.indexOf("*"), specifier.length - (key.length - key.indexOf("*") - 1))
    : "";
  function flatten(
    value: unknown,
    targetKind = kind,
    addons = true,
  ): ResolvedPackageImport[] | undefined {
    if (value === null) return [];
    if (typeof value === "string") {
      if (key.includes("*") && !validExportTarget(`./${wildcard}`, selfRoot ?? importsRoot ?? ""))
        return [];
      const substituted = value.replaceAll("*", wildcard);
      if (selfRoot && !validExportTarget(substituted, selfRoot)) return [];
      if (importsRoot && value.startsWith(".") && !validExportTarget(substituted, importsRoot))
        return [];
      return resolvePackageImport(
        substituted,
        imports,
        targetKind,
        mode,
        new Set(seen),
        selfRoot,
        importsRoot,
        addons,
      );
    }
    if (Array.isArray(value)) {
      let selected: ReturnType<typeof flatten> = value.length ? undefined : [];
      for (const entry of value) {
        const targets = flatten(entry, targetKind, addons);
        if (targets?.length) return targets;
        if (targets !== undefined) selected = targets;
      }
      return selected;
    }
    if (isRecord(value)) return flattenConditions(value, targetKind, addons);
    return undefined;
  }
  function flattenConditions(
    value: Record<string, unknown>,
    targetKind: PackageReference["kind"],
    addons: boolean,
  ): ResolvedPackageImport[] | undefined {
    for (const [condition, entry] of Object.entries(value)) {
      const types = condition === "types" || condition.startsWith("types@");
      if (
        condition !== "default" &&
        condition !== "node" &&
        !(addons && condition === "node-addons") &&
        condition !== mode &&
        !(types && targetKind === "types")
      )
        continue;
      const targets = flatten(entry, types ? "types" : targetKind, addons);
      if (targets !== undefined) return targets;
    }
    return undefined;
  }
  return flatten(target, kind, addons) ?? [];
}

// oxc ESTree node, linked to its parent with TypeScript-shaped ancestry (see linkParents).
type Node = any;

interface ParsedModule {
  program: Node;
  text: string;
  comments: Array<{ type: string; start: number; end: number }>;
  lineStarts?: number[];
}

interface FileReference {
  fileName: string;
  pos: number;
  end: number;
}

const wrapperTypes = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);
const signatureTypes = new Set([
  "TSMethodSignature",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSFunctionType",
  "TSConstructorType",
  "TSIndexSignature",
]);
const propertyDeclarationTypes = new Set([
  "PropertyDefinition",
  "AccessorProperty",
  "TSAbstractPropertyDefinition",
  "TSAbstractAccessorProperty",
]);
const exportedDeclarationTypes = new Set([
  "FunctionDeclaration",
  "TSDeclareFunction",
  "ClassDeclaration",
  "TSInterfaceDeclaration",
]);

function parseModule(path: string, text: string): ParsedModule {
  const lang = declarationExtension.test(path)
    ? "dts"
    : path.endsWith(".tsx")
      ? "tsx"
      : /\.[cm]?ts$/.test(path)
        ? "ts"
        : "jsx";
  let source = text;
  for (let attempt = 0; ; attempt++) {
    // oxc keeps the full AST next to recoverable errors, so CommonJS-only syntax such as a
    // top-level return still yields every import edge when parsed in module mode.
    const result = parseSync(path, source, {
      lang,
      sourceType: "module",
      astType: "ts",
      preserveParens: true,
    });
    const offset = result.errors[0]?.labels[0]?.start;
    // Unrecoverable errors discard the whole program, while TypeScript recovers around the
    // broken statement (for example malformed declaration emit), so blank the failing line
    // without shifting offsets and parse again.
    if (result.program.body.length || offset === undefined || attempt === 16) {
      linkParents(result.program);
      return { program: result.program, text, comments: result.comments };
    }
    source = blankLine(source, offset);
  }
}

function blankLine(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && !isLineBreak(source.charCodeAt(start - 1))) start--;
  let end = offset;
  while (end < source.length && !isLineBreak(source.charCodeAt(end))) end++;
  return source.slice(0, start) + " ".repeat(end - start) + source.slice(end);
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && typeof (value as Node).type === "string";
}

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const key in node) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    } else if (isNode(value)) children.push(value);
  }
  return children;
}

// The reachability checks below mirror TypeScript's AST, which has no node for optional chains
// or for the export wrapper around declarations.
function linkParents(program: Node): void {
  const stack: Array<[Node, Node]> = [[program, undefined]];
  while (stack.length) {
    const [node, parent] = stack.pop()!;
    node.parent = parent;
    for (const key in node) {
      if (key === "parent") continue;
      const value = node[key];
      const childParent =
        key === "declaration" &&
        (node.type === "ExportNamedDeclaration" ||
          (node.type === "ExportDefaultDeclaration" && exportedDeclarationTypes.has(value?.type)))
          ? parent
          : node;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++)
          if (isNode(value[index]))
            stack.push([(value[index] = unchain(value[index])), childParent]);
      } else if (isNode(value)) stack.push([(node[key] = unchain(value)), childParent]);
    }
  }
}

function unchain(node: Node): Node {
  return node.type === "ChainExpression" ? node.expression : node;
}

function walk(root: Node, enter: (node: Node) => boolean | void): void {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (enter(node) === false) continue;
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
}

function unwrapParens(node: Node): Node {
  while (node?.type === "ParenthesizedExpression") node = node.expression;
  return node;
}

function isWithin(node: Node, ancestor: Node): boolean {
  if (!ancestor) return false;
  for (let current = node; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

function isFunctionLike(node: Node): boolean {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "TSDeclareFunction" ||
    node?.type === "TSEmptyBodyFunctionExpression" ||
    signatureTypes.has(node?.type)
  );
}

// ESTree wraps methods, accessors and constructors around a FunctionExpression; TypeScript
// treats those as method declarations, not function expressions.
function isFunctionExpression(node: Node): boolean {
  if (node?.type !== "FunctionExpression") return false;
  const parent = node.parent;
  if (parent?.type === "MethodDefinition" || parent?.type === "TSAbstractMethodDefinition")
    return parent.value !== node;
  return !(
    parent?.type === "Property" &&
    parent.value === node &&
    (parent.method || parent.kind !== "init")
  );
}

function isConstructor(node: Node): boolean {
  return (
    node?.type === "FunctionExpression" &&
    node.parent?.type === "MethodDefinition" &&
    node.parent.kind === "constructor"
  );
}

function isClass(node: Node): boolean {
  return node?.type === "ClassDeclaration" || node?.type === "ClassExpression";
}

function hasHeritage(node: Node): boolean {
  return Boolean(node.superClass) || (node.implements?.length ?? 0) > 0;
}

function isPropertyDeclaration(node: Node): boolean {
  return propertyDeclarationTypes.has(node?.type);
}

function isPropertyAssignment(node: Node): boolean {
  return node?.type === "Property" && node.kind === "init" && !node.method && !node.shorthand;
}

function isOptionalChain(node: Node): boolean {
  for (let current = node; ;) {
    if (current?.type === "CallExpression" || current?.type === "MemberExpression") {
      if (current.optional) return true;
      current = current.type === "CallExpression" ? current.callee : current.object;
    } else if (current?.type === "TSNonNullExpression") current = current.expression;
    else return false;
  }
}

function accessName(node: Node): string | undefined {
  if (node?.type !== "MemberExpression" || node.computed) return undefined;
  return node.property.type === "PrivateIdentifier" ? `#${node.property.name}` : node.property.name;
}

function isIdentifier(node: Node, name: string): boolean {
  return node?.type === "Identifier" && node.name === name;
}

function isPromiseAll(node: Node): boolean {
  return accessName(node) === "all" && isIdentifier(node.object, "Promise");
}

function argumentsOf(node: Node): Node[] {
  if (node.type === "ImportExpression")
    return node.options ? [node.source, node.options] : [node.source];
  return node.arguments ?? [];
}

function isNullLiteral(node: Node): boolean {
  return node?.type === "Literal" && node.value === null && !node.regex;
}

function isBooleanLiteral(node: Node, value: boolean): boolean {
  return node?.type === "Literal" && node.value === value;
}

function isNumericLiteral(node: Node): boolean {
  return node?.type === "Literal" && typeof node.value === "number";
}

function stringLiteralText(node: Node): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  return undefined;
}

// TypeScript literal expressions: strings, numbers, bigints, regexes and plain templates.
function isLiteralExpression(node: Node): boolean {
  if (node?.type === "TemplateLiteral") return node.expressions.length === 0;
  return (
    node?.type === "Literal" &&
    (Boolean(node.regex) || ["string", "number", "bigint"].includes(typeof node.value))
  );
}

function isKeywordLiteral(node: Node): boolean {
  return isNullLiteral(node) || isBooleanLiteral(node, true) || isBooleanLiteral(node, false);
}

function isPrefixUnary(node: Node): boolean {
  return (
    (node?.type === "UnaryExpression" && ["!", "~", "-", "+"].includes(node.operator)) ||
    (node?.type === "UpdateExpression" && node.prefix)
  );
}

function isAssignmentTarget(pattern: Node): boolean {
  let current = pattern;
  while (
    ["ArrayPattern", "ObjectPattern", "AssignmentPattern", "RestElement"].includes(
      current.parent?.type,
    ) ||
    (current.parent?.type === "Property" && current.parent.parent?.type === "ObjectPattern")
  )
    current = current.parent;
  const parent = current.parent;
  return (
    (parent?.type === "AssignmentExpression" ||
      parent?.type === "ForInStatement" ||
      parent?.type === "ForOfStatement") &&
    parent.left === current
  );
}

function hasRuntimeModuleSyntax(program: Node): boolean {
  let esmSyntax = false;
  walk(program, (node) => {
    if (esmSyntax) return false;
    if (
      (node.type === "MetaProperty" && node.meta.name === "import") ||
      (node.type === "AwaitExpression" && !hasAncestor(node, isFunctionLike))
    ) {
      esmSyntax = true;
      return false;
    }
  });
  if (esmSyntax) return true;
  return program.body.some((statement: Node) => {
    switch (statement.type) {
      case "ImportDeclaration":
        return (
          statement.importKind !== "type" &&
          !(
            statement.specifiers.length > 0 &&
            statement.specifiers.every(
              (specifier: Node) =>
                specifier.type === "ImportSpecifier" && specifier.importKind === "type",
            )
          )
        );
      case "ExportNamedDeclaration":
        if (statement.declaration)
          return (
            ![
              "TSTypeAliasDeclaration",
              "TSInterfaceDeclaration",
              "TSImportEqualsDeclaration",
            ].includes(statement.declaration.type) && !statement.declaration.declare
          );
        return (
          statement.exportKind !== "type" &&
          !(
            statement.specifiers.length > 0 &&
            statement.specifiers.every((specifier: Node) => specifier.exportKind === "type")
          )
        );
      case "ExportAllDeclaration":
        return statement.exportKind !== "type";
      case "ExportDefaultDeclaration":
        return statement.declaration.type !== "TSInterfaceDeclaration";
      default:
        return false;
    }
  });
}

function hasAncestor(node: Node, predicate: (node: Node) => boolean): boolean {
  for (let current = node; current; current = current.parent) if (predicate(current)) return true;
  return false;
}

function importEdges(
  parsed: ParsedModule,
  kind: "runtime" | "types",
  commonjs: boolean,
  explicitCommonjs: boolean,
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const supportsStaticImports = !explicitCommonjs;
  function add(
    literal: Node,
    typeOnly: boolean,
    required: boolean,
    probe: boolean | "commonjs" = false,
    resolutionOnly = false,
  ) {
    literal = unwrapParens(literal);
    const specifier = stringLiteralText(literal);
    if (specifier === undefined) return;
    edges.push({
      specifier,
      start: literal.start,
      end: literal.end,
      kind: typeOnly ? "types" : kind,
      required: !typeOnly && required,
      probe,
      resolutionOnly,
    });
  }
  walk(parsed.program, (node) => {
    if (node.type === "ImportDeclaration") {
      const typeOnly =
        node.importKind === "type" ||
        (node.specifiers.length > 0 &&
          node.specifiers.every(
            (specifier: Node) =>
              specifier.type === "ImportSpecifier" && specifier.importKind === "type",
          ));
      if (typeOnly || supportsStaticImports) add(node.source, typeOnly, true);
    } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      const typeOnly =
        node.exportKind === "type" ||
        (node.type === "ExportNamedDeclaration" &&
          node.specifiers.length > 0 &&
          node.specifiers.every((specifier: Node) => specifier.exportKind === "type"));
      if (typeOnly || supportsStaticImports) add(node.source, typeOnly, true);
    } else if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference.type === "TSExternalModuleReference"
    ) {
      add(node.moduleReference.expression, node.importKind === "type", true, "commonjs");
    } else if (node.type === "TSImportType") {
      add(node.source, true, false);
    } else if (node.type === "ImportExpression") {
      add(node.source, false, isUnconditional(node, true));
    } else if (node.type === "CallExpression") {
      const member = node.callee;
      const memberName =
        accessName(member) ??
        (member.type === "MemberExpression" &&
        member.property.type === "Literal" &&
        typeof member.property.value === "string"
          ? member.property.value
          : undefined);
      const receiver = member.type === "MemberExpression" ? member.object : undefined;
      if (
        (commonjs && isIdentifier(member, "require") && !shadowsName(node, "require")) ||
        (isIdentifier(receiver, "module") &&
          memberName === "require" &&
          commonjs &&
          !shadowsName(node, "module"))
      )
        add(node.arguments[0], false, isUnconditional(node, false), "commonjs");
      else if (
        commonjs &&
        isIdentifier(receiver, "require") &&
        memberName === "resolve" &&
        !shadowsName(node, "require")
      )
        add(node.arguments[0], false, isUnconditional(node, false), "commonjs", true);
      else if (
        !commonjs &&
        memberName === "resolve" &&
        receiver?.type === "MetaProperty" &&
        receiver.meta.name === "import" &&
        receiver.property.name === "meta"
      )
        add(node.arguments[0], false, isUnconditional(node, false), false, true);
    }
  });
  edges.sort((left, right) => left.start - right.start);
  const jsdoc = /\/\*\*[\s\S]*?\*\//g;
  for (let comment; (comment = jsdoc.exec(parsed.text));) {
    const imports = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
    for (let match; (match = imports.exec(comment[0]));) {
      const start = comment.index + match.index + match[0].indexOf(match[1]!);
      edges.push({
        specifier: match[1]!,
        start,
        end: start + match[1]!.length,
        kind: "types",
        required: false,
        typeReference: true,
      });
    }
  }
  const { types, paths } = referenceDirectives(parsed);
  for (const ref of types)
    edges.push({
      specifier: ref.fileName,
      start: ref.pos,
      end: ref.end,
      kind: "types",
      required: false,
      typeReference: true,
    });
  for (const ref of paths)
    edges.push({
      specifier: ref.fileName.startsWith(".") ? ref.fileName : `./${ref.fileName}`,
      start: ref.pos,
      end: ref.end,
      kind: "types",
      required: false,
    });
  return edges;
}

// Same leading-comment and `/// <reference />` matching as TypeScript's pragma scanner.
function referenceDirectives(parsed: ParsedModule): {
  types: FileReference[];
  paths: FileReference[];
} {
  const types: FileReference[] = [];
  const paths: FileReference[] = [];
  const { text } = parsed;
  let position = parsed.program.hashbang?.end ?? (text.charCodeAt(0) === 0xfeff ? 1 : 0);
  for (const comment of parsed.comments) {
    if (comment.end <= position) continue;
    if (!/^[\s\u0085\u200b]*$/.test(text.slice(position, comment.start))) break;
    position = comment.end;
    const value = text.slice(comment.start, comment.end);
    if (
      comment.type !== "Line" ||
      /^\/\/\/\s*<(\S+)\s.*?\/>/m.exec(value)?.[1]?.toLowerCase() !== "reference"
    )
      continue;
    const argument = (name: string) => {
      const match = new RegExp(`(\\s${name}\\s*=\\s*)(?:(?:'([^']*)')|(?:"([^"]*)"))`, "im").exec(
        value,
      );
      const fileName = match && (match[2] || match[3]);
      if (!fileName) return undefined;
      const pos = comment.start + match.index + match[1]!.length + 1;
      return { fileName, pos, end: pos + fileName.length };
    };
    if (argument("no-default-lib")?.fileName === "true") continue;
    const typesReference = argument("types");
    if (typesReference) types.push(typesReference);
    else if (!argument("lib")) {
      const pathReference = argument("path");
      if (pathReference) paths.push(pathReference);
    }
  }
  return { types, paths };
}

function positionOf(parsed: ParsedModule, offset: number): { line: number; character: number } {
  const lineStarts = (parsed.lineStarts ??= computeLineStarts(parsed.text));
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: offset - lineStarts[low]! };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
    if (isLineBreak(code)) starts.push(index + 1);
  }
  return starts;
}

function isLineBreak(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function isDecoratorExpression(node: Node, ancestor: Node): boolean {
  for (let current = node.parent; current && current !== ancestor; current = current.parent)
    if (current.type === "Decorator")
      return (
        current.parent === ancestor ||
        (current.parent?.parent === ancestor && ancestor.params?.includes(current.parent))
      );
  return false;
}

function isNonAbruptElement(node: Node): boolean {
  // Array holes are TypeScript omitted expressions.
  if (!node) return true;
  switch (node.type) {
    case "ParenthesizedExpression":
      return isNonAbruptElement(node.expression);
    case "UnaryExpression":
      if (node.operator === "!") return isNonAbruptElement(node.argument);
      if (["~", "-", "+"].includes(node.operator))
        return (
          node.argument.type === "Literal" &&
          !node.argument.regex &&
          (["number", "string", "boolean"].includes(typeof node.argument.value) ||
            node.argument.value === null ||
            (node.operator !== "+" && typeof node.argument.value === "bigint"))
        );
      if (node.operator === "void" || node.operator === "typeof")
        return isNonAbruptElement(node.argument);
      return false;
    case "SequenceExpression":
      return node.expressions.every(isNonAbruptElement);
    case "ArrayExpression":
    case "ArrayPattern":
      return node.elements.every(isNonAbruptElement);
    case "ObjectExpression":
    case "ObjectPattern":
      return node.properties.every(
        (property: Node) =>
          isPropertyAssignment(property) &&
          literalPropertyName(property.key, property.computed) !== undefined &&
          isNonAbruptElement(property.value),
      );
    case "ClassExpression":
      return !hasHeritage(node) && node.body.body.length === 0;
    case "ImportExpression":
      return !node.options && stringLiteralText(node.source) !== undefined;
    case "ThisExpression":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return true;
    default:
      return isLiteralExpression(node) || isUndefined(node) || isKeywordLiteral(node);
  }
}

function isNonAbruptStatement(statement: Node): boolean {
  switch (statement.type) {
    case "ExpressionStatement":
      return isNonAbruptElement(statement.expression);
    case "VariableDeclaration":
      return statement.declarations.every(
        (declaration: Node) =>
          declaration.id.type === "Identifier" &&
          (!declaration.init || isNonAbruptElement(declaration.init)),
      );
    case "BlockStatement":
      return statement.body.every(isNonAbruptStatement);
    case "EmptyStatement":
      return true;
    default:
      return false;
  }
}

function isValidClassHeritage(node: Node): boolean {
  node = unwrapParens(node);
  return (
    isNullLiteral(node) ||
    (node.type === "ClassExpression" && !hasHeritage(node) && node.body.body.length === 0) ||
    (isFunctionExpression(node) && !node.generator && !node.async)
  );
}

function isExportsTarget(left: Node, assignment: Node): boolean {
  if (left.type === "Identifier") return true;
  if (left.type !== "MemberExpression") return false;
  const object = left.object;
  const moduleExports =
    accessName(object) === "exports" &&
    isIdentifier(object.object, "module") &&
    !shadowsName(assignment, "module");
  if (!left.computed)
    return (
      (isIdentifier(object, "exports") && !shadowsName(assignment, "exports")) ||
      (isIdentifier(object, "module") &&
        accessName(left) === "exports" &&
        !shadowsName(assignment, "module")) ||
      moduleExports
    );
  return (
    isNonAbruptElement(left.property) &&
    ((isIdentifier(object, "exports") && !shadowsName(assignment, "exports")) || moduleExports)
  );
}

function hasAbruptPredecessor(node: Node, parent: Node): boolean {
  switch (parent.type) {
    case "TemplateLiteral": {
      const index = parent.expressions.findIndex((expression: Node) => isWithin(node, expression));
      return (
        index >= 0 &&
        parent.expressions.slice(0, index).some((expression: Node) => {
          expression = unwrapParens(expression);
          return (
            !isNonAbruptElement(expression) ||
            !(
              isLiteralExpression(expression) ||
              isUndefined(expression) ||
              isKeywordLiteral(expression) ||
              (expression.type === "UnaryExpression" &&
                (expression.operator === "void" || expression.operator === "typeof")) ||
              isPrefixUnary(expression)
            )
          );
        })
      );
    }
    case "TaggedTemplateExpression":
      return isWithin(node, parent.quasi) && !isNonAbruptElement(parent.tag);
    case "MemberExpression":
      return (
        parent.computed && isWithin(node, parent.property) && !isNonAbruptElement(parent.object)
      );
    case "BinaryExpression":
    case "LogicalExpression":
      return isWithin(node, parent.right) && !isNonAbruptElement(parent.left);
    case "AssignmentExpression":
      return (
        isWithin(node, parent.right) &&
        !(parent.operator === "=" && isExportsTarget(parent.left, parent)) &&
        !isNonAbruptElement(parent.left)
      );
    case "SequenceExpression": {
      const index = parent.expressions.findIndex((expression: Node) => isWithin(node, expression));
      return parent.expressions
        .slice(0, Math.max(index, 0))
        .some((expression: Node) => !isNonAbruptElement(expression));
    }
    case "ArrayPattern":
      if (!isAssignmentTarget(parent)) return false;
    // falls through
    case "ArrayExpression":
      return parent.elements
        .slice(
          0,
          parent.elements.findIndex((item: Node) => item && isWithin(node, item)),
        )
        .some((item: Node) => !isNonAbruptElement(item));
    case "CallExpression":
    case "NewExpression":
    case "ImportExpression": {
      const args = argumentsOf(parent);
      const index = args.findIndex((arg) => isWithin(node, arg));
      const safeCallee =
        parent.type !== "ImportExpression" &&
        (isNonAbruptElement(parent.callee) ||
          (parent.type === "CallExpression" &&
            isPromiseAll(parent.callee) &&
            !shadowsName(parent, "Promise")));
      return (
        index >= 0 && (!safeCallee || args.slice(0, index).some((arg) => !isNonAbruptElement(arg)))
      );
    }
    case "VariableDeclaration": {
      const index = parent.declarations.findIndex((declaration: Node) =>
        isWithin(node, declaration),
      );
      return (
        index >= 0 &&
        parent.declarations
          .slice(0, index)
          .some(
            (declaration: Node) =>
              Boolean(declaration.init) && !isNonAbruptElement(declaration.init),
          )
      );
    }
    case "ObjectPattern":
      if (!isAssignmentTarget(parent)) return false;
    // falls through
    case "ObjectExpression": {
      const index = parent.properties.findIndex((property: Node) => isWithin(node, property));
      const current = parent.properties[index];
      return (
        index >= 0 &&
        (parent.properties
          .slice(0, index)
          .some(
            (property: Node) =>
              property.type !== "Property" ||
              property.shorthand ||
              (property.computed && !isNonAbruptElement(property.key)) ||
              (isPropertyAssignment(property) && !isNonAbruptElement(property.value)),
          ) ||
          (isPropertyAssignment(current) &&
            current.computed &&
            isWithin(node, current.value) &&
            !isNonAbruptElement(current.key)))
      );
    }
    default:
      return false;
  }
}

function isNonCallable(node: Node): boolean {
  node = unwrapParens(node);
  return (
    isUndefined(node) ||
    isLiteralExpression(node) ||
    ((node.type === "ObjectExpression" || node.type === "ArrayExpression") &&
      isNonAbruptElement(node)) ||
    isKeywordLiteral(node)
  );
}

function isImmediateField(field: Node): boolean {
  const owner = field.parent?.parent;
  if (owner?.type !== "ClassExpression" || hasHeritage(owner) || owner.decorators?.length)
    return false;
  let expression = owner;
  while (expression.parent?.type === "ParenthesizedExpression") expression = expression.parent;
  const call = expression.parent;
  if (
    call?.type !== "NewExpression" ||
    call.callee !== expression ||
    !call.arguments.every(isNonAbruptElement)
  )
    return false;
  for (const member of owner.body.body) {
    if (member.computed || member.type === "StaticBlock" || member.decorators?.length) return false;
    if (
      isPropertyDeclaration(member) &&
      member !== field &&
      member.value &&
      (member.start < field.start || member.static) &&
      !isNonAbruptElement(member.value)
    )
      return false;
  }
  return true;
}

function hasAbruptClassPrefix(member: Node, node: Node): boolean {
  const owner = member.parent?.parent;
  if (!isClass(owner)) return false;
  const members = owner.body.body;
  return (
    (owner.superClass && !isValidClassHeritage(owner.superClass)) ||
    (isPropertyDeclaration(member) &&
      member.computed &&
      member.value &&
      isWithin(node, member.value) &&
      !isNonAbruptElement(member.key)) ||
    members
      .slice(0, members.indexOf(member))
      .some(
        (previous: Node) =>
          (previous.computed && !isNonAbruptElement(previous.key)) ||
          (previous.type === "StaticBlock" && !previous.body.every(isNonAbruptStatement)) ||
          (isPropertyDeclaration(previous) &&
            previous.static &&
            previous.value &&
            !isNonAbruptElement(previous.value)),
      )
  );
}

function isUnconditional(node: Node, dynamic: boolean): boolean {
  if (
    isOptionalChain(node) ||
    argumentsOf(node)
      .slice(1)
      .some((arg) => !isNonAbruptElement(arg))
  )
    return false;
  let expression = node;
  while (true) {
    const parent = expression.parent;
    if (wrapperTypes.has(parent?.type)) {
      expression = parent;
      continue;
    }
    // TypeScript nests comma expressions to the left, so only the last operand of a sequence
    // with non-abrupt predecessors climbs out of it.
    if (dynamic && parent?.type === "SequenceExpression") {
      const index = parent.expressions.indexOf(expression);
      if (
        index === parent.expressions.length - 1 &&
        parent.expressions.slice(0, index).every(isNonAbruptElement)
      ) {
        expression = parent;
        continue;
      }
      return false;
    }
    break;
  }
  const awaitedCalls = new Set<Node>();
  let awaitedImmediate = false;
  if (dynamic && expression.parent?.type === "ArrayExpression") {
    const elements = expression.parent.elements;
    if (!elements.slice(0, elements.indexOf(expression)).every(isNonAbruptElement)) return false;
    let array = expression.parent;
    while (array.parent?.type === "ParenthesizedExpression") array = array.parent;
    const call = array.parent;
    if (
      call?.type === "CallExpression" &&
      !isOptionalChain(call) &&
      call.arguments.length === 1 &&
      call.arguments[0] === array &&
      isPromiseAll(call.callee) &&
      !shadowsName(call, "Promise")
    ) {
      awaitedCalls.add(call);
      expression = call;
      while (expression.parent?.type === "ParenthesizedExpression") expression = expression.parent;
    }
  }
  while (dynamic && accessName(expression.parent) !== undefined) {
    const member = expression.parent;
    const call = member.parent;
    const name = accessName(member)!;
    if (
      member.object !== expression ||
      !["then", "finally", "catch"].includes(name) ||
      call?.type !== "CallExpression" ||
      isOptionalChain(call) ||
      call.callee !== member ||
      (name === "then"
        ? call.arguments.length > 2 || (call.arguments[1] && !isNonCallable(call.arguments[1]))
        : call.arguments.length > 1 ||
          (name === "catch" &&
            call.arguments[0] &&
            !isNonCallable(call.arguments[0]) &&
            !(
              (call.arguments[0].type === "ArrowFunctionExpression" ||
                isFunctionExpression(call.arguments[0])) &&
              call.arguments[0].body.type === "BlockStatement" &&
              isRethrowingCatch(call.arguments[0].body)
            ))) ||
      !call.arguments.every(isNonAbruptElement)
    )
      break;
    awaitedCalls.add(call);
    expression = call;
    while (expression.parent?.type === "ParenthesizedExpression") expression = expression.parent;
  }
  if (dynamic && expression.parent?.type !== "AwaitExpression") {
    let returned = expression;
    if (returned.parent?.type === "ReturnStatement") returned = returned.parent;
    const body = returned.parent;
    const immediate = body?.type === "BlockStatement" ? body.parent : body;
    if (
      !(isFunctionExpression(immediate) || immediate?.type === "ArrowFunctionExpression") ||
      !isImmediateInvocation(immediate, node, true)
    )
      return false;
    let callee = immediate;
    while (callee.parent?.type === "ParenthesizedExpression") callee = callee.parent;
    const invocation = callee.parent;
    if (invocation?.type !== "CallExpression" || invocation.parent?.type !== "AwaitExpression")
      return false;
    awaitedCalls.add(invocation);
    awaitedImmediate = true;
  }
  if (dynamic) {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type !== "ArrowFunctionExpression" && !isFunctionExpression(ancestor)) continue;
      if (!isImmediateInvocation(ancestor, node, true)) break;
      let callee = ancestor;
      while (callee.parent?.type === "ParenthesizedExpression") callee = callee.parent;
      const invocation = callee.parent;
      if (invocation?.type === "CallExpression" && invocation.parent?.type === "AwaitExpression") {
        awaitedCalls.add(invocation);
        awaitedImmediate = true;
      }
    }
  }
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (hasAbruptPredecessor(node, parent)) return false;
    if (
      (isFunctionLike(parent) &&
        !isDecoratorExpression(node, parent) &&
        !isImmediateInvocation(parent, node, dynamic)) ||
      (isPropertyDeclaration(parent) &&
        !isDecoratorExpression(node, parent) &&
        !isWithin(node, parent.key) &&
        !parent.static &&
        !isImmediateField(parent)) ||
      ((isPropertyDeclaration(parent) || parent.type === "StaticBlock") &&
        hasAbruptClassPrefix(parent, node)) ||
      (parent.type === "IfStatement" && !isWithin(node, parent.test)) ||
      (parent.type === "ConditionalExpression" && !isWithin(node, parent.test)) ||
      (parent.type === "SwitchStatement" && !isWithin(node, parent.discriminant)) ||
      (parent.type === "WhileStatement" && !isWithin(node, parent.test)) ||
      (parent.type === "DoWhileStatement" &&
        !isWithin(node, parent.body) &&
        hasAbruptCompletion(parent.body)) ||
      (parent.type === "ForStatement" &&
        !isWithin(node, parent.init) &&
        !isWithin(node, parent.test)) ||
      ((parent.type === "ForInStatement" || parent.type === "ForOfStatement") &&
        !isWithin(node, parent.right)) ||
      (parent.type === "TryStatement" &&
        ((parent.handler &&
          (isWithin(node, parent.handler) ||
            (isWithin(node, parent.block) &&
              (!isRethrowingCatch(parent.handler.body) ||
                parent.block.body
                  .slice(
                    0,
                    parent.block.body.findIndex((statement: Node) => isWithin(node, statement)),
                  )
                  .some((statement: Node) => !isNonAbruptStatement(statement)))))) ||
          (parent.finalizer &&
            !isWithin(node, parent.finalizer) &&
            hasAbruptCompletion(parent.finalizer, false)))) ||
      ((parent.type === "LogicalExpression" ||
        (parent.type === "AssignmentExpression" &&
          ["&&=", "||=", "??="].includes(parent.operator))) &&
        isWithin(node, parent.right)) ||
      (isOptionalChain(parent) &&
        (parent.type === "CallExpression" || parent.computed) &&
        !isWithin(node, parent.type === "CallExpression" ? parent.callee : parent.object))
    )
      return false;
    if (
      parent.type === "BlockStatement" ||
      parent.type === "Program" ||
      parent.type === "StaticBlock"
    ) {
      const statements = parent.body;
      const index = statements.findIndex((statement: Node) => isWithin(node, statement));
      if (
        awaitedImmediate &&
        parent.type === "BlockStatement" &&
        isFunctionLike(parent.parent) &&
        statements.slice(0, index).some((statement: Node) => !isNonAbruptStatement(statement))
      )
        return false;
      if (
        statements
          .slice(0, index)
          .some(
            (statement: Node) =>
              isDefinitelyAbrupt(statement) || hasAbruptCompletion(statement, false),
          )
      )
        return false;
    }
    if (
      dynamic &&
      (parent.type === "CallExpression" || parent.type === "ImportExpression") &&
      !awaitedCalls.has(parent)
    )
      return false;
  }
  return true;
}

function isDefinitelyAbrupt(statement: Node): boolean {
  switch (statement.type) {
    case "ExpressionStatement": {
      const expression = unwrapParens(statement.expression);
      return (
        expression.type === "MemberExpression" &&
        !expression.computed &&
        !expression.optional &&
        isNullLiteral(unwrapParens(expression.object))
      );
    }
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement": {
      const condition = unwrapParens(statement.test);
      return (
        (!condition || isBooleanLiteral(condition, true)) && !hasAbruptCompletion(statement.body)
      );
    }
    case "ReturnStatement":
    case "ThrowStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return true;
    case "TryStatement":
      return Boolean(statement.finalizer) && isDefinitelyAbrupt(statement.finalizer);
    case "BlockStatement":
      return statement.body.some(isDefinitelyAbrupt);
    case "IfStatement":
      return (
        Boolean(statement.alternate) &&
        isDefinitelyAbrupt(statement.consequent) &&
        isDefinitelyAbrupt(statement.alternate)
      );
    default:
      return false;
  }
}

function isRethrowingCatch(block: Node): boolean {
  const statements = block.body;
  const last = statements.at(-1);
  return (
    !!last &&
    statements.slice(0, -1).every(isNonAbruptStatement) &&
    (last.type === "ThrowStatement" ||
      (last.type === "BlockStatement" && isRethrowingCatch(last)) ||
      (last.type === "IfStatement" &&
        !!last.alternate &&
        last.consequent.type === "BlockStatement" &&
        last.alternate.type === "BlockStatement" &&
        isRethrowingCatch(last.consequent) &&
        isRethrowingCatch(last.alternate)))
  );
}

function literalTruthiness(node: Node): boolean | undefined {
  node = unwrapParens(node);
  if (isBooleanLiteral(node, true)) return true;
  if (isBooleanLiteral(node, false) || isNullLiteral(node)) return false;
  const text = stringLiteralText(node);
  if (text !== undefined) return Boolean(text);
  if (isNumericLiteral(node)) return Boolean(node.value);
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const value = literalTruthiness(node.argument);
    return value === undefined ? undefined : !value;
  }
  return undefined;
}

const iterationTypes = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "DoWhileStatement",
  "WhileStatement",
]);

function hasAbruptCompletion(statement: Node, includeThrow = true): boolean {
  let abrupt = false;
  function visit(node: Node) {
    if (abrupt || isFunctionLike(node)) return;
    if (node.type === "IfStatement") {
      visit(node.test);
      const condition = literalTruthiness(node.test);
      if (condition !== false) visit(node.consequent);
      if (condition !== true && node.alternate) visit(node.alternate);
      return;
    }
    if (
      (node.type === "WhileStatement" && literalTruthiness(node.test) === false) ||
      (node.type === "ForStatement" && node.test && literalTruthiness(node.test) === false)
    )
      return;
    if (node.type === "TryStatement" && node.finalizer && isDefinitelyAbrupt(node.finalizer)) {
      visit(node.finalizer);
      return;
    }
    if (node.type === "ReturnStatement" || (includeThrow && node.type === "ThrowStatement"))
      abrupt = true;
    if (node.type === "BreakStatement" || node.type === "ContinueStatement") {
      let target = node.parent;
      while (target) {
        if (
          node.label
            ? target.type === "LabeledStatement" && target.label.name === node.label.name
            : iterationTypes.has(target.type) ||
              (node.type === "BreakStatement" && target.type === "SwitchStatement")
        )
          break;
        target = target.parent;
      }
      if (target && !isWithin(target, statement)) {
        const loop = target.type === "LabeledStatement" ? target.body : target;
        if (node.type === "BreakStatement" || loop !== statement.parent) abrupt = true;
      }
    }
    for (const child of childNodes(node)) visit(child);
  }
  visit(statement);
  return abrupt;
}

interface BindingParts {
  name: Node;
  initializer?: Node;
}

function bindingParts(node: Node): BindingParts {
  if (node.type === "TSParameterProperty") return bindingParts(node.parameter);
  if (node.type === "AssignmentPattern") return { name: node.left, initializer: node.right };
  if (node.type === "RestElement") return { name: node.argument };
  return { name: node };
}

function isImmediateInvocation(node: Node, load: Node, allowAwaitedAsync = false): boolean {
  const constructor = isConstructor(node);
  if (
    !(isFunctionExpression(node) || node.type === "ArrowFunctionExpression" || constructor) ||
    node.generator
  )
    return false;
  let expression = constructor ? node.parent.parent?.parent : node;
  if (constructor && expression?.type !== "ClassExpression") return false;
  while (expression.parent?.type === "ParenthesizedExpression") expression = expression.parent;
  let method: string | undefined;
  const name = accessName(expression.parent);
  if (expression.parent?.object === expression && (name === "call" || name === "apply")) {
    method = name;
    expression = expression.parent;
    while (expression.parent?.type === "ParenthesizedExpression") expression = expression.parent;
  }
  const call = expression.parent;
  if (
    node.async &&
    !(
      allowAwaitedAsync &&
      call?.type === "CallExpression" &&
      call.parent?.type === "AwaitExpression"
    )
  )
    return false;
  if (
    !(call?.type === "CallExpression" || call?.type === "NewExpression") ||
    isOptionalChain(call) ||
    call.callee !== expression ||
    (constructor && call.type !== "NewExpression") ||
    (call.type === "NewExpression" && (method || node.type === "ArrowFunctionExpression"))
  )
    return false;
  if (!call.arguments.every(isNonAbruptElement)) return false;
  if (call.type === "NewExpression" && constructor) {
    const owner = node.parent.parent.parent;
    if (
      hasHeritage(owner) ||
      owner.decorators?.length ||
      owner.body.body.some(
        (member: Node) =>
          member.computed ||
          member.type === "StaticBlock" ||
          (isPropertyDeclaration(member) && member.value && !isNonAbruptElement(member.value)) ||
          member.decorators?.length,
      )
    )
      return false;
  }
  const params: Node[] = node.params;
  const index = params.findIndex((parameter) => isWithin(load, parameter));
  if (call.arguments.some((arg: Node) => arg.type === "SpreadElement")) return false;
  let args: Node[] = call.arguments;
  if (method === "call") args = args.slice(1);
  if (method === "apply") {
    const list = unwrapParens(args[1]);
    if (!list || isUndefined(list) || isNullLiteral(list)) args = [];
    else if (
      list.type === "ArrayExpression" &&
      !list.elements.some((element: Node) => element?.type === "SpreadElement")
    )
      args = list.elements;
    else return false;
  }
  for (const [offset, parameter] of params.entries()) {
    if (offset === index) break;
    const { name, initializer } = bindingParts(parameter);
    if (name.type !== "Identifier") return false;
    if (isUndefined(args[offset]) && initializer && !isNonAbruptElement(initializer)) return false;
  }
  if (node.body && isWithin(load, node.body)) return true;
  if (index < 0) return false;
  return bindingDefaultExecutes(bindingParts(params[index]), args[index] ?? undefined, load);
}

function isUndefined(value: Node): boolean {
  if (!value) return true;
  value = unwrapParens(value);
  return (
    (value.type === "UnaryExpression" &&
      value.operator === "void" &&
      isNumericLiteral(value.argument)) ||
    (isIdentifier(value, "undefined") && !shadowsName(value, "undefined"))
  );
}

function literalPropertyName(key: Node, computed: boolean): string | undefined {
  if (computed) key = unwrapParens(key);
  else if (key.type === "Identifier") return key.name;
  return key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")
    ? String(key.value)
    : undefined;
}

function bindingDefaultExecutes(binding: BindingParts, value: Node, load: Node): boolean {
  if (isUndefined(value) && binding.initializer) {
    if (isWithin(load, binding.initializer)) return true;
    value = binding.initializer;
  }
  if (!value || binding.name.type === "Identifier") return false;
  value = unwrapParens(value);
  if (binding.name.type === "ObjectPattern" && value.type === "ObjectExpression") {
    if (
      value.properties.some(
        (property: Node) =>
          !isPropertyAssignment(property) ||
          literalPropertyName(property.key, property.computed) === undefined ||
          (!property.computed && literalPropertyName(property.key, false) === "__proto__"),
      )
    )
      return false;
    for (const element of binding.name.properties) {
      if (element.type === "RestElement" || !isWithin(load, element)) continue;
      const name = literalPropertyName(element.key, element.computed);
      if (name === undefined) return false;
      const property = value.properties.findLast(
        (item: Node) => literalPropertyName(item.key, item.computed) === name,
      );
      if (!property && Object.hasOwn(Object.prototype, name)) return false;
      return bindingDefaultExecutes(bindingParts(element.value), property?.value, load);
    }
  }
  if (binding.name.type === "ArrayPattern" && value.type === "ArrayExpression") {
    if (value.elements.some((element: Node) => element?.type === "SpreadElement")) return false;
    for (const [index, element] of binding.name.elements.entries()) {
      if (!element || element.type === "RestElement" || !isWithin(load, element)) continue;
      return bindingDefaultExecutes(
        bindingParts(element),
        value.elements[index] ?? undefined,
        load,
      );
    }
  }
  return false;
}

function binds(pattern: Node, identifier: string): boolean {
  switch (pattern?.type) {
    case "Identifier":
      return pattern.name === identifier;
    case "AssignmentPattern":
      return binds(pattern.left, identifier);
    case "RestElement":
      return binds(pattern.argument, identifier);
    case "TSParameterProperty":
      return binds(pattern.parameter, identifier);
    case "ObjectPattern":
      return pattern.properties.some((property: Node) =>
        binds(property.type === "Property" ? property.value : property, identifier),
      );
    case "ArrayPattern":
      return pattern.elements.some((element: Node) => binds(element, identifier));
    default:
      return false;
  }
}

function bindingContains(declarator: Node, node: Node): boolean {
  const blockScoped = declarator.parent?.kind !== "var";
  for (let scope = declarator.parent; scope; scope = scope.parent) {
    if (
      scope.type === "Program" ||
      scope.type === "TSModuleBlock" ||
      isFunctionLike(scope) ||
      (blockScoped &&
        [
          "BlockStatement",
          "StaticBlock",
          "CatchClause",
          "ForStatement",
          "ForInStatement",
          "ForOfStatement",
        ].includes(scope.type))
    )
      return isWithin(node, scope);
    // TypeScript scopes switch declarations to the case block, which excludes the discriminant.
    if (blockScoped && scope.type === "SwitchStatement")
      return scope.cases.some((item: Node) => isWithin(node, item));
  }
  return false;
}

function shadowsName(node: Node, identifier: string): boolean {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (
      (isFunctionExpression(scope) || scope.type === "ClassExpression") &&
      scope.id?.name === identifier
    )
      return true;
    if (isFunctionLike(scope) && scope.params?.some((param: Node) => binds(param, identifier)))
      return true;
    if (scope.type === "CatchClause" && binds(scope.param, identifier)) return true;
    if (
      scope.type !== "Program" &&
      scope.type !== "BlockStatement" &&
      scope.type !== "TSModuleBlock" &&
      scope.type !== "StaticBlock"
    )
      continue;
    let found = false;
    const program = scope.type === "Program";
    walk(scope, (child) => {
      if (found) return false;
      if (child === scope) return;
      if (
        (child.type === "VariableDeclarator" &&
          binds(child.id, identifier) &&
          bindingContains(child, node) &&
          !(
            (identifier === "require" || identifier === "module") &&
            program &&
            !child.init &&
            child.parent.kind === "var"
          ) &&
          !child.parent.declare) ||
        ((child.type === "FunctionDeclaration" ||
          child.type === "TSDeclareFunction" ||
          child.type === "ClassDeclaration") &&
          !child.declare &&
          child.id?.name === identifier &&
          isWithin(node, child.parent)) ||
        ((child.type === "ImportDefaultSpecifier" || child.type === "ImportNamespaceSpecifier") &&
          child.parent.importKind !== "type" &&
          child.local.name === identifier) ||
        (child.type === "ImportSpecifier" &&
          child.importKind !== "type" &&
          child.parent.importKind !== "type" &&
          child.local.name === identifier) ||
        (child.type === "TSImportEqualsDeclaration" &&
          child.importKind !== "type" &&
          child.id.name === identifier)
      )
        found = true;
      if (child.type === "TSModuleBlock" || isFunctionLike(child) || isClass(child)) return false;
    });
    if (found) return true;
  }
  return false;
}
