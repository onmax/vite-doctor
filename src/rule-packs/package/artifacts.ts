import { isBuiltin } from "node:module";
import { basename } from "node:path";
import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "pathe";
import ts from "typescript";
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
  root = realpathSync(root);
  const manifestPath = resolve(root, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = parsePackageManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
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
          ? [commonjsFile(path)].filter((file): file is string => file !== undefined)
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
    required: boolean,
    kind: "runtime" | "types" = "runtime",
    adjacentDeclaration = false,
  ): boolean {
    if (typeof value === "string") {
      if (!value.startsWith("./") || !inside(resolve(root, value))) return false;
      if (
        value
          .slice(2)
          .split(/[\\/]/)
          .some((segment) => /^(\.|\.\.|node_modules)$/i.test(segment))
      )
        return false;
      enqueue(value, kind, required, root, false, adjacentDeclaration);
      return true;
    }
    if (Array.isArray(value))
      return value.some((item) => targets(item, required, kind, adjacentDeclaration));
    if (value && typeof value === "object") {
      let selected = false;
      for (const [condition, item] of Object.entries(value)) {
        const resolved = targets(
          item,
          required,
          condition === "types" || condition.startsWith("types@") ? "types" : kind,
          adjacentDeclaration,
        );
        selected ||= resolved;
      }
      return selected;
    }
    return false;
  }

  if (manifest.exports !== undefined) {
    const exports = manifest.exports;
    if (
      exports &&
      typeof exports === "object" &&
      !Array.isArray(exports) &&
      Object.keys(exports).some((key) => key.startsWith("."))
    ) {
      for (const [subpath, value] of Object.entries(exports))
        targets(value, subpath === ".", "runtime", true);
    } else targets(exports, true, "runtime", true);
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
      for (const [original, replacement] of Object.entries(manifest.browser))
        if (replacement && replacement.startsWith(".") && resolve(root, original) === current.path)
          enqueue(replacement, "runtime", true, root, false, true);
    }
    const commonjs = commonjsModule(current.path);
    const text = readFileSync(current.path, "utf8");
    const source = ts.createSourceFile(
      current.path,
      commonjs ? text : `${text}\nexport {};`,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const edge of importEdges(source, current.kind, commonjs)) {
      const required = current.required && edge.required;
      const executionRequired = required && !edge.resolutionOnly;
      for (const { specifier, kind } of resolvePackageImport(
        edge.specifier,
        manifest.imports,
        edge.kind,
        edge.probe === "commonjs" ? "require" : "import",
      )) {
        if (specifier.startsWith(".")) {
          enqueue(
            specifier,
            kind,
            executionRequired && kind === "runtime",
            edge.specifier.startsWith("#") ? root : dirname(current.path),
            edge.probe || kind === "types" || /\.(?:[cm]?ts|tsx|jsx)$/.test(current.path),
            false,
            /\.(?:[cm]?ts|tsx)$/.test(current.path),
          );
          continue;
        }
        const packageName = edge.typeReference ? specifier : externalPackageName(specifier);
        if (!packageName) continue;
        if (packageName === manifest.name) {
          const exports = manifest.exports;
          const entries =
            exports &&
            typeof exports === "object" &&
            !Array.isArray(exports) &&
            Object.keys(exports).some((key) => key.startsWith("."))
              ? exports
              : { ".": exports ?? manifest.main };
          const aliases = Object.fromEntries(
            Object.entries(entries).map(([key, value]) => [`#self${key.slice(1)}`, value]),
          );
          for (const target of resolvePackageImport(
            `#self${specifier.slice(packageName.length)}`,
            aliases,
            kind,
            edge.probe === "commonjs" ? "require" : "import",
            new Set(),
            root,
          )) {
            if (target.specifier.startsWith("."))
              enqueue(
                target.specifier,
                target.kind,
                executionRequired && target.kind === "runtime",
                root,
                exports === undefined ? "main" : false,
              );
          }
          continue;
        }
        const position = source.getLineAndCharacterOfPosition(edge.start);
        references.push({
          specifier,
          packageName,
          typeReference: edge.typeReference ?? false,
          kind,
          required: required && kind === "runtime",
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
      .some((segment) => /^(\.|\.\.|node_modules)$/i.test(segment)) &&
    !relative(root, resolve(root, value)).startsWith("../")
  );
}

function resolvePackageImport(
  specifier: string,
  imports: PackageManifest["imports"],
  kind: PackageReference["kind"],
  mode: "import" | "require",
  seen = new Set<string>(),
  selfRoot?: string,
): { specifier: string; kind: PackageReference["kind"] }[] {
  if (!specifier.startsWith("#")) return [{ specifier, kind }];
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
  ): { specifier: string; kind: PackageReference["kind"] }[] | undefined {
    if (value === null) return [];
    if (typeof value === "string") {
      if (selfRoot && !validExportTarget(value, selfRoot)) return undefined;
      return resolvePackageImport(
        value.replaceAll("*", wildcard),
        imports,
        targetKind,
        mode,
        new Set(seen),
        selfRoot,
      );
    }
    if (Array.isArray(value)) {
      let selected: ReturnType<typeof flatten> = value.length ? undefined : [];
      for (const entry of value) {
        const targets = flatten(entry, targetKind);
        if (targets?.length) return targets;
        if (targets !== undefined) selected = targets;
      }
      return selected;
    }
    if (isRecord(value)) {
      for (const [condition, entry] of Object.entries(value)) {
        const types = condition === "types" || condition.startsWith("types@");
        if (
          condition !== "default" &&
          condition !== "node" &&
          condition !== mode &&
          !(types && targetKind === "types")
        )
          continue;
        const targets = flatten(entry, types ? "types" : targetKind);
        if (targets !== undefined) return targets;
      }
    }
    return undefined;
  }
  return flatten(target) ?? [];
}

function importEdges(
  source: ts.SourceFile,
  kind: "runtime" | "types",
  commonjs: boolean,
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  function add(
    literal: ts.Node | undefined,
    typeOnly: boolean,
    required: boolean,
    probe: boolean | "commonjs" = false,
    resolutionOnly = false,
  ) {
    while (literal && ts.isParenthesizedExpression(literal)) literal = literal.expression;
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    edges.push({
      specifier: literal.text,
      start: literal.getStart(source),
      end: literal.end,
      kind: typeOnly ? "types" : kind,
      required: !typeOnly && required,
      probe,
      resolutionOnly,
    });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly = Boolean(
        clause?.isTypeOnly ||
        (!clause?.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length &&
          named.elements.every((item) => item.isTypeOnly)),
      );
      add(node.moduleSpecifier, typeOnly, true);
    } else if (ts.isExportDeclaration(node)) {
      const typeOnly = Boolean(
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length &&
          node.exportClause.elements.every((item) => item.isTypeOnly)),
      );
      add(node.moduleSpecifier, typeOnly, true);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, node.isTypeOnly, true, "commonjs");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true, false);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node.arguments[0], false, isUnconditional(node, true));
      else if (
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          !shadowsRequire(node)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "module" &&
          node.expression.name.text === "require" &&
          commonjs &&
          !shadowsName(node, "module"))
      )
        add(node.arguments[0], false, isUnconditional(node, false), "commonjs");
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        node.expression.name.text === "resolve" &&
        !shadowsRequire(node)
      )
        add(node.arguments[0], false, isUnconditional(node, false), "commonjs", true);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const jsdoc = /\/\*\*[\s\S]*?\*\//g;
  for (let comment; (comment = jsdoc.exec(source.text));) {
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
  for (const ref of source.typeReferenceDirectives)
    edges.push({
      specifier: ref.fileName,
      start: ref.pos,
      end: ref.end,
      kind: "types",
      required: false,
      typeReference: true,
    });
  for (const ref of source.referencedFiles)
    edges.push({
      specifier: ref.fileName.startsWith(".") ? ref.fileName : `./${ref.fileName}`,
      start: ref.pos,
      end: ref.end,
      kind: "types",
      required: false,
    });
  return edges;
}

function isDecoratorExpression(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current = node.parent; current && current !== ancestor; current = current.parent)
    if (ts.isDecorator(current))
      return (
        current.parent === ancestor ||
        (ts.isParameter(current.parent) && current.parent.parent === ancestor)
      );
  return false;
}

function isNonAbruptElement(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isNonAbruptElement(node.expression);
  return (
    ts.isLiteralExpression(node) ||
    isUndefined(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    (ts.isArrayLiteralExpression(node) && node.elements.every(isNonAbruptElement)) ||
    (ts.isObjectLiteralExpression(node) &&
      node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          literalPropertyName(property.name) !== undefined &&
          isNonAbruptElement(property.initializer),
      )) ||
    ts.isOmittedExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!))
  );
}

function isNonCallable(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    isUndefined(node) ||
    ts.isLiteralExpression(node) ||
    ((ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) &&
      isNonAbruptElement(node)) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  );
}

function isImmediateField(field: ts.PropertyDeclaration): boolean {
  const owner = field.parent;
  if (!ts.isClassExpression(owner) || owner.heritageClauses?.length || owner.modifiers?.length)
    return false;
  let expression: ts.Node = owner;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const call = expression.parent;
  if (
    !ts.isNewExpression(call) ||
    call.expression !== expression ||
    !(call.arguments ?? []).every(isNonAbruptElement)
  )
    return false;
  for (const member of owner.members) {
    if (
      (member.name && ts.isComputedPropertyName(member.name)) ||
      ts.isClassStaticBlockDeclaration(member) ||
      (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length)
    )
      return false;
    if (
      ts.isPropertyDeclaration(member) &&
      member !== field &&
      member.initializer &&
      (member.pos < field.pos ||
        member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) &&
      !isNonAbruptElement(member.initializer)
    )
      return false;
  }
  return true;
}

function isUnconditional(node: ts.CallExpression, dynamic: boolean): boolean {
  if (ts.isCallChain(node)) return false;
  let expression: ts.Node = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const awaitedCalls = new Set<ts.CallExpression>();
  if (dynamic && ts.isArrayLiteralExpression(expression.parent)) {
    const elements = expression.parent.elements;
    if (!elements.slice(0, elements.indexOf(expression as ts.Expression)).every(isNonAbruptElement))
      return false;
    let array: ts.Node = expression.parent;
    while (ts.isParenthesizedExpression(array.parent)) array = array.parent;
    const call = array.parent;
    if (
      ts.isCallExpression(call) &&
      !ts.isCallChain(call) &&
      call.arguments.length === 1 &&
      call.arguments[0] === array &&
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "Promise" &&
      call.expression.name.text === "all" &&
      !shadowsName(call, "Promise")
    ) {
      awaitedCalls.add(call);
      expression = call;
      while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
    }
  }
  while (dynamic && ts.isPropertyAccessExpression(expression.parent)) {
    const member = expression.parent;
    const call = member.parent;
    if (
      member.expression !== expression ||
      !["then", "finally"].includes(member.name.text) ||
      !ts.isCallExpression(call) ||
      ts.isCallChain(call) ||
      call.expression !== member ||
      (member.name.text === "then"
        ? call.arguments.length > 2 || (call.arguments[1] && !isNonCallable(call.arguments[1]))
        : call.arguments.length > 1) ||
      !call.arguments.every(isNonAbruptElement)
    )
      break;
    awaitedCalls.add(call);
    expression = call;
    while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  }
  if (dynamic && !ts.isAwaitExpression(expression.parent)) {
    let returned: ts.Node = expression;
    if (ts.isReturnStatement(returned.parent)) returned = returned.parent;
    const body = returned.parent;
    const immediate = ts.isBlock(body) ? body.parent : body;
    if (
      !(ts.isFunctionExpression(immediate) || ts.isArrowFunction(immediate)) ||
      !isImmediateInvocation(immediate, node, true)
    )
      return false;
    let callee: ts.Node = immediate;
    while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
    const invocation = callee.parent;
    if (!ts.isCallExpression(invocation) || !ts.isAwaitExpression(invocation.parent)) return false;
    awaitedCalls.add(invocation);
  }
  if (dynamic) {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (!ts.isArrowFunction(ancestor) && !ts.isFunctionExpression(ancestor)) continue;
      if (!isImmediateInvocation(ancestor, node, true)) break;
      let callee: ts.Node = ancestor;
      while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
      const invocation = callee.parent;
      if (ts.isCallExpression(invocation) && ts.isAwaitExpression(invocation.parent))
        awaitedCalls.add(invocation);
    }
  }
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      (ts.isFunctionLike(parent) &&
        !isDecoratorExpression(node, parent) &&
        !(parent.name && isWithin(node, parent.name)) &&
        !isImmediateInvocation(parent, node, dynamic)) ||
      (ts.isPropertyDeclaration(parent) &&
        !isDecoratorExpression(node, parent) &&
        !(parent.name && isWithin(node, parent.name)) &&
        !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
        !isImmediateField(parent)) ||
      (ts.isIfStatement(parent) && !isWithin(node, parent.expression)) ||
      (ts.isConditionalExpression(parent) && !isWithin(node, parent.condition)) ||
      (ts.isSwitchStatement(parent) && !isWithin(node, parent.expression)) ||
      (ts.isWhileStatement(parent) && !isWithin(node, parent.expression)) ||
      (ts.isDoStatement(parent) &&
        !isWithin(node, parent.statement) &&
        hasAbruptCompletion(parent.statement)) ||
      (ts.isForStatement(parent) &&
        !(parent.initializer && isWithin(node, parent.initializer)) &&
        !(parent.condition && isWithin(node, parent.condition))) ||
      ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
        !isWithin(node, parent.expression)) ||
      (ts.isTryStatement(parent) &&
        ((parent.catchClause &&
          (isWithin(node, parent.tryBlock) || isWithin(node, parent.catchClause))) ||
          (parent.finallyBlock &&
            !isWithin(node, parent.finallyBlock) &&
            hasAbruptCompletion(parent.finallyBlock, false)))) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.AmpersandAmpersandEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken,
        ].includes(parent.operatorToken.kind) &&
        isWithin(node, parent.right)) ||
      ((ts.isCallChain(parent) || ts.isElementAccessChain(parent)) &&
        !isWithin(node, parent.expression))
    )
      return false;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const index = parent.statements.findIndex((statement) => isWithin(node, statement));
      if (
        parent.statements
          .slice(0, index)
          .some(
            (statement) => isDefinitelyAbrupt(statement) || hasAbruptCompletion(statement, false),
          )
      )
        return false;
    }
    if (dynamic && ts.isCallExpression(parent) && !awaitedCalls.has(parent)) return false;
  }
  return true;
}

function isDefinitelyAbrupt(statement: ts.Statement): boolean {
  if (
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isForStatement(statement)
  ) {
    let condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
    while (condition && ts.isParenthesizedExpression(condition)) condition = condition.expression;
    return (
      (!condition || condition.kind === ts.SyntaxKind.TrueKeyword) &&
      !hasAbruptCompletion(statement.statement)
    );
  }
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  )
    return true;
  if (
    ts.isTryStatement(statement) &&
    statement.finallyBlock &&
    isDefinitelyAbrupt(statement.finallyBlock)
  )
    return true;
  if (ts.isBlock(statement)) return statement.statements.some(isDefinitelyAbrupt);
  if (ts.isIfStatement(statement))
    return (
      !!statement.elseStatement &&
      isDefinitelyAbrupt(statement.thenStatement) &&
      isDefinitelyAbrupt(statement.elseStatement)
    );
  return false;
}

function literalTruthiness(node: ts.Expression): boolean | undefined {
  if (ts.isParenthesizedExpression(node)) return literalTruthiness(node.expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword)
    return false;
  if (ts.isStringLiteralLike(node)) return Boolean(node.text);
  if (ts.isNumericLiteral(node)) return Boolean(Number(node.text));
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = literalTruthiness(node.operand);
    return value === undefined ? undefined : !value;
  }
  return undefined;
}

function hasAbruptCompletion(statement: ts.Statement, includeThrow = true): boolean {
  let abrupt = false;
  function visit(node: ts.Node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isIfStatement(node)) {
      visit(node.expression);
      const condition = literalTruthiness(node.expression);
      if (condition !== false) visit(node.thenStatement);
      if (condition !== true && node.elseStatement) visit(node.elseStatement);
      return;
    }
    if (
      (ts.isWhileStatement(node) && literalTruthiness(node.expression) === false) ||
      (ts.isForStatement(node) && node.condition && literalTruthiness(node.condition) === false)
    )
      return;
    if (ts.isTryStatement(node) && node.finallyBlock && isDefinitelyAbrupt(node.finallyBlock)) {
      visit(node.finallyBlock);
      return;
    }
    if (ts.isReturnStatement(node) || (includeThrow && ts.isThrowStatement(node))) abrupt = true;
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      let target = node.parent;
      while (target) {
        if (
          node.label
            ? ts.isLabeledStatement(target) && target.label.text === node.label.text
            : ts.isIterationStatement(target, false) ||
              (ts.isBreakStatement(node) && ts.isSwitchStatement(target))
        )
          break;
        target = target.parent;
      }
      if (target && !isWithin(target, statement)) {
        const loop = ts.isLabeledStatement(target) ? target.statement : target;
        if (ts.isBreakStatement(node) || loop !== statement.parent) abrupt = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return abrupt;
}

function isImmediateInvocation(
  node: ts.SignatureDeclaration,
  load: ts.Node,
  allowAwaitedAsync = false,
): boolean {
  if (
    !(
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node)
    ) ||
    node.asteriskToken
  )
    return false;
  let expression: ts.Node = ts.isConstructorDeclaration(node) ? node.parent : node;
  if (ts.isConstructorDeclaration(node) && !ts.isClassExpression(expression)) return false;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  let method: string | undefined;
  if (
    ts.isPropertyAccessExpression(expression.parent) &&
    expression.parent.expression === expression &&
    ["call", "apply"].includes(expression.parent.name.text)
  ) {
    method = expression.parent.name.text;
    expression = expression.parent;
    while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  }
  const call = expression.parent;
  if (
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    !(allowAwaitedAsync && ts.isCallExpression(call) && ts.isAwaitExpression(call.parent))
  )
    return false;
  if (
    !(ts.isCallExpression(call) || ts.isNewExpression(call)) ||
    ts.isCallChain(call) ||
    call.expression !== expression ||
    (ts.isConstructorDeclaration(node) && !ts.isNewExpression(call)) ||
    (ts.isNewExpression(call) && (method || ts.isArrowFunction(node)))
  )
    return false;
  if (!(call.arguments ?? []).every(isNonAbruptElement)) return false;
  if (ts.isNewExpression(call)) {
    if (ts.isConstructorDeclaration(node)) {
      const owner = node.parent;
      if (
        owner.heritageClauses?.length ||
        owner.modifiers?.length ||
        owner.members.some(
          (member) =>
            (member.name && ts.isComputedPropertyName(member.name)) ||
            ts.isClassStaticBlockDeclaration(member) ||
            (ts.isPropertyDeclaration(member) &&
              member.initializer &&
              !isNonAbruptElement(member.initializer)) ||
            (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length),
        )
      )
        return false;
    }
  }
  const index = node.parameters.findIndex((parameter) => isWithin(load, parameter));
  if (call.arguments?.some(ts.isSpreadElement)) return false;
  let args: readonly ts.Expression[] = call.arguments ?? [];
  if (method === "call") args = args.slice(1);
  if (method === "apply") {
    let list = args[1];
    while (list && ts.isParenthesizedExpression(list)) list = list.expression;
    if (!list || isUndefined(list) || list.kind === ts.SyntaxKind.NullKeyword) args = [];
    else if (ts.isArrayLiteralExpression(list) && !list.elements.some(ts.isSpreadElement))
      args = list.elements;
    else return false;
  }
  for (const [offset, parameter] of node.parameters.entries()) {
    if (offset === index) break;
    if (!ts.isIdentifier(parameter.name)) return false;
    if (
      isUndefined(args[offset]) &&
      parameter.initializer &&
      !isNonAbruptElement(parameter.initializer)
    )
      return false;
  }
  if (node.body && isWithin(load, node.body)) return true;
  if (index < 0) return false;
  const parameter = node.parameters[index]!;
  const value = args[index];
  return bindingDefaultExecutes(
    parameter,
    value && !ts.isOmittedExpression(value) ? value : undefined,
    load,
  );
}

function isUndefined(value: ts.Expression | undefined): boolean {
  if (!value || ts.isOmittedExpression(value)) return true;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  return (
    (ts.isVoidExpression(value) && ts.isNumericLiteral(value.expression)) ||
    (ts.isIdentifier(value) && value.text === "undefined" && !shadowsName(value, "undefined"))
  );
}

function literalPropertyName(name: ts.Node): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    name = name.expression;
    while (ts.isParenthesizedExpression(name)) name = name.expression;
    if (!ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) return undefined;
  }
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function bindingDefaultExecutes(
  binding: ts.ParameterDeclaration | ts.BindingElement,
  value: ts.Expression | undefined,
  load: ts.Node,
): boolean {
  if (isUndefined(value) && binding.initializer) {
    if (isWithin(load, binding.initializer)) return true;
    value = binding.initializer;
  }
  if (!value || ts.isIdentifier(binding.name)) return false;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (ts.isObjectBindingPattern(binding.name) && ts.isObjectLiteralExpression(value)) {
    if (
      value.properties.some(
        (property) =>
          !ts.isPropertyAssignment(property) ||
          literalPropertyName(property.name) === undefined ||
          (!ts.isComputedPropertyName(property.name) &&
            literalPropertyName(property.name) === "__proto__"),
      )
    )
      return false;
    for (const element of binding.name.elements) {
      if (element.dotDotDotToken || !isWithin(load, element)) continue;
      const name = literalPropertyName(element.propertyName ?? element.name);
      if (name === undefined) return false;
      const property = [...value.properties]
        .reverse()
        .find(
          (property) =>
            ts.isPropertyAssignment(property) && literalPropertyName(property.name) === name,
        );
      if (!property && Object.hasOwn(Object.prototype, name)) return false;
      return bindingDefaultExecutes(
        element,
        property && ts.isPropertyAssignment(property) ? property.initializer : undefined,
        load,
      );
    }
  }
  if (ts.isArrayBindingPattern(binding.name) && ts.isArrayLiteralExpression(value)) {
    if (value.elements.some(ts.isSpreadElement)) return false;
    for (const [index, element] of binding.name.elements.entries()) {
      if (!ts.isBindingElement(element) || element.dotDotDotToken || !isWithin(load, element))
        continue;
      const item = value.elements[index];
      return bindingDefaultExecutes(
        element,
        item && !ts.isOmittedExpression(item) ? item : undefined,
        load,
      );
    }
  }
  return false;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

function shadowsRequire(node: ts.Node): boolean {
  return shadowsName(node, "require");
}

function bindingContains(declaration: ts.VariableDeclaration, node: ts.Node): boolean {
  const blockScoped =
    !ts.isVariableDeclarationList(declaration.parent) ||
    Boolean(declaration.parent.flags & ts.NodeFlags.BlockScoped);
  for (let scope: ts.Node | undefined = declaration.parent; scope; scope = scope.parent) {
    if (
      ts.isSourceFile(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isFunctionLike(scope) ||
      (blockScoped &&
        (ts.isBlock(scope) ||
          ts.isCatchClause(scope) ||
          ts.isForStatement(scope) ||
          ts.isForInStatement(scope) ||
          ts.isForOfStatement(scope) ||
          ts.isCaseBlock(scope)))
    )
      return isWithin(node, scope);
  }
  return false;
}

function shadowsName(node: ts.Node, identifier: string): boolean {
  function binds(name: ts.BindingName): boolean {
    return ts.isIdentifier(name)
      ? name.text === identifier
      : name.elements.some((element) => ts.isBindingElement(element) && binds(element.name));
  }
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionExpression(scope) && scope.name?.text === identifier) return true;
    if (ts.isFunctionLike(scope) && scope.parameters.some((param) => binds(param.name)))
      return true;
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      binds(scope.variableDeclaration.name)
    )
      return true;
    if (!ts.isSourceFile(scope) && !ts.isBlock(scope) && !ts.isModuleBlock(scope)) continue;
    let found = false;
    function search(child: ts.Node) {
      if (
        (ts.isVariableDeclaration(child) && binds(child.name) && bindingContains(child, node)) ||
        ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) &&
          child.name?.text === identifier) ||
        (ts.isImportClause(child) && child.name?.text === identifier) ||
        ((ts.isImportSpecifier(child) ||
          ts.isNamespaceImport(child) ||
          ts.isImportEqualsDeclaration(child)) &&
          child.name.text === identifier)
      )
        found = true;
      if (
        child !== scope &&
        (ts.isBlock(child) ||
          ts.isModuleBlock(child) ||
          ts.isFunctionLike(child) ||
          ts.isClassLike(child))
      )
        return;
      ts.forEachChild(child, search);
    }
    ts.forEachChild(scope, search);
    if (found) return true;
  }
  return false;
}
