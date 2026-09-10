import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";
import { parameterType, type AnyNode } from "./shared.js";

type Binding = {
  node: AnyNode;
  kind: string;
  annotation?: AnyNode;
  init?: AnyNode;
  written: boolean;
  owner: AnyNode;
};
type Scope = {
  parent?: Scope;
  owner: AnyNode;
  bindings: Map<string, Binding[]>;
  types: Set<string>;
};

export function expression(node: AnyNode, unwrapAssertions = false): AnyNode {
  while (
    node &&
    [
      "ParenthesizedExpression",
      "ChainExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      ...(unwrapAssertions ? ["TSAsExpression", "TSTypeAssertion"] : []),
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}

export function arrayMethod(node: AnyNode): { object: AnyNode; name: string } | null {
  node = expression(node);
  if (node?.type !== "MemberExpression" || node.optional) return null;
  const name =
    !node.computed && node.property?.type === "Identifier"
      ? node.property.name
      : node.property?.type === "Literal"
        ? node.property.value
        : null;
  return typeof name === "string" ? { object: expression(node.object), name } : null;
}

export function createLocalEvidence(program: AnyNode, { unwrapArrayAssertions = true } = {}) {
  const scopes = new WeakMap<object, Scope>();
  const parents = new WeakMap<object, AnyNode>();
  const writes: AnyNode[] = [];
  const namespaces = new WeakMap<Scope, Map<string, Scope>>();
  const root: Scope = { owner: program, bindings: new Map(), types: new Set() };
  function bind(pattern: AnyNode, scope: Scope, info: Omit<Binding, "node" | "written" | "owner">) {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      const bindings = scope.bindings.get(pattern.name) ?? [];
      bindings.push({
        ...info,
        annotation: pattern.typeAnnotation?.typeAnnotation ?? info.annotation,
        node: pattern,
        written: false,
        owner: scope.owner,
      });
      scope.bindings.set(pattern.name, bindings);
    } else if (pattern.type === "AssignmentPattern")
      bind(pattern.left, scope, {
        kind: info.kind,
        annotation: info.annotation,
        init: info.kind === "parameter" ? pattern.right : undefined,
      });
    else if (pattern.type === "RestElement" || pattern.type === "TSParameterProperty")
      bind(pattern.argument ?? pattern.parameter, scope, {
        kind: info.kind,
        annotation: info.annotation,
      });
    else if (pattern.type === "ArrayPattern")
      for (const item of pattern.elements) bind(item, scope, { kind: info.kind });
    else if (pattern.type === "ObjectPattern")
      for (const item of pattern.properties)
        bind(item.value ?? item.argument, scope, { kind: info.kind });
  }
  function collect(node: AnyNode, outer: Scope, exports?: Scope) {
    if (!node?.type) return;
    if (node.type === "TSModuleDeclaration" && node.id?.type === "TSQualifiedName") {
      collect({ ...node, id: node.id.left, body: { ...node, id: node.id.right } }, outer, exports);
      return;
    }
    if (
      [
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSImportEqualsDeclaration",
      ].includes(node.type) &&
      node.id?.name
    )
      (exports ?? outer).types.add(node.id.name);
    if (node.type === "TSImportEqualsDeclaration" && node.importKind === "type") return;
    if (node.type === "ImportDeclaration" && node.importKind === "type") {
      for (const specifier of node.specifiers) outer.types.add(specifier.local.name);
      return;
    }
    if (
      ["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type) &&
      node.importKind === "type"
    ) {
      outer.types.add(node.local.name);
      return;
    }
    if (
      [
        "FunctionDeclaration",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSModuleDeclaration",
        "TSImportEqualsDeclaration",
      ].includes(node.type)
    )
      bind(node.id, outer, { kind: "other" });
    if (
      ["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type)
    )
      bind(node.local, outer, { kind: "other" });
    if (
      node.type === "TSModuleDeclaration" &&
      node.id?.name &&
      ["TSModuleBlock", "TSModuleDeclaration"].includes(node.body?.type)
    ) {
      const owner = exports ?? outer;
      let members = namespaces.get(owner);
      if (!members) namespaces.set(owner, (members = new Map()));
      let shared = members.get(node.id.name);
      if (!shared) {
        shared = { parent: owner, owner: outer.owner, bindings: new Map(), types: new Set() };
        members.set(node.id.name, shared);
      }
      const local: Scope = {
        parent: shared,
        owner: outer.owner,
        bindings: new Map(),
        types: new Set(),
      };
      scopes.set(node, outer);
      scopes.set(node.body, local);
      if (node.body.type === "TSModuleDeclaration") {
        collect(node.body, local, shared);
        return;
      }
      for (const statement of node.body.body) {
        if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
          scopes.set(statement, local);
          collect(statement.declaration, local, shared);
        } else {
          collect(statement, local);
        }
      }
      return;
    }
    const isFunction = [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type);
    const scoped =
      isFunction ||
      [
        "BlockStatement",
        "StaticBlock",
        "ForStatement",
        "ForOfStatement",
        "ForInStatement",
        "SwitchStatement",
        "CatchClause",
        "ClassExpression",
        "TSModuleBlock",
      ].includes(node.type) ||
      node.typeParameters?.params?.length;
    const scope = scoped
      ? {
          parent: outer,
          owner: isFunction ? node : outer.owner,
          bindings: new Map<string, Binding[]>(),
          types: new Set<string>(),
        }
      : outer;
    for (const parameter of node.typeParameters?.params ?? [])
      scope.types.add(parameter.name?.name ?? parameter.name);
    if (node.type === "ClassExpression" && node.id?.name) scope.types.add(node.id.name);
    if (isFunction) {
      if (node.type === "FunctionExpression") bind(node.id, scope, { kind: "other" });
      for (const parameter of node.params)
        bind(parameter, scope, { kind: "parameter", annotation: parameterType(parameter) });
    }
    if (node.type === "ClassExpression") bind(node.id, scope, { kind: "other" });
    if (node.type === "CatchClause") bind(node.param, scope, { kind: "other" });
    scopes.set(node, scope);
    if (node.type === "VariableDeclaration") {
      let target = scope;
      if (node.kind === "var")
        while (target.parent && target.parent.owner === target.owner) target = target.parent;
      for (const declaration of node.declarations)
        bind(declaration.id, target, { kind: node.kind, init: declaration.init });
    }
    if (node.type === "AssignmentExpression") writes.push(node.left);
    if (node.type === "UpdateExpression") writes.push(node.argument);
    if (
      ["ForOfStatement", "ForInStatement"].includes(node.type) &&
      node.left?.type !== "VariableDeclaration"
    )
      writes.push(node.left);
    for (const key of getNodeVisitorKeys(node)) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child?.type) parents.set(child, node);
        collect(child, scope);
      }
    }
  }
  collect(program, root);
  function binding(node: AnyNode): Binding | null {
    node = expression(node);
    if (node?.type !== "Identifier") return null;
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      const found = scope.bindings.get(node.name);
      if (found)
        return found.length === 1 ? found[0]! : { ...found[0]!, kind: "ambiguous", written: true };
    }
    return null;
  }
  function markWrite(node: AnyNode) {
    if (!node) return;
    if (node.type === "Identifier") {
      const target = binding(node);
      if (target && target.owner === scopes.get(node)?.owner) target.written = true;
    } else if (node.type === "AssignmentPattern") markWrite(node.left);
    else if (node.type === "RestElement") markWrite(node.argument);
    else if (node.type === "ArrayPattern") for (const item of node.elements) markWrite(item);
    else if (node.type === "ObjectPattern")
      for (const item of node.properties) markWrite(item.value ?? item.argument);
  }
  for (const write of writes) markWrite(write);
  function globalType(node: AnyNode, name: string): boolean {
    if (
      node?.type !== "TSTypeReference" ||
      node.typeName?.type !== "Identifier" ||
      node.typeName.name !== name
    )
      return false;
    for (let scope = scopes.get(node); scope; scope = scope.parent)
      if (scope.types.has(name)) return false;
    return true;
  }
  function broadType(node: AnyNode): boolean {
    if (!node) return false;
    if (["TSUnknownKeyword", "TSAnyKeyword", "TSObjectKeyword"].includes(node.type)) return true;
    if (node.type === "TSParenthesizedType") return broadType(node.typeAnnotation);
    if (node.type === "TSUnionType") return node.types.some((item: AnyNode) => broadType(item));
    if (node.type === "TSTypeLiteral") return !node.members.length;
    if (globalType(node, "Readonly")) return broadType(node.typeArguments?.params?.[0]);
    if (!globalType(node, "Record")) return false;
    const [key, value] = node.typeArguments?.params ?? [];
    return (
      ["TSStringKeyword", "TSNumberKeyword", "TSSymbolKeyword"].includes(key?.type) &&
      broadType(value)
    );
  }
  function arrayType(node: AnyNode): boolean {
    if (node?.type === "TSParenthesizedType") return arrayType(node.typeAnnotation);
    if (node?.type === "TSArrayType" || node?.type === "TSTupleType") return true;
    if (node?.type === "TSTypeOperator" && node.operator === "readonly")
      return arrayType(node.typeAnnotation);
    return globalType(node, "Array") || globalType(node, "ReadonlyArray");
  }
  function deferredParameterReference(node: AnyNode, owner: AnyNode): boolean {
    for (let current = node; current && current !== owner; current = parents.get(current)) {
      if (!["FunctionExpression", "ArrowFunctionExpression"].includes(current.type)) continue;
      let value = current;
      let parent = parents.get(value);
      while (parent && expression(parent) === value) {
        value = parent;
        parent = parents.get(value);
      }
      // A function stored as a parameter default is not called by that initializer.
      if (
        parent?.type === "AssignmentPattern" &&
        parent.right === value &&
        parents.get(parent) === owner
      )
        return true;
      // Unknown calls may invoke callbacks synchronously. Only known, unshadowed
      // schedulers establish deferred execution without cross-function analysis.
      if (
        parent?.type === "CallExpression" &&
        parent.arguments[0] === value &&
        parent.callee.type === "Identifier" &&
        ["setTimeout", "setInterval", "queueMicrotask", "requestAnimationFrame"].includes(
          parent.callee.name,
        ) &&
        !binding(parent.callee)
      )
        return true;
    }
    return false;
  }
  function isArray(node: AnyNode, seen = new Set<Binding>()): boolean {
    node = expression(node, unwrapArrayAssertions);
    if (!node) return false;
    if (node.type === "ArrayExpression") return true;
    if (node.type === "Identifier") {
      const target = binding(node);
      if (!target || target.written || seen.has(target)) return false;
      if (
        target.kind === "parameter" &&
        (target.init?.end ?? target.node.end) >= node.start &&
        !deferredParameterReference(node, target.owner)
      )
        return false;
      if (target.kind !== "parameter" && (!target.init || target.init.end >= node.start))
        return false;
      if (arrayType(target.annotation)) return true;
      if (
        target.annotation ||
        target.kind !== "const" ||
        !target.init ||
        target.node.start >= node.start
      )
        return false;
      return isArray(target.init, new Set([...seen, target]));
    }
    if (node.type === "CallExpression" && !node.optional) {
      const method = arrayMethod(node.callee);
      return (
        !!method &&
        [
          "filter",
          "map",
          "flatMap",
          "slice",
          "concat",
          "toSorted",
          "toReversed",
          "toSpliced",
          "with",
        ].includes(method.name) &&
        isArray(method.object, seen)
      );
    }
    return false;
  }
  function primitive(
    node: AnyNode,
    owner?: AnyNode,
    seen = new Set<Binding>(),
  ): string | undefined {
    node = expression(node, true);
    if (!node) return;
    if (node.type === "Literal") {
      if (node.value === null) return "null";
      if (["number", "boolean", "string", "bigint"].includes(typeof node.value))
        return typeof node.value;
      return;
    }
    if (node.type === "UnaryExpression" && ["+", "-", "~", "!"].includes(node.operator)) {
      const operand = primitive(node.argument, owner, seen);
      if (!operand || (node.operator === "+" && operand === "bigint")) return;
      if (node.operator === "!") return "boolean";
      if (operand === "symbol") return;
      return operand === "bigint" ? "bigint" : "number";
    }
    if (node.type !== "Identifier") return;
    const target = binding(node);
    if (!target || (owner && target.owner !== owner) || target.written || seen.has(target)) return;
    if (target.annotation) {
      const types: Record<string, string> = {
        TSStringKeyword: "string",
        TSNumberKeyword: "number",
        TSBooleanKeyword: "boolean",
        TSBigIntKeyword: "bigint",
        TSSymbolKeyword: "symbol",
        TSNullKeyword: "null",
      };
      if (target.annotation.type === "TSLiteralType")
        return primitive(target.annotation.literal, owner, seen);
      return types[target.annotation.type];
    }
    if (target.kind === "const" && target.node.start < node.start)
      return primitive(target.init, owner, new Set([...seen, target]));
  }
  function known(node: AnyNode, owner?: AnyNode, seen = new Set<Binding>()): boolean {
    node = expression(node, true);
    if (!node) return false;
    if (
      [
        "Literal",
        "ObjectExpression",
        "ArrayExpression",
        "ArrowFunctionExpression",
        "FunctionExpression",
      ].includes(node.type)
    )
      return true;
    if (node.type === "UnaryExpression") return primitive(node, owner, seen) !== undefined;
    if (node.type !== "Identifier") return false;
    const target = binding(node);
    if (!target || (owner && target.owner !== owner) || target.written || seen.has(target))
      return false;
    if (target.annotation)
      return (
        [
          "TSStringKeyword",
          "TSNumberKeyword",
          "TSBooleanKeyword",
          "TSBigIntKeyword",
          "TSSymbolKeyword",
          "TSLiteralType",
          "TSArrayType",
          "TSTupleType",
          "TSFunctionType",
        ].includes(target.annotation.type) ||
        (target.annotation.type === "TSTypeLiteral" && target.annotation.members.length > 0)
      );
    return (
      target.kind === "const" &&
      target.node.start < node.start &&
      known(target.init, owner, new Set([...seen, target]))
    );
  }
  return {
    binding,
    broadType,
    globalType,
    isArray,
    known,
    owner: (node: AnyNode) => scopes.get(node)?.owner,
  };
}
