import { parseForESLint } from "@typescript-eslint/parser";
import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";

type AnyNode = any;

export interface StoreDefinition {
  id: string;
  idStart: number;
  idEnd: number;
  binding?: { name: string; start: number; end: number };
}

const TRANSPARENT_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

export function findStoreDefinitions(program: AnyNode, source: string): StoreDefinition[] {
  if (program?.type !== "Program") return [];
  const callees = piniaDefineStoreCallees(program, source);
  const definitions: StoreDefinition[] = [];
  walk(program, [], (node, ancestors) => {
    if (node.type !== "CallExpression" || !callees.has(unwrap(node.callee)?.start)) return;
    const id = readStoreId(node);
    if (!id) return;
    definitions.push({ ...id, binding: readBinding(node, ancestors) });
  });
  return definitions;
}

export function expectedStoreName(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.at(-1)?.toLowerCase() === "store") words.pop();
  return `use${words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("")}Store`;
}

export function isConventionalStoreName(name: string, id: string): boolean {
  return normalizeName(name) === normalizeName(expectedStoreName(id));
}

function normalizeName(name: string) {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function piniaDefineStoreCallees(program: AnyNode, source: string): Set<number> {
  const callees = new Set<number>();
  const identifiers = new Set<number>();
  const namespaces = new Set<number>();
  // Preserve offsets while excluding SFC markup outside the parsed script statements.
  const script: string[] = source
    .split("")
    .map((char) => (/^[\n\r\u2028\u2029]$/.test(char) ? char : " "));
  for (const statement of program.body ?? []) {
    for (let offset = statement.start; offset < statement.end; offset++)
      script[offset] = source[offset]!;
  }
  let jsx = false;
  walk(program, [], (node) => {
    if (node.type === "JSXElement" || node.type === "JSXFragment") jsx = true;
  });
  try {
    const { scopeManager } = parseForESLint(script.join(""), {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx },
    });
    for (const scope of scopeManager.scopes) {
      for (const reference of scope.references) {
        if (!reference.isValueReference) continue;
        const identifier = reference.identifier;
        const variable = reference.resolved;
        if (!variable) {
          if (identifier.name === "defineStore") identifiers.add(identifier.range[0]);
          continue;
        }
        for (const definition of variable.defs) {
          if (
            definition.type !== "ImportBinding" ||
            definition.parent.type !== "ImportDeclaration" ||
            definition.parent.source.value !== "pinia" ||
            definition.parent.importKind === "type"
          )
            continue;
          const binding = definition.node;
          if (
            binding.type === "ImportSpecifier" &&
            binding.importKind !== "type" &&
            (binding.imported.type === "Identifier"
              ? binding.imported.name
              : binding.imported.value) === "defineStore"
          ) {
            identifiers.add(identifier.range[0]);
          } else if (binding.type === "ImportNamespaceSpecifier") {
            namespaces.add(identifier.range[0]);
          }
        }
      }
    }
  } catch {
    // Without binding evidence, recovered or unsupported syntax cannot establish a Pinia call.
  }
  walk(program, [], (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (callee?.type === "Identifier" && identifiers.has(callee.start)) callees.add(callee.start);
    if (
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.object?.type === "Identifier" &&
      namespaces.has(callee.object.start) &&
      callee.property?.name === "defineStore"
    )
      callees.add(callee.start);
  });
  return callees;
}

function readStoreId(call: AnyNode): Omit<StoreDefinition, "binding"> | undefined {
  const first = call.arguments?.[0];
  const firstNode = unwrap(first);
  if (firstNode?.type === "ObjectExpression") {
    const property = firstNode.properties?.find(
      (item: AnyNode) =>
        item.type === "Property" &&
        !item.computed &&
        (item.key?.name === "id" || item.key?.value === "id"),
    );
    const id = staticString(property?.value);
    if (id === undefined) return undefined;
    return { id, idStart: property.value.start, idEnd: property.value.end };
  }
  const id = staticString(firstNode);
  if (id === undefined) return undefined;
  return { id, idStart: firstNode.start, idEnd: firstNode.end };
}

function staticString(node: AnyNode): string | undefined {
  const value = unwrap(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "TemplateLiteral" && value.expressions?.length === 0)
    return value.quasis?.[0]?.value?.cooked ?? undefined;
  return undefined;
}

function readBinding(call: AnyNode, ancestors: AnyNode[]): StoreDefinition["binding"] {
  let current = call;
  let index = ancestors.length - 1;
  while (index >= 0 && TRANSPARENT_WRAPPERS.has(ancestors[index].type))
    current = ancestors[index--];
  const ancestor = ancestors[index];
  if (
    ancestor?.type !== "VariableDeclarator" ||
    ancestor.init !== current ||
    ancestor.id?.type !== "Identifier"
  )
    return undefined;
  return { name: ancestor.id.name, start: ancestor.id.start, end: ancestor.id.end };
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current && TRANSPARENT_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

function walk(
  node: AnyNode,
  ancestors: AnyNode[],
  visit: (node: AnyNode, ancestors: AnyNode[]) => void,
) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of getNodeVisitorKeys(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, ancestors, visit);
    else walk(value, ancestors, visit);
  }
  ancestors.pop();
}
