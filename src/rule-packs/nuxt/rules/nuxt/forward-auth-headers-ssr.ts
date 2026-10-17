import type { RuleContext } from "../../../../core/index.js";
import { getObjectPropertyValue, isFalseLiteral } from "./async-data.js";
import { findStatementBinding, patternNames } from "./script-index.js";
import {
  AnyNode,
  classifyExecutionEvidence,
  createRule,
  isClientOnlyPath,
  isNuxtRuntimeFile,
  nearestFunctionOrProgram,
  report,
  walkScriptLocal,
} from "./shared.js";

export const forwardAuthHeadersSsr = createRule({
  meta: {
    id: "nuxt/fetch/forward-auth-headers-ssr",
    title: "Forward auth headers for SSR server fetches",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/getting-started/data-fetching#pass-client-headers-to-the-api",
    requires: { script: true, nuxt: true },
    prefilter: { calls: ["$fetch"] },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      CallExpression(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "$fetch")) return;
        const first = node.arguments?.[0];
        const url =
          first?.value ?? (first?.start != null ? ctx.file.text.slice(first.start, first.end) : "");
        if (!String(url).startsWith("/api/")) return;
        if (!isAuthSensitiveInternalApi(String(url))) return;
        if (forwardsRequestCredentials(node)) return;
        if (!runsDuringSsr(ctx, node, new Set())) return;
        report(
          ctx,
          node,
          "nuxt/fetch/forward-auth-headers-ssr",
          "warn",
          "fetching",
          "SSR $fetch() to an internal API route may omit request cookies and auth headers.",
          "Use useFetch(), useRequestFetch(), or forward selected headers explicitly.",
        );
      },
    };
  },
});

const DEFERRED_EXECUTION = new Set([
  "client-only",
  "lifecycle-only",
  "event-handler",
  "server-only",
]);
const DEFERRING_CALLS = new Set([
  "onMounted",
  "onBeforeMount",
  "onBeforeUnmount",
  "onUnmounted",
  "watch",
  "watchPostEffect",
  "nextTick",
]);
const ASYNC_DATA_ENTRIES = new Set(["useAsyncData", "useLazyAsyncData", "callOnce"]);
const SSR_CALLBACK_ENTRIES = new Set([
  "defineNuxtPlugin",
  "defineNuxtRouteMiddleware",
  "watchEffect",
  "watchSyncEffect",
]);
const localReferences = new WeakMap<object, Map<string, AnyNode[]>>();

// Only requests with evidence of running during SSR miss the browser's cookies.
function runsDuringSsr(ctx: RuleContext, node: AnyNode, seen: Set<AnyNode>): boolean {
  const evidence = classifyExecutionEvidence(ctx, node);
  if (evidence === "lifecycle-only" ? !onlyInSsrWatchers(node) : DEFERRED_EXECUTION.has(evidence))
    return false;
  const scope = nearestFunctionOrProgram(node);
  if (!scope || seen.has(scope)) return false;
  if (scope.type === "Program") return true;
  seen.add(scope);
  const parent = scope.__doctorParent;
  if (parent?.type === "CallExpression" || parent?.type === "NewExpression") {
    if (parent.callee === scope) return runsDuringSsr(ctx, parent, seen);
    const callee = ctx.helpers.getCalleeName(parent) ?? "";
    if (ASYNC_DATA_ENTRIES.has(callee) && !asyncDataRunsOnServer(parent, scope)) return false;
    return runsDuringSsr(ctx, parent, seen);
  }
  if (
    (parent?.type === "Property" || parent?.type === "MethodDefinition") &&
    parent.value === scope &&
    !parent.computed &&
    (parent.key?.name ?? parent.key?.value) === "setup"
  )
    return true;
  const name = functionName(scope);
  if (!name) return false;
  if (/^use[A-Z]/.test(name)) return true;
  const declaration = scope.type === "FunctionDeclaration" ? scope : scope.__doctorParent;
  return (references(ctx).get(name) ?? []).some((reference) => {
    if (resolveBinding(reference) !== declaration) return false;
    const call = reference.__doctorParent;
    if (call.callee !== reference) {
      const callee = ctx.helpers.getCalleeName(call) ?? "";
      const runs = ASYNC_DATA_ENTRIES.has(callee)
        ? asyncDataRunsOnServer(call, reference)
        : SSR_CALLBACK_ENTRIES.has(callee);
      if (!runs) return false;
    }
    return runsDuringSsr(ctx, call, seen);
  });
}

// Vue runs `watchEffect()` callbacks once during SSR setup. `watch()` callbacks count as
// deferred in the shared classifier, so immediate watchers stay unreported.
function onlyInSsrWatchers(node: AnyNode): boolean {
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (current.type !== "CallExpression") continue;
    const name = current.callee?.name ?? current.callee?.property?.name ?? "";
    if (DEFERRING_CALLS.has(name)) return false;
  }
  return true;
}

function asyncDataRunsOnServer(call: AnyNode, handler: AnyNode): boolean {
  const last = call.arguments?.at(-1);
  if (!last || last === handler) return true;
  const options = resolveLocalObject(last);
  if (!options) return false;
  if (
    options.properties?.some(
      (property: AnyNode) =>
        property.type === "SpreadElement" || property.type === "SpreadProperty",
    )
  )
    return false;
  return !["server", "immediate"].some((key) =>
    isFalseLiteral(getObjectPropertyValue(options, key)),
  );
}

function resolveLocalObject(node: AnyNode): AnyNode {
  const value = unwrapExpression(node);
  if (value?.type === "ObjectExpression") return value;
  if (value?.type !== "Identifier") return null;
  const binding = resolveBinding(value);
  if (binding?.type !== "VariableDeclarator" || binding.__doctorParent?.kind !== "const")
    return null;
  if (binding.id?.type !== "Identifier") return null;
  const init = unwrapExpression(binding.init);
  return init?.type === "ObjectExpression" ? init : null;
}

function resolveBinding(identifier: AnyNode): AnyNode {
  for (let scope = identifier.__doctorParent; scope; scope = scope.__doctorParent) {
    if (scope.params?.some((param: AnyNode) => patternNames(param).includes(identifier.name)))
      return null;
    const binding = findStatementBinding(scope, identifier.name);
    if (binding) return binding;
  }
  return null;
}

function functionName(fn: AnyNode): string | undefined {
  if (fn.type === "FunctionDeclaration") return fn.id?.name;
  const parent = fn.__doctorParent;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.init === fn &&
    parent.id?.type === "Identifier"
  )
    return parent.id.name;
}

// Calls by name, plus names passed as callbacks that run during SSR.
function references(ctx: RuleContext): Map<string, AnyNode[]> {
  const program = ctx.file.scriptAst ?? {};
  let collected = localReferences.get(program);
  if (collected) return collected;
  const found = new Map<string, AnyNode[]>();
  localReferences.set(program, found);
  const add = (identifier: AnyNode) =>
    found.set(identifier.name, [...(found.get(identifier.name) ?? []), identifier]);
  walkScriptLocal(program, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type === "Identifier") add(node.callee);
    const callee = ctx.helpers.getCalleeName(node) ?? "";
    if (!ASYNC_DATA_ENTRIES.has(callee) && !SSR_CALLBACK_ENTRIES.has(callee)) return;
    for (const argument of node.arguments ?? []) if (argument?.type === "Identifier") add(argument);
  });
  return found;
}

function isAuthSensitiveInternalApi(url: string): boolean {
  return /\/api\/(?:auth|admin|account|user|users|me|profile|session|feedback|agent|private|billing|settings)(?:\/|$)/i.test(
    url,
  );
}

function propertyName(property: AnyNode): string | undefined {
  if (property.type !== "Property") return;
  if (!property.computed && property.key?.type === "Identifier") return property.key.name;
  return typeof property.key?.value === "string" ? property.key.value : undefined;
}

function isCredentialHeader(name: string | undefined): boolean {
  return /^(?:cookie|authorization)$/i.test(name ?? "");
}

function forwardsRequestCredentials(call: AnyNode): boolean {
  const headers = optionsCredentialHeaders(call.arguments?.[1], call);
  return headers ? [...headers.values()].some(Boolean) : false;
}

function optionsCredentialHeaders(
  value: AnyNode,
  call: AnyNode,
  seen = new Set<AnyNode>(),
): Map<string, boolean> | false | undefined {
  value = unwrapExpression(value);
  if (!value || seen.has(value)) return false;
  seen = new Set(seen).add(value);
  if (value.type === "Identifier")
    return optionsCredentialHeaders(unmodifiedInitializer(value, call), call, seen);
  if (value.type !== "ObjectExpression") return false;
  for (const property of [...value.properties].reverse()) {
    if (property.type === "SpreadElement") {
      const forwarded = optionsCredentialHeaders(property.argument, call, seen);
      if (forwarded !== undefined) return forwarded;
    } else {
      const name = propertyName(property);
      if (!name) return false;
      if (name === "headers") return credentialHeaders(property.value, call, seen) ?? false;
    }
  }
}

function unwrapExpression(value: AnyNode): AnyNode {
  while (
    value &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "ParenthesizedExpression",
    ].includes(value.type)
  ) {
    value = value.expression;
  }
  return value;
}

function credentialHeaders(
  value: AnyNode,
  call: AnyNode,
  seen = new Set<AnyNode>(),
): Map<string, boolean> | undefined {
  value = unwrapExpression(value);
  if (!value || seen.has(value)) return;
  seen = new Set(seen).add(value);
  if (value.type === "Identifier") {
    return credentialHeaders(unmodifiedInitializer(value, call), call, seen);
  }
  if (isHeadersAccess(value)) {
    return optionsCredentialHeaders(value.object, call, seen) || undefined;
  }
  if (value.type === "NewExpression" && value.callee?.name === "Headers") {
    const input = unwrapExpression(value.arguments[0]);
    return credentialHeaders(input, call, seen);
  }
  if (value.type === "ArrayExpression") {
    const headers = new Map<string, boolean>();
    for (const entry of value.elements) {
      const tuple = unwrapExpression(entry);
      const name = tuple?.type === "ArrayExpression" && tuple.elements[0]?.value;
      if (typeof name !== "string") return;
      if (isCredentialHeader(name))
        headers.set(name.toLowerCase(), hasHeaderValue(tuple.elements[1], call));
    }
    return headers;
  }
  if (value.type === "CallExpression" && value.callee?.name === "useRequestHeaders") {
    const selected = resolveInitializer(value.arguments[0], call);
    if (!value.arguments[0])
      return new Map([
        ["cookie", true],
        ["authorization", true],
      ]);
    if (selected?.type !== "ArrayExpression") return;
    return new Map(
      selected.elements
        .filter((element: AnyNode) => isCredentialHeader(element?.value))
        .map((element: AnyNode) => [element.value.toLowerCase(), true]),
    );
  }
  if (value.type !== "ObjectExpression") return;
  const headers = new Map<string, boolean>();
  for (const property of value.properties) {
    if (property.type === "SpreadElement") {
      const spread = credentialHeaders(property.argument, call, seen);
      if (!spread) {
        headers.set("cookie", false);
        headers.set("authorization", false);
      }
      if (spread) for (const [name, present] of spread) headers.set(name, present);
    } else {
      const name = propertyName(property);
      if (!name) {
        headers.set("cookie", false);
        headers.set("authorization", false);
      } else if (isCredentialHeader(name)) {
        headers.set(name.toLowerCase(), hasHeaderValue(property.value, call));
      }
    }
  }
  return headers;
}

function hasHeaderValue(value: AnyNode, call: AnyNode, seen = new Set<AnyNode>()): boolean {
  const header = unwrapExpression(value);
  if (header?.type === "Identifier" && !seen.has(header)) {
    const initializer = localInitializer(header, call);
    if (initializer) return hasHeaderValue(initializer, call, new Set(seen).add(header));
  }
  return (
    header != null &&
    !(header.type === "Identifier" && header.name === "undefined") &&
    !(header.type === "UnaryExpression" && header.operator === "void") &&
    !("value" in header && !header.value)
  );
}

function resolveInitializer(value: AnyNode, call: AnyNode): AnyNode {
  const seen = new Set<AnyNode>();
  value = unwrapExpression(value);
  while (value?.type === "Identifier") {
    if (seen.has(value)) return;
    seen.add(value);
    value = unwrapExpression(unmodifiedInitializer(value, call));
  }
  return value;
}

function bindsName(pattern: AnyNode, name: string): boolean {
  if (!pattern) return false;
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "AssignmentPattern") return bindsName(pattern.left, name);
  if (pattern.type === "RestElement") return bindsName(pattern.argument, name);
  if (pattern.type === "ArrayPattern")
    return pattern.elements.some((element: AnyNode) => bindsName(element, name));
  if (pattern.type === "ObjectPattern")
    return pattern.properties.some((property: AnyNode) =>
      bindsName(property.type === "RestElement" ? property.argument : property.value, name),
    );
  return false;
}

function hasHoistedBinding(node: AnyNode, name: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((item) => hasHoistedBinding(item, name));
  if (
    [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
      "ClassDeclaration",
      "ClassExpression",
      "StaticBlock",
    ].includes(node.type)
  )
    return false;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    return node.declarations.some((declaration: AnyNode) => bindsName(declaration.id, name));
  }
  return Object.entries(node).some(([key, child]) => {
    if (key === "parent" || key.startsWith("__")) return false;
    return Array.isArray(child)
      ? child.some((item) => hasHoistedBinding(item, name))
      : hasHoistedBinding(child, name);
  });
}

function localInitializer(identifier: AnyNode, call: AnyNode, scopes?: AnyNode[]): AnyNode {
  let scope =
    scopes?.[0] ??
    identifier.__doctorParent ??
    identifier.parent ??
    call.__doctorParent ??
    call.parent;
  let scopeIndex = 0;
  const anchorStart = identifier.start ?? identifier.range?.[0];
  while (scope) {
    const statements = Array.isArray(scope.body) ? [...scope.body] : [];
    if (scope.type === "SwitchStatement")
      statements.push(...scope.cases.flatMap((branch: AnyNode) => branch.consequent));
    const loopDeclaration = scope.init ?? scope.left;
    if (loopDeclaration?.type === "VariableDeclaration") statements.push(loopDeclaration);
    for (const statement of statements) {
      if (statement.type === "VariableDeclaration") {
        const declaration = statement.declarations.find((item: AnyNode) =>
          bindsName(item.id, identifier.name),
        );
        if (declaration) {
          const end = declaration.end ?? declaration.range?.[1];
          return statement.kind === "const" &&
            declaration.id.type === "Identifier" &&
            end <= anchorStart
            ? declaration.init
            : undefined;
        }
      }
      if (
        (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
        statement.id?.name === identifier.name
      )
        return;
    }
    if (
      (scope.type === "Program" || scope.type === "StaticBlock" || scope.params) &&
      hasHoistedBinding(scope.body, identifier.name)
    )
      return;
    if (scope.type === "CatchClause" && bindsName(scope.param, identifier.name)) return;
    if (scope.params?.some((param: AnyNode) => bindsName(param, identifier.name))) return;
    if (
      (scope.type === "FunctionExpression" || scope.type === "ClassExpression") &&
      scope.id?.name === identifier.name
    )
      return;
    scope = scopes ? scopes[++scopeIndex] : (scope.__doctorParent ?? scope.parent);
  }
}

function lexicalAncestors(node: AnyNode): AnyNode[] {
  const ancestors: AnyNode[] = [];
  for (
    let parent = node.__doctorParent ?? node.parent;
    parent;
    parent = parent.__doctorParent ?? parent.parent
  ) {
    ancestors.push(parent);
  }
  return ancestors;
}

function unmodifiedInitializer(identifier: AnyNode, call: AnyNode): AnyNode {
  const initializer = localInitializer(identifier, call);
  if (!initializer) return;
  let scope = initializer.__doctorParent ?? initializer.parent;
  while (scope && scope.type !== "Program" && scope.type !== "BlockStatement")
    scope = scope.__doctorParent ?? scope.parent;
  if (!scope) return;
  const callAncestors = lexicalAncestors(call);
  const callExecutionScope = callAncestors.find(
    (ancestor) => ancestor.params || ancestor.type === "Program",
  );
  const initializerExecutionScope = lexicalAncestors(initializer).find(
    (ancestor) => ancestor.params || ancestor.type === "Program",
  );
  // Closure writes and repeated loop iterations can precede the inspected request.
  function hasUnsafeReference(node: AnyNode, ancestors: AnyNode[] = [], key?: string): boolean {
    if (!node || typeof node !== "object") return false;
    const parent = ancestors[0];
    if (node.params?.some((param: AnyNode) => bindsName(param, identifier.name))) return false;
    if (node.type === "Identifier" && node.name === identifier.name) {
      if (parent?.type === "VariableDeclarator" && key === "id") return false;
      if (parent?.type === "Property" && key === "key" && !parent.computed) return false;
      if (parent?.type === "MemberExpression" && key === "property" && !parent.computed)
        return false;
      if (node === identifier) return false;
      const referenceAncestors = [...ancestors, ...lexicalAncestors(scope)];
      if (localInitializer(node, call, referenceAncestors) !== initializer) return false;
      if ((node.start ?? node.range?.[0]) > (call.end ?? call.range?.[1])) {
        const sharesLoop = callAncestors.some(
          (ancestor) =>
            [
              "ForStatement",
              "ForInStatement",
              "ForOfStatement",
              "WhileStatement",
              "DoWhileStatement",
            ].includes(ancestor.type) && referenceAncestors.includes(ancestor),
        );
        if (
          !sharesLoop &&
          initializerExecutionScope === callExecutionScope &&
          referenceAncestors.find((ancestor) => ancestor.params || ancestor.type === "Program") ===
            callExecutionScope
        )
          return false;
      }
      if (isFetchArgument(node, ancestors)) return false;
      if (
        parent?.type === "MemberExpression" &&
        key === "object" &&
        !parent.computed &&
        parent.property.name !== "headers"
      ) {
        const consumer = ancestors[1];
        if (consumer?.type === "VariableDeclarator" && consumer.init === parent) return false;
        if (consumer?.type === "ExpressionStatement") return false;
      }
      return true;
    }
    return Object.entries(node).some(([childKey, child]) => {
      if (childKey === "parent" || childKey.startsWith("__")) return false;
      return Array.isArray(child)
        ? child.some((item) => hasUnsafeReference(item, [node, ...ancestors], childKey))
        : hasUnsafeReference(child, [node, ...ancestors], childKey);
    });
  }
  return hasUnsafeReference(scope) ? undefined : initializer;
}

function isHeadersAccess(value: AnyNode): boolean {
  return (
    value.type === "MemberExpression" &&
    (value.computed ? value.property?.value === "headers" : value.property?.name === "headers")
  );
}

function isFetchArgument(node: AnyNode, ancestors: AnyNode[]): boolean {
  let value = node;
  for (const parent of ancestors) {
    if (parent.type === "CallExpression")
      return (
        parent.callee?.type === "Identifier" &&
        parent.callee.name === "$fetch" &&
        parent.arguments[1] === value
      );
    if (
      unwrapExpression(parent) === value ||
      (isHeadersAccess(parent) && parent.object === value) ||
      (parent.type === "SpreadElement" && parent.argument === value) ||
      (parent.type === "Property" &&
        parent.value === value &&
        propertyName(parent) === "headers") ||
      parent.type === "ObjectExpression"
    ) {
      value = parent;
    } else return false;
  }
  return false;
}
