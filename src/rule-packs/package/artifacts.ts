import { isBuiltin } from "node:module";
import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "pathe";
import ts from "typescript";
import type { ProjectInfo, SourceRange } from "../../core/primitives.js";

export interface PackageManifest {
  name?: string;
  private?: boolean;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  types?: string;
  typings?: string;
  exports?: unknown;
  imports?: Record<string, unknown>;
  bin?: string | Record<string, string>;
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
  probe?: boolean;
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

function recordOf(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(valid);
}

function isPackageManifest(value: unknown): value is PackageManifest {
  if (!isRecord(value)) return false;
  const fields: Record<string, (entry: unknown) => boolean> = {
    name: isString,
    private: (entry) => typeof entry === "boolean",
    main: isString,
    module: isString,
    browser: (entry) =>
      isString(entry) || recordOf(entry, (target) => isString(target) || target === false),
    types: isString,
    typings: isString,
    imports: isRecord,
    bin: (entry) => isString(entry) || recordOf(entry, isString),
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
  return Object.entries(fields).every(
    ([key, valid]) => value[key] === undefined || valid(value[key]),
  );
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
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isPackageManifest(manifest))
    throw new TypeError(`Invalid package manifest: ${manifestPath}`);
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

  function enqueue(
    target: string,
    kind: "runtime" | "types",
    required: boolean,
    from = root,
    probe = true,
    adjacentDeclaration = false,
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
        : [
            path,
            ...[
              ".js",
              ".mjs",
              ".cjs",
              ".ts",
              ".mts",
              ".cts",
              ".jsx",
              ".tsx",
              "/index.js",
              "/index.mjs",
              "/index.cjs",
              "/index.ts",
              "/index.mts",
              "/index.cts",
              "/index.jsx",
              "/index.tsx",
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
  ) {
    if (typeof value === "string") enqueue(value, kind, required, root, false, adjacentDeclaration);
    else if (Array.isArray(value)) {
      const fallbackMissing = new Set(missing);
      for (const item of value) {
        const beforeQueue = queue.length;
        targets(item, required, kind, adjacentDeclaration);
        if (queue.length > beforeQueue) {
          for (const entry of missing) if (!fallbackMissing.has(entry)) missing.delete(entry);
          break;
        }
      }
    } else if (value && typeof value === "object") {
      for (const [condition, item] of Object.entries(value))
        targets(
          item,
          required,
          condition === "types" || condition.startsWith("types@") ? "types" : kind,
          adjacentDeclaration,
        );
    }
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
  for (const entry of [manifest.main, manifest.module])
    if (entry) enqueue(entry, "runtime", true, root, false, true);
  if (typeof manifest.browser === "string")
    enqueue(manifest.browser, "runtime", true, root, false, true);
  else if (manifest.browser)
    for (const entry of Object.values(manifest.browser))
      if (entry && entry.startsWith(".")) enqueue(entry, "runtime", false, root, false, true);
  for (const entry of [manifest.types, manifest.typings])
    if (entry) enqueue(entry, "types", false, root, false);
  if (typeof manifest.bin === "string") enqueue(manifest.bin, "runtime", false, root, false, true);
  else if (manifest.bin)
    for (const entry of Object.values(manifest.bin))
      enqueue(entry, "runtime", false, root, false, true);
  for (const version of Object.values(manifest.typesVersions ?? {}))
    for (const entries of Object.values(version))
      for (const entry of entries) enqueue(entry, "types", false, root, false);

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const key = `${current.path}:${current.kind}:${current.required}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const source = ts.createSourceFile(
      current.path,
      readFileSync(current.path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const edge of importEdges(source, current.kind)) {
      const required = current.required && edge.required;
      for (const specifier of resolvePackageImport(edge.specifier, manifest.imports)) {
        if (specifier.startsWith(".")) {
          enqueue(
            specifier,
            edge.kind,
            required,
            edge.specifier.startsWith("#") ? root : dirname(current.path),
            edge.kind === "types" ||
              edge.probe === true ||
              /\.(?:[cm]?ts|tsx|jsx)$/.test(current.path),
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
          )) {
            if (target.startsWith(".")) enqueue(target, edge.kind, required);
          }
          continue;
        }
        const position = source.getLineAndCharacterOfPosition(edge.start);
        references.push({
          specifier,
          packageName,
          typeReference: edge.typeReference ?? false,
          kind: edge.kind,
          required,
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

function externalPackageName(specifier: string): string | null {
  if (!specifier || isBuiltin(specifier) || /^(?:[.#/]|[a-zA-Z][\w+.-]*:)/.test(specifier))
    return null;
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
}

function resolvePackageImport(
  specifier: string,
  imports: PackageManifest["imports"],
  seen = new Set<string>(),
): string[] {
  if (!specifier.startsWith("#")) return [specifier];
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
  function flatten(value: unknown): string[] {
    if (typeof value === "string")
      return resolvePackageImport(value.replaceAll("*", wildcard), imports, new Set(seen));
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (value && typeof value === "object") return Object.values(value).flatMap(flatten);
    return [];
  }
  return flatten(target);
}

function importEdges(source: ts.SourceFile, kind: "runtime" | "types"): ImportEdge[] {
  const edges: ImportEdge[] = [];
  function add(literal: ts.Node | undefined, typeOnly: boolean, required: boolean, probe = false) {
    while (literal && ts.isParenthesizedExpression(literal)) literal = literal.expression;
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    edges.push({
      specifier: literal.text,
      start: literal.getStart(source),
      end: literal.end,
      kind: typeOnly ? "types" : kind,
      required: !typeOnly && required,
      probe,
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
      add(node.moduleReference.expression, node.isTypeOnly, true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true, false);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node.arguments[0], false, isUnconditional(node, true));
      else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        !shadowsRequire(node)
      )
        add(node.arguments[0], false, isUnconditional(node, false), true);
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        node.expression.name.text === "resolve" &&
        !shadowsRequire(node)
      )
        add(node.arguments[0], false, isUnconditional(node, false), true);
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

function isUnconditional(node: ts.CallExpression, dynamic: boolean): boolean {
  if (dynamic && !ts.isAwaitExpression(node.parent)) return false;
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isFunctionLike(parent) ||
      ts.isClassLike(parent) ||
      (ts.isIfStatement(parent) && !isWithin(node, parent.expression)) ||
      (ts.isConditionalExpression(parent) && !isWithin(node, parent.condition)) ||
      (ts.isSwitchStatement(parent) && !isWithin(node, parent.expression)) ||
      ts.isIterationStatement(parent, false) ||
      ts.isTryStatement(parent) ||
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
      ts.isCallChain(parent)
    )
      return false;
    if (dynamic && ts.isCallExpression(parent)) return false;
  }
  return true;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

function shadowsRequire(node: ts.Node): boolean {
  function binds(name: ts.BindingName): boolean {
    return ts.isIdentifier(name)
      ? name.text === "require"
      : name.elements.some((element) => ts.isBindingElement(element) && binds(element.name));
  }
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((param) => binds(param.name)))
      return true;
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      binds(scope.variableDeclaration.name)
    )
      return true;
    if (!ts.isSourceFile(scope) && !ts.isBlock(scope)) continue;
    let found = false;
    function search(child: ts.Node) {
      if (
        (ts.isVariableDeclaration(child) && binds(child.name)) ||
        ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) &&
          child.name?.text === "require") ||
        (ts.isImportClause(child) && child.name?.text === "require") ||
        ((ts.isImportSpecifier(child) ||
          ts.isNamespaceImport(child) ||
          ts.isImportEqualsDeclaration(child)) &&
          child.name.text === "require")
      )
        found = true;
      if (
        child !== scope &&
        (ts.isBlock(child) || ts.isFunctionLike(child) || ts.isClassLike(child))
      )
        return;
      ts.forEachChild(child, search);
    }
    ts.forEachChild(scope, search);
    if (found) return true;
  }
  return false;
}
