import type { ScriptScope } from "../../../../core/internal/script-scope.js";
import type { AnyNode } from "./shared.js";

const CLIENT_FLAGS = new Set([
  "import.meta.client",
  "import.meta.browser",
  "process.client",
  "process.browser",
]);
const SERVER_FLAGS = new Set(["import.meta.server", "import.meta.env.SSR", "process.server"]);

export function isInlineCallback(call: AnyNode, child: AnyNode): boolean {
  return (
    call.arguments[0] === child &&
    (child.type === "ArrowFunctionExpression" || child.type === "FunctionExpression")
  );
}

export function scriptParents(scope: ScriptScope): Map<AnyNode, AnyNode> {
  const parents = new Map<AnyNode, AnyNode>();
  const visit = (node: AnyNode) => {
    for (const key of scope.visitorKeys[node.type] ?? []) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child?.type) continue;
        parents.set(child, node);
        visit(child);
      }
    }
  };
  visit(scope.ast);
  return parents;
}

export function excludesRuntime(
  parents: Map<AnyNode, AnyNode>,
  node: AnyNode,
  scope: ScriptScope,
  runtime: "client" | "server",
  callbackExcluded: (call: AnyNode, child: AnyNode) => boolean,
  knownFalse?: (test: AnyNode) => boolean,
): boolean {
  const truth = (test: AnyNode): boolean | undefined => {
    if (knownFalse?.(test)) return false;
    if (test.type === "Literal") return Boolean(test.value);
    if (test.type === "UnaryExpression" && test.operator === "!") {
      const argument = truth(test.argument);
      return argument === undefined ? undefined : !argument;
    }
    if (test.type === "LogicalExpression") {
      const left = truth(test.left);
      const right = truth(test.right);
      if (test.operator === "&&") {
        if (left === false || right === false) return false;
        if (left === true) return right;
      }
      if (test.operator === "||") {
        if (left === true || right === true) return true;
        if (left === false) return right;
      }
    }
    if (test.type === "BinaryExpression" && /^[!=]==?$/.test(test.operator)) {
      const [typeOf, literal] =
        test.left.type === "UnaryExpression" ? [test.left, test.right] : [test.right, test.left];
      const global = typeOf.argument;
      if (
        typeOf.operator === "typeof" &&
        global?.type === "Identifier" &&
        ["window", "document"].includes(global.name) &&
        scope.references.get(global)?.resolved == null &&
        literal.value === "undefined"
      )
        return test.operator.startsWith("=") === (runtime === "server");
    }
    const name = memberPath(test, scope);
    if (name && CLIENT_FLAGS.has(name)) return runtime === "client";
    if (name && SERVER_FLAGS.has(name)) return runtime === "server";
  };
  const exits = (statement: AnyNode): boolean => {
    if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") return true;
    if (statement.type === "BlockStatement") return statement.body.some(exits);
    if (statement.type !== "IfStatement") return false;
    const result = truth(statement.test);
    if (result === true) return exits(statement.consequent);
    if (result === false) return !!statement.alternate && exits(statement.alternate);
    return !!statement.alternate && exits(statement.consequent) && exits(statement.alternate);
  };
  let child = node;
  for (let parent = parents.get(child); parent; child = parent, parent = parents.get(child)) {
    if (parent.type === "IfStatement" || parent.type === "ConditionalExpression") {
      if (child === parent.consequent && truth(parent.test) === false) return true;
      if (child === parent.alternate && truth(parent.test) === true) return true;
    } else if (parent.type === "LogicalExpression" && child === parent.right) {
      if (parent.operator === "&&" && truth(parent.left) === false) return true;
      if (parent.operator === "||" && truth(parent.left) === true) return true;
    } else if (parent.type === "BlockStatement" || parent.type === "Program") {
      const index = parent.body.indexOf(child);
      if (index > 0 && parent.body.slice(0, index).some(exits)) return true;
    } else if (parent.type === "CallExpression" && callbackExcluded(parent, child)) {
      return true;
    }
  }
  return false;
}

function memberPath(node: AnyNode, scope: ScriptScope): string | undefined {
  if (node.type === "Identifier")
    return scope.references.get(node)?.resolved == null ? node.name : undefined;
  if (node.type === "MetaProperty") return `${node.meta.name}.${node.property.name}`;
  if (node.type !== "MemberExpression" || node.computed) return undefined;
  const object = memberPath(node.object, scope);
  return object && `${object}.${node.property.name}`;
}
