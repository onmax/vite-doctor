import { dirname, relative, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule, sourceForNode } from "./shared.js";
import {
  NUXT_KIT_SOURCES,
  findProperty,
  isRelativePath,
  moduleDefinitionScope,
  pathExistsFrom,
  staticStringValue,
  unwrapExpression,
} from "./module-authoring.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/module/resolve-runtime-paths";

type PathArgument =
  | { kind: "string-or-object"; key: string }
  | { kind: "object"; key: string }
  | { kind: "strings" }
  | { kind: "objects"; key: string };

const PATH_HELPERS: Record<string, PathArgument> = {
  addPlugin: { kind: "string-or-object", key: "src" },
  addPluginTemplate: { kind: "string-or-object", key: "src" },
  addTemplate: { kind: "string-or-object", key: "src" },
  addTypeTemplate: { kind: "string-or-object", key: "src" },
  addLayout: { kind: "string-or-object", key: "src" },
  addComponent: { kind: "object", key: "filePath" },
  addComponentExports: { kind: "object", key: "filePath" },
  addComponentsDir: { kind: "object", key: "path" },
  addImportsDir: { kind: "strings" },
  addImports: { kind: "objects", key: "from" },
  addServerHandler: { kind: "object", key: "handler" },
  addDevServerHandler: { kind: "object", key: "handler" },
  addServerPlugin: { kind: "strings" },
  addServerImportsDir: { kind: "strings" },
  addServerImports: { kind: "objects", key: "from" },
  addServerScanDir: { kind: "strings" },
  addRouteMiddleware: { kind: "objects", key: "path" },
};

interface ResolverBinding {
  expression: string;
  declarator: AnyNode;
  scope: AnyNode;
}

export const moduleResolveRuntimePaths = createRule({
  meta: {
    id: RULE_ID,
    title: "Resolve module runtime paths with createResolver",
    category: "modules",
    severity: "error",
    fixable: "safe",
    docsUrl: "https://nuxt.com/docs/4.x/api/kit/resolving#createresolver",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const definition = moduleDefinitionScope(ctx);
    if (!definition) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const { helpers, createResolverNames } = collectKitImports(node);
        if (!helpers.size) return;
        const parents = new Map<AnyNode, AnyNode>();
        const calls: AnyNode[] = [];
        const resolvers: ResolverBinding[] = [];
        walkWithParents(node, null, parents, (current) => {
          if (current.type === "CallExpression") calls.push(current);
          if (current.type === "VariableDeclarator") {
            const binding = resolverBinding(current, createResolverNames);
            if (binding) resolvers.push({ ...binding, scope: nearestScope(current, parents) });
          }
        });
        const fileDir = dirname(ctx.file.path);
        for (const call of calls) {
          const helper =
            call.callee?.type === "Identifier" ? helpers.get(call.callee.name) : undefined;
          if (!helper) continue;
          for (const { literal, option } of pathLiterals(
            call.arguments?.[0],
            PATH_HELPERS[helper]!,
          )) {
            const value = staticStringValue(literal)!;
            const existsNextToModule = pathExistsFrom(ctx.fs, fileDir, value);
            if (definition.kind === "local") {
              const appDir = ctx.project.nuxt?.appDir;
              const existsInProject =
                pathExistsFrom(ctx.fs, ctx.project.root, value) ||
                (appDir !== undefined && pathExistsFrom(ctx.fs, appDir, value));
              if (!existsNextToModule || existsInProject) continue;
            }
            const resolver = existsNextToModule
              ? resolvers.find((binding) => isUsableAt(binding, call, parents))
              : undefined;
            reportPath(ctx, { helper, option, literal, value, kind: definition.kind, resolver });
          }
        }
      },
    };
  },
});

function reportPath(
  ctx: RuleContext,
  {
    helper,
    option,
    literal,
    value,
    kind,
    resolver,
  }: {
    helper: string;
    option?: string;
    literal: AnyNode;
    value: string;
    kind: "package" | "local";
    resolver?: ResolverBinding;
  },
) {
  const raw = sourceForNode(literal, ctx.file.text);
  const where =
    kind === "package"
      ? "the project that installs this module, so the path breaks once the module is published"
      : `the project root instead of ${relative(ctx.project.root, resolve(dirname(ctx.file.path), value))}`;
  ctx.report(
    diagnostics.NUXT0082({
      why: `${helper}() receives the relative path ${raw}${option ? ` as ${option}` : ""}. @nuxt/kit does not resolve it against this module file; Nuxt resolves it later against ${where}.`,
      fix: resolver
        ? `Resolve the path from the module file: ${resolver.expression}(${raw}).`
        : `Create a resolver with createResolver(import.meta.url) from @nuxt/kit and pass resolver.resolve(${raw}) instead of the relative string.`,
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "modules",
      file: ctx.file.path,
      range: ctx.range(literal),
      fix: resolver
        ? {
            kind: "safe",
            edits: [
              {
                range: { start: literal.start, end: literal.end },
                text: `${resolver.expression}(${raw})`,
              },
            ],
          }
        : null,
    },
  );
}

function collectKitImports(program: AnyNode) {
  const helpers = new Map<string, string>();
  const createResolverNames = new Set<string>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (!NUXT_KIT_SOURCES.has(String(statement.source?.value))) continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
      const imported = String(specifier.imported?.name ?? specifier.imported?.value);
      if (imported in PATH_HELPERS) helpers.set(specifier.local.name, imported);
      if (imported === "createResolver") createResolverNames.add(specifier.local.name);
    }
  }
  return { helpers, createResolverNames };
}

function pathLiterals(
  argument: AnyNode,
  shape: PathArgument,
): Array<{ literal: AnyNode; option?: string }> {
  const value = unwrapExpression(argument);
  if (!value) return [];
  const isArray = value.type === "ArrayExpression";
  const items: AnyNode[] = isArray ? value.elements.map(unwrapExpression) : [value];
  const candidates = items.flatMap((item): Array<{ literal: AnyNode; option?: string }> => {
    if (shape.kind === "strings") return [{ literal: item }];
    if (shape.kind === "string-or-object" && item?.type !== "ObjectExpression") {
      return isArray ? [] : [{ literal: item }];
    }
    if (shape.kind !== "objects" && isArray) return [];
    const property = findProperty(item, shape.key);
    return property ? [{ literal: unwrapExpression(property.value), option: shape.key }] : [];
  });
  return candidates.filter(({ literal }) => {
    const text = staticStringValue(literal);
    return text !== undefined && isRelativePath(text);
  });
}

function resolverBinding(
  declarator: AnyNode,
  createResolverNames: Set<string>,
): Omit<ResolverBinding, "scope"> | undefined {
  const init = unwrapExpression(declarator.init);
  if (
    init?.type !== "CallExpression" ||
    init.callee?.type !== "Identifier" ||
    !createResolverNames.has(init.callee.name) ||
    !isImportMetaUrl(init.arguments?.[0])
  )
    return undefined;
  if (declarator.id?.type === "Identifier") {
    return { expression: `${declarator.id.name}.resolve`, declarator };
  }
  if (declarator.id?.type === "ObjectPattern") {
    const property = findProperty({ ...declarator.id, type: "ObjectExpression" }, "resolve");
    if (property?.value?.type === "Identifier") {
      return { expression: property.value.name, declarator };
    }
  }
  return undefined;
}

function isImportMetaUrl(node: AnyNode): boolean {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "url" &&
    node.object?.type === "MetaProperty" &&
    node.object.meta?.name === "import" &&
    node.object.property?.name === "meta"
  );
}

function isUsableAt(binding: ResolverBinding, call: AnyNode, parents: Map<AnyNode, AnyNode>) {
  if (binding.declarator.end > call.start) return false;
  for (let current = call; current; current = parents.get(current)) {
    if (current === binding.scope) return true;
  }
  return false;
}

const SCOPE_TYPES = new Set([
  "Program",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "BlockStatement",
]);

function nearestScope(node: AnyNode, parents: Map<AnyNode, AnyNode>): AnyNode {
  let current = parents.get(node);
  while (current && !SCOPE_TYPES.has(current.type)) current = parents.get(current);
  return current;
}

function walkWithParents(
  node: AnyNode,
  parent: AnyNode,
  parents: Map<AnyNode, AnyNode>,
  visit: (node: AnyNode) => void,
) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkWithParents(child, parent, parents, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  if (parent) parents.set(node, parent);
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    if (value && typeof value === "object") walkWithParents(value, node, parents, visit);
  }
}
