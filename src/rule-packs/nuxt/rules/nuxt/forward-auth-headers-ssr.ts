import { AnyNode, createRule, isClientOnlyPath, isNuxtRuntimeFile, report } from "./shared.js";

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
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "$fetch")) return;
        const first = node.arguments?.[0];
        const url =
          first?.value ?? (first?.start != null ? ctx.file.text.slice(first.start, first.end) : "");
        if (!String(url).startsWith("/api/")) return;
        if (!isAuthSensitiveInternalApi(String(url))) return;
        if (forwardsRequestCredentials(node)) return;
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
  return optionsForwardCredentials(call.arguments?.[1], call) === true;
}

function optionsForwardCredentials(
  value: AnyNode,
  call: AnyNode,
  seen = new Set<AnyNode>(),
): boolean | undefined {
  value = unwrapExpression(value);
  if (!value || seen.has(value)) return false;
  seen = new Set(seen).add(value);
  if (value.type === "Identifier")
    return optionsForwardCredentials(localInitializer(value, call), call, seen);
  if (value.type !== "ObjectExpression") return false;
  for (const property of [...value.properties].reverse()) {
    if (property.type === "SpreadElement") {
      const forwarded = optionsForwardCredentials(property.argument, call, seen);
      if (forwarded !== undefined) return forwarded;
    } else {
      const name = propertyName(property);
      if (!name) return false;
      if (name === "headers") return hasCredentialHeaders(property.value, call);
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

function hasCredentialHeaders(value: AnyNode, call: AnyNode): boolean {
  return [...(credentialHeaders(value, call)?.values() ?? [])].some(Boolean);
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
    return credentialHeaders(localInitializer(value, call), call, seen);
  }
  if (value.type === "NewExpression" && value.callee?.name === "Headers") {
    const input = unwrapExpression(value.arguments[0]);
    if (input?.type === "ArrayExpression") {
      const headers = new Map<string, boolean>();
      for (const entry of input.elements) {
        const tuple = unwrapExpression(entry);
        const name = tuple?.type === "ArrayExpression" && tuple.elements[0]?.value;
        if (typeof name !== "string") return;
        if (isCredentialHeader(name))
          headers.set(name.toLowerCase(), hasHeaderValue(tuple.elements[1]));
      }
      return headers;
    }
    return credentialHeaders(input, call, seen);
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
        headers.set(name.toLowerCase(), hasHeaderValue(property.value));
      }
    }
  }
  return headers;
}

function hasHeaderValue(value: AnyNode): boolean {
  const header = unwrapExpression(value);
  return header != null && !("value" in header && !header.value);
}

function resolveInitializer(value: AnyNode, call: AnyNode): AnyNode {
  const seen = new Set<AnyNode>();
  value = unwrapExpression(value);
  while (value?.type === "Identifier") {
    if (seen.has(value)) return;
    seen.add(value);
    value = unwrapExpression(localInitializer(value, call));
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

function localInitializer(identifier: AnyNode, call: AnyNode): AnyNode {
  let scope = identifier.__doctorParent ?? identifier.parent ?? call.__doctorParent ?? call.parent;
  const anchorStart = identifier.start ?? identifier.range?.[0];
  while (scope) {
    const statements = Array.isArray(scope.body) ? [...scope.body] : [];
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
    scope = scope.__doctorParent ?? scope.parent;
  }
}
