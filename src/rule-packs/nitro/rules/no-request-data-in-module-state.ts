import {
  holdsRequestValue,
  moduleNames,
  resolveLexicalBinding,
  resolvesToModuleBinding,
  unwrapExpression,
  type RequestValueSources,
} from "../../../core/internal/request-values.js";
import { scriptNodesOfType } from "../../../core/internal/script-index.js";
import { isNitroRuntimeFile } from "./server-layout.js";
import {
  type AnyNode,
  createRule,
  nearestFunctionOrProgram,
  report,
  walkScriptLocal,
} from "./shared.js";

const RULE_ID = "nitro/state/no-request-data-in-module-state";
const H3_SOURCES = /^(?:h3|nitro\/h3|nitropack\/runtime(?:\/.*)?|#imports)$/;
// h3 utilities that read the incoming request. Nitro auto-imports every h3 export.
const REQUEST_READERS = new Set([
  "getQuery",
  "getValidatedQuery",
  "getRouterParam",
  "getRouterParams",
  "getValidatedRouterParams",
  "readBody",
  "readValidatedBody",
  "readRawBody",
  "readFormData",
  "readMultipartFormData",
  "getHeader",
  "getHeaders",
  "getRequestHeader",
  "getRequestHeaders",
  "getCookie",
  "parseCookies",
  "getRequestURL",
  "getRequestIP",
  "getRequestHost",
  "getRequestProtocol",
  "getRequestPath",
  "getRequestFingerprint",
  "getSession",
  "useSession",
  "toWebRequest",
]);
const HANDLER_FACTORIES = new Set([
  "defineEventHandler",
  "eventHandler",
  "defineCachedEventHandler",
  "cachedEventHandler",
  "defineHandler",
]);

type Shape = "variable" | "object" | "map";

interface StateBinding {
  name: string;
  shapes: Shape[];
  declarator: AnyNode;
  write?: AnyNode;
}

export const noRequestDataInModuleState = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep request data out of module-scope state",
    category: "state",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://v1.h3.dev/guide/event#eventcontext",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!isNitroRuntimeFile(ctx)) return;
    return {
      Program(program: AnyNode) {
        for (const binding of requestStateBindings(program)) {
          const line = ctx.range(binding.write)?.line;
          report(
            ctx,
            binding.declarator.id,
            RULE_ID,
            "warn",
            "state",
            `${binding.name} lives at module scope, and${line ? ` line ${line}` : ""} writes request data (the event, its query, body, headers, cookies, or session) into it. Nitro imports a server module once per process and hands every request the same instance, so concurrent requests overwrite each other's value and one user's data can reach another user's response.`,
            "Keep per-request values in local variables or on event.context, which h3 creates for each request. If the module needs a cache, key it by something the response really depends on, or use defineCachedFunction with a getKey that covers the user.",
          );
        }
      },
    };
  },
});

/** Module bindings that server code writes request data into, each with its first such write. */
function requestStateBindings(program: AnyNode): StateBinding[] {
  const bindings = moduleBindings(program);
  if (!bindings.size) return [];
  walkScriptLocal(program, (node) => {
    if (node.type !== "Identifier") return;
    const binding = bindings.get(node.name);
    if (!binding || binding.write || node === binding.declarator.id) return;
    if (nearestFunctionOrProgram(node)?.type === "Program") return;
    if (!resolvesToModuleBinding(node, binding.name)) return;
    const values = binding.shapes.flatMap((shape) => writtenValues(node, shape));
    if (values.some(holdsStoredRequestValue)) binding.write = node;
  });
  return [...bindings.values()].filter((binding) => binding.write);
}

function moduleBindings(program: AnyNode) {
  const bindings = new Map<string, StateBinding>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      const shapes: Shape[] = declaration.kind === "const" ? [] : ["variable"];
      const init = unwrapExpression(declarator.init);
      if (init?.type === "ObjectExpression" || init?.type === "ArrayExpression")
        shapes.push("object");
      else if (isNewMap(init)) shapes.push("map");
      if (shapes.length)
        bindings.set(declarator.id.name, { name: declarator.id.name, shapes, declarator });
    }
  }
  return bindings;
}

// Writes under keys the code spells out. A key computed at runtime makes the binding a store
// keyed per request, such as a rate limiter or a room registry, which is not shared state.
function writtenValues(reference: AnyNode, shape: Shape): AnyNode[] {
  const parent = reference.__doctorParent;
  if (shape === "variable")
    return parent?.type === "AssignmentExpression" && parent.left === reference
      ? [parent.right]
      : [];
  if (shape === "map") {
    const call = parent?.__doctorParent;
    return parent?.type === "MemberExpression" &&
      parent.object === reference &&
      !parent.computed &&
      parent.property?.name === "set" &&
      call?.type === "CallExpression" &&
      call.callee === parent &&
      staticPropertyKey(call.arguments?.[0], true) !== undefined
      ? call.arguments.slice(1, 2)
      : [];
  }
  let target = reference;
  while (
    target.__doctorParent?.type === "MemberExpression" &&
    target.__doctorParent.object === target
  ) {
    target = target.__doctorParent;
    if (target.computed && staticPropertyKey(target.property, true) === undefined) return [];
  }
  const assignment = target.__doctorParent;
  if (
    target !== reference &&
    assignment?.type === "AssignmentExpression" &&
    assignment.left === target
  )
    return [assignment.right];
  if (
    target === reference &&
    parent?.type === "CallExpression" &&
    parent.arguments?.[0] === reference &&
    isObjectAssign(parent.callee)
  ) {
    const slots = new Map<string, AnyNode>();
    for (const source of parent.arguments.slice(1)) collectFixedProperties(source, slots, parent);
    return [...slots.values()];
  }
  return [];
}

function collectFixedProperties(
  source: AnyNode,
  slots: Map<string, AnyNode>,
  snapshot: AnyNode,
  depth = 0,
): void {
  let object = unwrapExpression(source);
  let declaration: AnyNode;
  while (depth <= 5 && object?.type === "Identifier") {
    const binding = resolveLexicalBinding(object);
    if (!isLocalConst(binding)) break;
    declaration = binding;
    object = unwrapExpression(binding.init);
    depth++;
  }
  if (
    depth > 5 ||
    object?.type !== "ObjectExpression" ||
    (declaration && !keepsSourceSlots(declaration, object, snapshot))
  ) {
    slots.clear();
    return;
  }
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      collectFixedProperties(property.argument, slots, property, depth + 1);
      continue;
    }
    const key = staticPropertyKey(property.key, property.computed);
    if (key === undefined) slots.clear();
    else if (property.kind !== "init") slots.delete(key);
    else if (key !== "__proto__" || property.computed || property.shorthand || property.method)
      slots.set(key, property.value);
  }
}

function isLocalConst(binding: AnyNode) {
  return (
    binding?.type === "VariableDeclarator" &&
    binding.id?.type === "Identifier" &&
    binding.__doctorParent?.kind === "const" &&
    binding.__doctorParent.__doctorParent?.type !== "ExportNamedDeclaration"
  );
}

function keepsSourceSlots(
  binding: AnyNode,
  object: AnyNode,
  snapshot: AnyNode,
  allocation = binding,
  depth = 0,
): boolean {
  if (depth > 5 || !isLocalConst(binding)) return false;

  let program = binding;
  while (program.__doctorParent) program = program.__doctorParent;
  return scriptNodesOfType(program, "Identifier").every((node) => {
    if (node.name !== binding.id.name || node === binding.id) return true;
    const use = outerExpression(node);
    const parent = use.__doctorParent;
    if (!parent?.computed && parent?.key === use && parent.value !== use) return true;
    if (parent?.type === "MemberExpression" && !parent.computed && parent.property === use)
      return true;
    if (resolveLexicalBinding(node) !== binding) return true;

    if (parent?.type === "VariableDeclarator" && parent.init === use)
      return keepsSourceSlots(parent, object, snapshot, allocation, depth + 1);
    if (parent?.type === "MemberExpression" && parent.object === use) {
      const member = outerExpression(parent);
      const access = member.__doctorParent;
      if (
        access?.type === "AssignmentExpression" &&
        access.left === member &&
        isLaterStatement(access, snapshot, allocation)
      )
        return true;
      return isPlainPropertyRead(parent, access, object);
    }
    if (parent?.type === "SpreadElement") return parent.__doctorParent?.type === "ObjectExpression";
    return (
      parent?.type === "CallExpression" &&
      isObjectAssign(parent.callee) &&
      parent.arguments.indexOf(use) > 0
    );
  });
}

function outerExpression(node: AnyNode): AnyNode {
  let outer = node;
  while (unwrapExpression(outer.__doctorParent) === node) outer = outer.__doctorParent;
  return outer;
}

function isLaterStatement(write: AnyNode, snapshot: AnyNode, allocation: AnyNode) {
  const statement = write.__doctorParent;
  const block = allocation.__doctorParent?.__doctorParent;
  if (
    block?.type !== "BlockStatement" ||
    statement?.type !== "ExpressionStatement" ||
    statement.__doctorParent !== block ||
    nearestFunctionOrProgram(write) !== nearestFunctionOrProgram(snapshot)
  )
    return false;
  let earlier = snapshot;
  while (earlier.__doctorParent && earlier.__doctorParent !== block)
    earlier = earlier.__doctorParent;
  return (
    earlier.__doctorParent === block &&
    (earlier.type === "ExpressionStatement" || earlier.type === "VariableDeclaration") &&
    (earlier.end ?? Infinity) <= (statement.start ?? -1)
  );
}

function isPlainPropertyRead(property: AnyNode, consumer: AnyNode, object: AnyNode) {
  const member = outerExpression(property);
  if (
    !consumer ||
    (consumer.type === "AssignmentExpression" && consumer.left === member) ||
    (consumer.type === "UnaryExpression" && consumer.operator === "delete") ||
    (consumer.type === "CallExpression" && consumer.callee === member) ||
    (consumer.type === "TaggedTemplateExpression" && consumer.tag === member) ||
    (consumer.type === "Property" && consumer.__doctorParent?.type === "ObjectPattern") ||
    ["UpdateExpression", "AssignmentPattern", "RestElement", "ArrayPattern"].includes(
      consumer.type,
    ) ||
    ((consumer.type === "ForOfStatement" || consumer.type === "ForInStatement") &&
      consumer.left === member)
  )
    return false;
  const key = staticPropertyKey(property.property, property.computed);
  if (key === undefined) return false;
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    if (property.type === "SpreadElement") return false;
    const candidate = staticPropertyKey(property.key, property.computed);
    if (candidate === undefined) return false;
    if (candidate === key)
      return (
        property.kind === "init" &&
        (key !== "__proto__" || property.computed || property.shorthand || property.method)
      );
  }
  return false;
}

function staticPropertyKey(node: AnyNode, computed: boolean, depth = 0): string | undefined {
  const key = unwrapExpression(node);
  if (key?.type === "Identifier") {
    if (!computed) return key.name;
    if (depth < 5) {
      const binding = resolveLexicalBinding(key);
      if (
        binding?.type === "VariableDeclarator" &&
        binding.id?.type === "Identifier" &&
        binding.__doctorParent?.kind === "const"
      )
        return staticPropertyKey(binding.init, true, depth + 1);
    }
  }
  if (key?.type === "TemplateLiteral" && !key.expressions.length)
    return key.quasis[0]?.value.cooked ?? undefined;
  if (
    (key?.type === "Literal" && !key.regex) ||
    key?.type === "StringLiteral" ||
    key?.type === "NumericLiteral"
  )
    return String(key.bigint ?? key.value);
}

function isNewMap(node: AnyNode) {
  return (
    node?.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "Map" &&
    !moduleNames(node).has("Map")
  );
}

function isObjectAssign(callee: AnyNode) {
  const node = unwrapExpression(callee);
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === "Object" &&
    !resolveLexicalBinding(node.object) &&
    node.property?.name === "assign"
  );
}

function holdsStoredRequestValue(value: AnyNode) {
  const stored = unwrapExpression(value);
  const sources: RequestValueSources = {
    isSource: (node) =>
      node.type === "CallExpression" &&
      REQUEST_READERS.has(h3Name(unwrapExpression(node.callee)) ?? ""),
    // The event a handler receives, or a parameter typed H3Event, except when it is only passed on
    // to another call: what that call returns is not known to depend on the request.
    parameter: (fn, index, reference) =>
      (isTypedEvent(fn.params[index]) || (index === 0 && isHandlerCallback(fn))) &&
      (reference === stored || !isCallArgument(reference)),
  };
  return holdsRequestValue(value, sources);
}

/** The h3 export `callee` names, through an import or Nitro's auto-import, or null. */
function h3Name(callee: AnyNode): string | null {
  if (callee?.type !== "Identifier" || !resolvesToModuleBinding(callee, callee.name)) return null;
  let program = callee;
  while (program.__doctorParent) program = program.__doctorParent;
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name !== callee.name) continue;
      if (statement.importKind === "type" || specifier.importKind === "type") return null;
      if (specifier.type !== "ImportSpecifier" || !H3_SOURCES.test(String(statement.source.value)))
        return null;
      return String(specifier.imported?.name ?? specifier.imported?.value);
    }
  }
  return moduleNames(callee).has(callee.name) ? null : callee.name;
}

function isHandlerCallback(fn: AnyNode) {
  let owner = fn.__doctorParent;
  // `defineEventHandler({ handler(event) {} })` and `{ handler: (event) => {} }`.
  if (owner?.type === "Property" && owner.value === fn && propertyName(owner) === "handler")
    owner = owner.__doctorParent?.__doctorParent;
  if (owner?.type !== "CallExpression") return false;
  const argument = unwrapExpression(owner.arguments?.[0]);
  if (argument !== fn && argument !== fn.__doctorParent?.__doctorParent) return false;
  return HANDLER_FACTORIES.has(h3Name(unwrapExpression(owner.callee)) ?? "");
}

function propertyName(property: AnyNode) {
  return property.computed ? null : (property.key?.name ?? property.key?.value);
}

function isTypedEvent(param: AnyNode) {
  const type = param?.typeAnnotation?.typeAnnotation;
  return type?.type === "TSTypeReference" && type.typeName?.name === "H3Event";
}

function isCallArgument(reference: AnyNode) {
  let node = reference;
  while (node.__doctorParent && unwrapExpression(node.__doctorParent) !== node.__doctorParent)
    node = node.__doctorParent;
  const parent = node.__doctorParent;
  return (
    (parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
    parent.arguments?.includes(node)
  );
}
