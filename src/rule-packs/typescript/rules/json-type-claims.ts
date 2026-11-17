import { dirname, join, resolve } from "pathe";
import { parseSync } from "oxc-parser";
import type { RuleContext } from "../../../core/index.js";
import type { AnyNode } from "./shared.js";

type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";
export type TypeScope = {
  file: string;
  aliases: Map<string, AnyNode>;
  exports: Map<string, string>;
  blocked: Array<{ name: string; start: number; end: number }>;
  imports: Map<string, { source: string; name: string }>;
  reexports: Array<{ source: string; names?: Map<string, string> }>;
};

const allKinds: JsonKind[] = ["null", "boolean", "number", "string", "array", "object"];
const keywordKinds: Record<string, JsonKind> = {
  TSNullKeyword: "null",
  TSBooleanKeyword: "boolean",
  TSNumberKeyword: "number",
  TSStringKeyword: "string",
};
// type-fest builds these from mapped types and intersections, so they are trusted by name.
const typeFestKinds: Record<string, JsonKind[]> = {
  JsonValue: allKinds,
  JsonObject: ["object"],
  JsonArray: ["array"],
};
const sourceExtensions = [".ts", ".mts", ".cts", ".tsx", ".d.ts", ".d.mts", ".d.cts"];
const maxImportDepth = 4;

/**
 * Whether a type claims nothing a deserialized JSON value can break: `unknown`, a JSON union, or a
 * container of those (`unknown[]`, `Record<string, unknown>`, an object whose properties are
 * `unknown`), optionally with `null` or `undefined`.
 */
export function isHonestJsonType(ctx: RuleContext, scope: TypeScope, type: AnyNode): boolean {
  const resolver = new TypeResolver(ctx);
  return resolver.isHonest(type, scope);
}

/** Whether a type admits both results of `Storage.getItem()`. */
export function acceptsStorageItem(ctx: RuleContext, scope: TypeScope, type: AnyNode): boolean {
  const kinds = new TypeResolver(ctx).storageKinds(type, scope);
  return kinds.has("string") && kinds.has("null");
}

export function createTypeScope(file: string, program: AnyNode): TypeScope {
  const scope: TypeScope = {
    file,
    aliases: new Map(),
    exports: new Map(),
    blocked: [],
    imports: new Map(),
    reexports: [],
  };
  const walk = (node: AnyNode, region: AnyNode = program) => {
    if (!node || typeof node !== "object") return;
    if (node.typeParameters?.params) {
      for (const parameter of node.typeParameters.params) {
        scope.blocked.push({
          name: parameter.name?.name ?? parameter.name,
          start: node.start,
          end: node.end,
        });
      }
    }
    if (
      [
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSModuleDeclaration",
      ].includes(node.type)
    ) {
      if (region !== program || node.type !== "TSTypeAliasDeclaration" || node.typeParameters) {
        scope.blocked.push({ name: node.id?.name, start: region.start, end: region.end });
      }
    }
    const next = /Function|BlockStatement|TSModuleBlock/.test(node.type ?? "") ? node : region;
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key.startsWith("__")) continue;
      if (Array.isArray(value)) value.forEach((child) => walk(child, next));
      else if (value && typeof value === "object") walk(value, next);
    }
  };
  walk(program);
  // Declaration modules implicitly export top-level declarations unless an export
  // declaration/assignment supplies an explicit export list. Export modifiers alone
  // do not disable this TypeScript declaration-file behavior.
  const implicitExports =
    /\.d\.[cm]?ts$/.test(file) &&
    !(program?.body ?? []).some(
      (statement: AnyNode) =>
        statement.type === "ExportAllDeclaration" ||
        statement.type === "TSExportAssignment" ||
        (statement.type === "ExportNamedDeclaration" && !statement.declaration),
    );
  for (const statement of program?.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if ((implicitExports || statement.type === "ExportNamedDeclaration") && declaration?.id?.name) {
      scope.exports.set(declaration.id.name, declaration.id.name);
    }
    if (declaration?.type === "TSTypeAliasDeclaration" && !declaration.typeParameters) {
      scope.aliases.set(declaration.id.name, declaration.typeAnnotation);
    }
    if (statement.type === "ImportDeclaration" && typeof statement.source?.value === "string") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.type !== "ImportSpecifier") continue;
        scope.imports.set(specifier.local.name, {
          source: statement.source.value,
          name: specifier.imported?.name ?? specifier.imported?.value,
        });
      }
    }
    if (statement.type === "ExportNamedDeclaration" && !statement.declaration) {
      const names = new Map<string, string>();
      for (const specifier of statement.specifiers ?? []) {
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        const local = specifier.local?.name ?? specifier.local?.value;
        if (typeof exported === "string" && typeof local === "string") names.set(exported, local);
      }
      if (typeof statement.source?.value === "string") {
        scope.reexports.push({ source: statement.source.value, names });
      } else {
        for (const [exported, local] of names) scope.exports.set(exported, local);
      }
    }
    if (statement.type === "ExportAllDeclaration" && !statement.exported) {
      if (typeof statement.source?.value === "string") {
        scope.reexports.push({ source: statement.source.value });
      }
    }
  }
  return scope;
}

class TypeResolver {
  private readonly seen = new Set<string>();
  private readonly assumptions = new Map<string, Set<JsonKind>>();
  private evaluating = false;

  isHonest(type: AnyNode, scope: TypeScope, seen = new Set<string>()): boolean {
    if (this.isFull(type, scope)) return true;
    if (type?.type === "TSParenthesizedType")
      return this.isHonest(type.typeAnnotation, scope, seen);
    if (type?.type === "TSTypeOperator")
      return type.operator === "readonly" && this.isHonest(type.typeAnnotation, scope, seen);
    if (type?.type === "TSUnionType") {
      return (
        type.types.some((member: AnyNode) => !isNullish(member)) &&
        type.types.every(
          (member: AnyNode) => isNullish(member) || this.isHonest(member, scope, seen),
        )
      );
    }
    if (type?.type === "TSTypeReference" && !type.typeArguments?.params?.length) {
      const name = type.typeName?.name;
      if (this.isBlocked(type, scope)) return false;
      const key = `${scope.file}#${name}`;
      if (seen.has(key)) return false;
      return this.honestNamed(name, scope, new Set([...seen, key]));
    }
    return this.isHonestContainer(type, scope);
  }

  private honestNamed(name: string, scope: TypeScope, seen: Set<string>): boolean {
    const alias = scope.aliases.get(name);
    if (alias) return this.isHonest(alias, scope, seen);
    const imported = scope.imports.get(name);
    const follow = (source: string, exported: string, from = scope, visited = seen): boolean => {
      if (source === "type-fest") return !!typeFestKinds[exported];
      const file = resolveModule(this.ctx, from.file, source);
      const target = file && readTypeScope(this.ctx, file);
      const key = `${file}#${exported}`;
      if (!target || visited.has(key) || visited.size >= maxImportDepth) return false;
      const local = target.exports.get(exported);
      if (local) return this.honestNamed(local, target, new Set([...visited, key]));
      const binding = this.reexportBinding(exported, target);
      return binding
        ? follow(binding.source, binding.name, target, new Set([...visited, key]))
        : false;
    };
    if (imported) return follow(imported.source, imported.name);
    const reexport = this.reexportBinding(name, scope);
    return reexport ? follow(reexport.source, reexport.name) : false;
  }

  // Explicit exports override stars. Binding identity must never depend on provisional coverage.
  private reexportBinding(
    name: string,
    scope: TypeScope,
    seen = new Set<string>(),
  ): { source: string; name: string } | undefined {
    const key = `${scope.file}#${name}`;
    if (seen.has(key) || seen.size >= maxImportDepth) return undefined;
    const next = new Set([...seen, key]);
    for (const entry of scope.reexports) {
      const local = entry.names?.get(name);
      if (local) return { source: entry.source, name: local };
    }
    for (const entry of scope.reexports) {
      if (entry.names) continue;
      if (entry.source === "type-fest" && typeFestKinds[name])
        return { source: entry.source, name };
      const file = resolveModule(this.ctx, scope.file, entry.source);
      const target = file && readTypeScope(this.ctx, file);
      if (target && (target.exports.has(name) || this.reexportBinding(name, target, next)))
        return { source: entry.source, name };
    }
    return undefined;
  }

  private isBlocked(type: AnyNode, scope: TypeScope): boolean {
    return scope.blocked.some(
      (binding) =>
        binding.name === type.typeName?.name &&
        type.start >= binding.start &&
        type.end <= binding.end,
    );
  }

  constructor(private readonly ctx: RuleContext) {}

  isFull(type: AnyNode, scope: TypeScope): boolean {
    const kinds = this.coverage(type, scope);
    return allKinds.every((kind) => kinds.has(kind));
  }

  isHonestContainer(type: AnyNode, scope: TypeScope): boolean {
    const kinds = this.kinds(type, scope);
    return kinds.size > 0 && [...kinds].every((kind) => kind === "array" || kind === "object");
  }

  storageKinds(type: AnyNode, scope: TypeScope): Set<JsonKind> {
    return this.coverage(type, scope);
  }

  private coverage(type: AnyNode, scope: TypeScope): Set<JsonKind> {
    if (this.evaluating) return this.kinds(type, scope);
    // A recursive back-edge is provisional until all reachable aliases stop losing kinds.
    this.evaluating = true;
    try {
      let previous = "";
      for (;;) {
        const result = this.kinds(type, scope);
        const state = JSON.stringify(
          [...this.assumptions].map(([key, kinds]) => [key, [...kinds]]),
        );
        if (state === previous) return result;
        previous = state;
      }
    } finally {
      this.evaluating = false;
    }
  }

  /** The JSON kinds a type accepts whole, where containers count only with honest contents. */
  kinds(type: AnyNode, scope: TypeScope): Set<JsonKind> {
    if (!type) return new Set();
    switch (type.type) {
      case "TSUnknownKeyword":
        return new Set(allKinds);
      case "TSParenthesizedType":
        return this.kinds(type.typeAnnotation, scope);
      case "TSUnionType":
        return new Set(type.types.flatMap((member: AnyNode) => [...this.kinds(member, scope)]));
      case "TSArrayType":
        return this.isFull(type.elementType, scope) ? new Set(["array"]) : new Set();
      case "TSTypeOperator":
        return type.operator === "readonly" ? this.kinds(type.typeAnnotation, scope) : new Set();
      case "TSTypeLiteral":
        return this.isHonestShape(type, scope) ? new Set(["object"]) : new Set();
      case "TSTypeReference":
        return this.referenceKinds(type, scope);
      default: {
        const kind = keywordKinds[type.type];
        return kind ? new Set([kind]) : new Set();
      }
    }
  }

  private isHonestShape(type: AnyNode, scope: TypeScope): boolean {
    if (!type.members?.length) return false;
    return type.members.every((member: AnyNode) => {
      const value = member.typeAnnotation?.typeAnnotation;
      if (member.type === "TSIndexSignature") {
        return (
          member.parameters?.[0]?.typeAnnotation?.typeAnnotation?.type === "TSStringKeyword" &&
          this.isFull(value, scope)
        );
      }
      if (member.type !== "TSPropertySignature") return false;
      if (this.isFull(value, scope)) return true;
      return (
        member.optional === true &&
        value?.type === "TSTypeLiteral" &&
        this.isHonestShape(value, scope)
      );
    });
  }

  private referenceKinds(type: AnyNode, scope: TypeScope): Set<JsonKind> {
    if (type.typeName?.type !== "Identifier") return new Set();
    const name = type.typeName.name;
    if (this.isBlocked(type, scope)) return new Set();
    const params = type.typeArguments?.params ?? [];
    if (!scope.aliases.has(name) && !scope.imports.has(name)) {
      if ((name === "Array" || name === "ReadonlyArray") && params.length === 1) {
        return this.isFull(params[0], scope) ? new Set(["array"]) : new Set();
      }
      if (name === "Record" && params.length === 2) {
        return params[0].type === "TSStringKeyword" && this.isFull(params[1], scope)
          ? new Set(["object"])
          : new Set();
      }
    }
    if (params.length) return new Set();
    return this.namedKinds(name, scope, 0);
  }

  private namedKinds(name: string, scope: TypeScope, depth: number): Set<JsonKind> {
    const key = `${scope.file}#${name}`;
    // Start recursive obligations at full coverage, then descend to a stable solution.
    if (this.seen.has(key)) return this.assumptions.get(key) ?? new Set(allKinds);
    const alias = scope.aliases.get(name);
    if (alias) {
      this.seen.add(key);
      try {
        const previous = this.assumptions.get(key) ?? new Set(allKinds);
        const result = new Set([...this.kinds(alias, scope)].filter((kind) => previous.has(kind)));
        this.assumptions.set(key, result);
        return result;
      } finally {
        this.seen.delete(key);
      }
    }
    const imported = scope.imports.get(name);
    if (imported) return this.importedKinds(imported.source, imported.name, scope.file, depth);
    const reexport = this.reexportBinding(name, scope);
    return reexport
      ? this.importedKinds(reexport.source, reexport.name, scope.file, depth)
      : new Set();
  }

  private importedKinds(
    source: string,
    name: string,
    importer: string,
    depth: number,
  ): Set<JsonKind> {
    if (source === "type-fest") return new Set(typeFestKinds[name] ?? []);
    if (depth >= maxImportDepth) return new Set();
    const file = resolveModule(this.ctx, importer, source);
    const scope = file && readTypeScope(this.ctx, file);
    if (!scope) return new Set();
    const local = scope.exports.get(name);
    if (local) return this.namedKinds(local, scope, depth + 1);
    const binding = this.reexportBinding(name, scope);
    return binding
      ? this.importedKinds(binding.source, binding.name, scope.file, depth + 1)
      : new Set();
  }
}

function isNullish(type: AnyNode): boolean {
  return type?.type === "TSNullKeyword" || type?.type === "TSUndefinedKeyword";
}

function readTypeScope(ctx: RuleContext, file: string): TypeScope | undefined {
  const key = `typescript:json-type-scope:${file}`;
  const cached = ctx.cache.get<TypeScope | null>(key);
  if (cached !== undefined) return cached ?? undefined;
  const text = ctx.fs.readText(file);
  let scope: TypeScope | null = null;
  if (text !== undefined) {
    const { program } = parseSync(file, text, {
      lang: /\.d\.[cm]?ts$/.test(file) ? "dts" : file.endsWith(".tsx") ? "tsx" : "ts",
      sourceType: "module",
      astType: "ts",
    });
    scope = createTypeScope(file, program);
  }
  ctx.cache.set(key, scope);
  return scope ?? undefined;
}

function resolveModule(ctx: RuleContext, importer: string, source: string): string | undefined {
  if (/^\.\.?(?:\/|$)/.test(source))
    return resolveSourceFile(ctx, resolve(dirname(importer), source));
  const match = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(source);
  if (!match) return undefined;
  const [, packageName, rest] = match;
  for (let dir = dirname(importer); ; dir = dirname(dir)) {
    const packageDir = join(dir, "node_modules", packageName!);
    const manifest = ctx.fs.readJson(join(packageDir, "package.json"));
    if (manifest && typeof manifest === "object") {
      return resolvePackageEntry(
        ctx,
        packageDir,
        manifest as Record<string, unknown>,
        `.${rest ?? ""}`,
      );
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function resolvePackageEntry(
  ctx: RuleContext,
  packageDir: string,
  manifest: Record<string, unknown>,
  subpath: string,
): string | undefined {
  const exports = manifest.exports;
  const entry =
    exports && typeof exports === "object" && !Array.isArray(exports) && !subpath.startsWith("..")
      ? ((exports as Record<string, unknown>)[subpath] ??
        (subpath === "." && !Object.keys(exports).some((key) => key.startsWith("."))
          ? exports
          : undefined))
      : typeof exports === "string" && subpath === "."
        ? exports
        : undefined;
  const targets = [
    ...entryTargets(entry),
    ...(subpath === "." ? [manifest.types, manifest.typings, manifest.module, manifest.main] : []),
  ].filter((target): target is string => typeof target === "string");
  for (const target of targets) {
    const file = resolveSourceFile(ctx, resolve(packageDir, target));
    if (file) return file;
    // Workspace packages often export unbuilt `dist` files whose source sits under `src`.
    const source = resolve(
      packageDir,
      target.replace(/^\.?\/?(?:dist|lib|build|out|esm|cjs)\//, "src/"),
    );
    const sourceFile = resolveSourceFile(ctx, source);
    if (sourceFile) return sourceFile;
  }
  if (subpath !== "." && !exports) return resolveSourceFile(ctx, resolve(packageDir, subpath));
  return undefined;
}

function entryTargets(entry: unknown): unknown[] {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const conditions = entry as Record<string, unknown>;
  return ["types", "import", "default", "require", "node"].flatMap((key) =>
    entryTargets(conditions[key]),
  );
}

function resolveSourceFile(ctx: RuleContext, base: string): string | undefined {
  const stem = base.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "");
  const candidates = [
    ...(/\.(?:d\.)?[cm]?tsx?$/.test(base) ? [base] : []),
    ...sourceExtensions.map((extension) => stem + extension),
    ...sourceExtensions.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => ctx.fs.stat(candidate)?.isFile());
}
