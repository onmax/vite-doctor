import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";
import type { AnyNode } from "./shared.js";

type Scope = { parent?: Scope; bindings: Map<string, AnyNode[]> };
type Substitution = { node: AnyNode; substitutions: Map<AnyNode, Substitution> };

export function createTypeAliasResolver(program: AnyNode) {
  const scopes = new WeakMap<object, Scope>();
  const aliases: AnyNode[] = [];
  const root: Scope = { bindings: new Map() };
  function bind(scope: Scope, name: string, node: AnyNode) {
    const bindings = scope.bindings.get(name) ?? [];
    bindings.push(node);
    scope.bindings.set(name, bindings);
  }
  function collect(node: AnyNode, outer: Scope) {
    if (!node?.type) return;
    if (
      [
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
        "TSEnumDeclaration",
        "ClassDeclaration",
        "TSModuleDeclaration",
        "TSImportEqualsDeclaration",
      ].includes(node.type) &&
      node.id?.name
    ) {
      bind(outer, node.id.name, node);
      if (node.type === "TSTypeAliasDeclaration") aliases.push(node);
    }
    if (
      ["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type)
    )
      bind(outer, node.local.name, node);
    const parameters = node.typeParameters?.params ?? [];
    const ownsScope =
      parameters.length ||
      [
        "BlockStatement",
        "TSModuleBlock",
        "StaticBlock",
        "SwitchStatement",
        "ClassExpression",
      ].includes(node.type);
    const scope = ownsScope ? { parent: outer, bindings: new Map<string, AnyNode[]>() } : outer;
    if (node.type === "ClassExpression" && node.id?.name) bind(scope, node.id.name, node);
    for (const parameter of parameters)
      bind(scope, parameter.name?.name ?? parameter.name, parameter);
    scopes.set(node, scope);
    for (const key of getNodeVisitorKeys(node)) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) collect(child, scope);
    }
  }
  collect(program, root);
  function binding(node: AnyNode): AnyNode {
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      const found = scope.bindings.get(node.typeName.name);
      if (found) return found.length === 1 ? found[0] : null;
    }
    return null;
  }
  function resolvesToKeyword(node: AnyNode, keyword: string): boolean {
    let remaining = 256;
    function resolve(current: AnyNode, substitutions: Map<AnyNode, Substitution>): boolean {
      if (!current || --remaining < 0) return false;
      if (current.type === keyword) return true;
      if (current.type === "TSParenthesizedType")
        return resolve(current.typeAnnotation, substitutions);
      if (current.type === "TSUnionType")
        return current.types.some((part: AnyNode) => resolve(part, substitutions));
      if (current.type !== "TSTypeReference" || current.typeName?.type !== "Identifier")
        return false;
      const target = binding(current);
      if (!target) return false;
      const replacement = substitutions.get(target);
      if (replacement) return resolve(replacement.node, replacement.substitutions);
      if (target.type !== "TSTypeAliasDeclaration") return false;
      const parameters = target.typeParameters?.params ?? [];
      const arguments_ = current.typeArguments?.params ?? [];
      if (arguments_.length > parameters.length) return false;
      const next = new Map<AnyNode, Substitution>();
      for (const [index, parameter] of parameters.entries()) {
        const argument = arguments_[index] ?? parameter.default;
        if (!argument) return false;
        next.set(parameter, {
          node: argument,
          substitutions: arguments_[index] ? substitutions : new Map(next),
        });
      }
      return resolve(target.typeAnnotation, next);
    }
    return resolve(node, new Map());
  }
  return { aliases, resolvesToKeyword };
}
