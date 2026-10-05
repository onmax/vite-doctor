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

export function findStoreDefinitions(program: AnyNode): StoreDefinition[] {
  if (program?.type !== "Program") return [];
  const callees = piniaDefineStoreCallees(program);
  const definitions: StoreDefinition[] = [];
  walk(program, [], (node, ancestors) => {
    if (node.type !== "CallExpression" || !isDefineStoreCallee(node.callee, callees)) return;
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

interface DefineStoreCallees {
  identifiers: Set<string>;
  namespaces: Set<string>;
}

function piniaDefineStoreCallees(program: AnyNode): DefineStoreCallees {
  const identifiers = new Set<string>();
  const namespaces = new Set<string>();
  let shadowed = false;
  for (const statement of program.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      const fromPinia = statement.source?.value === "pinia";
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.importKind === "type") continue;
        const local = specifier.local?.name;
        if (!fromPinia) {
          if (local === "defineStore") shadowed = true;
          continue;
        }
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local);
        else if (specifier.type === "ImportSpecifier" && importedName(specifier) === "defineStore")
          identifiers.add(local);
      }
      continue;
    }
    if (
      declaresDefineStore(
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement,
      )
    )
      shadowed = true;
  }
  // Nuxt (@pinia/nuxt) and unplugin-auto-import expose defineStore without an import.
  if (!shadowed) identifiers.add("defineStore");
  return { identifiers, namespaces };
}

function importedName(specifier: AnyNode): string | undefined {
  const imported = specifier.imported;
  return imported?.type === "Identifier" ? imported.name : imported?.value;
}

function declaresDefineStore(statement: AnyNode): boolean {
  if (!statement) return false;
  if (
    (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
    statement.id?.name === "defineStore"
  )
    return true;
  if (statement.type !== "VariableDeclaration") return false;
  return statement.declarations.some(
    (declaration: AnyNode) =>
      declaration.id?.type === "Identifier" && declaration.id.name === "defineStore",
  );
}

function isDefineStoreCallee(callee: AnyNode, callees: DefineStoreCallees): boolean {
  const node = unwrap(callee);
  if (node?.type === "Identifier") return callees.identifiers.has(node.name);
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    callees.namespaces.has(node.object.name) &&
    node.property?.name === "defineStore"
  );
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
