import type { RuleContext } from "../../../../core/index.js";
import { fileScriptScope, perFile, type ScopeVariable, type ScriptScope } from "./script-scope.js";
import type { AnyNode } from "./shared.js";

const VUE_API_SOURCES = /^(?:vue|vue-demi|@vue\/(?:runtime-core|runtime-dom|reactivity)|#imports)$/;
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const TS_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

/** The file's script scope with parent links, so Rules can walk up from scope references. */
export interface IndexedScript extends ScriptScope {
  parent(node: AnyNode): AnyNode;
  /** The nearest enclosing function, or `undefined` at module (and `<script setup>`) level. */
  owner(node: AnyNode): AnyNode;
  nodes(type: string): AnyNode[];
}

export function indexedScript(ctx: RuleContext): IndexedScript | null {
  return perFile(ctx, "vue-indexed-script", () => {
    const scope = fileScriptScope(ctx);
    if (!scope) return null;
    const parents = new Map<AnyNode, AnyNode>();
    const owners = new Map<AnyNode, AnyNode>();
    const byType = new Map<string, AnyNode[]>();
    const visit = (node: AnyNode, parent: AnyNode, owner: AnyNode) => {
      if (!node?.type) return;
      parents.set(node, parent);
      owners.set(node, owner);
      let list = byType.get(node.type);
      if (!list) byType.set(node.type, (list = []));
      list.push(node);
      const childOwner = FUNCTION_TYPES.has(node.type) ? node : owner;
      for (const key of scope.visitorKeys[node.type] ?? []) {
        const value = node[key];
        if (Array.isArray(value)) for (const child of value) visit(child, node, childOwner);
        else visit(value, node, childOwner);
      }
    };
    visit(scope.ast, undefined, undefined);
    return {
      ast: scope.ast,
      scopeManager: scope.scopeManager,
      visitorKeys: scope.visitorKeys,
      get references() {
        return scope.references;
      },
      parent: (node) => parents.get(node),
      owner: (node) => owners.get(node),
      nodes: (type) => byType.get(type) ?? [],
    };
  });
}

export function unwrapTs(node: AnyNode): AnyNode {
  while (TS_WRAPPERS.has(node?.type)) node = node.expression;
  return node;
}

/** The parent of `node`, skipping TypeScript wrappers such as `as` and `satisfies`. */
export function valueParent(script: IndexedScript, node: AnyNode): [AnyNode, AnyNode] {
  let child = node;
  let parent = script.parent(node);
  while (TS_WRAPPERS.has(parent?.type)) {
    child = parent;
    parent = script.parent(parent);
  }
  return [parent, child];
}

export function propertyName(node: AnyNode): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier" && !node.computed) return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

export function memberName(node: AnyNode): string | undefined {
  if (node?.type !== "MemberExpression") return undefined;
  if (!node.computed) return node.property.name;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

/**
 * The Vue API `callee` calls when it is one of `names`: an import from Vue, a member of a Vue
 * namespace import, or an unbound name such as a Nuxt or unplugin-auto-import auto-import.
 */
export function vueApiCall(
  script: IndexedScript,
  callee: AnyNode,
  names: ReadonlySet<string>,
): string | undefined {
  callee = unwrapTs(callee);
  if (callee?.type === "Identifier") {
    const variable = script.references.get(callee)?.resolved;
    if (!variable) return names.has(callee.name) ? callee.name : undefined;
    const imported = vueImportName(variable);
    return imported && names.has(imported) ? imported : undefined;
  }
  const name = memberName(callee);
  if (!name || !names.has(name) || callee.object.type !== "Identifier") return undefined;
  const variable = script.references.get(callee.object)?.resolved;
  return variable && vueImportName(variable) === "*" ? name : undefined;
}

function vueImportName(variable: ScopeVariable): string | undefined {
  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding") continue;
    const declaration = definition.parent as AnyNode;
    if (
      declaration?.type !== "ImportDeclaration" ||
      declaration.importKind === "type" ||
      !VUE_API_SOURCES.test(declaration.source.value)
    )
      return undefined;
    const specifier = definition.node as AnyNode;
    if (specifier.type === "ImportNamespaceSpecifier") return "*";
    if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") return undefined;
    return propertyName(specifier.imported);
  }
  return undefined;
}

/** The variable a `const name = <init>` declarator binds, when it is a plain identifier. */
export function constBinding(
  script: IndexedScript,
  declarator: AnyNode,
): ScopeVariable | undefined {
  if (declarator.id?.type !== "Identifier" || script.parent(declarator)?.kind !== "const")
    return undefined;
  return script.scopeManager
    .getDeclaredVariables(declarator)
    .find((variable) => variable.identifiers.includes(declarator.id));
}
