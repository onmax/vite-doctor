export type AnyNode = any;

const FN_OR_PROG_TYPES = new Set([
  "Program",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

export function findAncestor(node: AnyNode, predicate: (current: AnyNode) => boolean) {
  let current = node?.__doctorParent ?? node?.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.__doctorParent ?? current.parent;
  }
  return null;
}

export function nearestFunctionOrProgram(node: AnyNode): AnyNode {
  let current = node;
  while (current) {
    if (FN_OR_PROG_TYPES.has(current.type)) return current;
    current = current.__doctorParent;
  }
  return null;
}

export function walkScriptLocal(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkScriptLocal(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkScriptLocal(child, visit);
    } else if (value && typeof value === "object") {
      walkScriptLocal(value, visit);
    }
  }
}

export function sourceForNode(node: AnyNode, source: string) {
  const start = node.start ?? node.range?.[0];
  const end = node.end ?? node.range?.[1];
  return typeof start === "number" && typeof end === "number" ? source.slice(start, end) : "";
}
