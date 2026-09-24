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
  const options = call.arguments?.[1];
  if (options?.type !== "ObjectExpression") return false;
  const headers = options.properties.find(
    (property: AnyNode) => propertyName(property) === "headers",
  );
  return hasCredentialHeaders(headers?.value, call);
}

function hasCredentialHeaders(value: AnyNode, call: AnyNode, seen = new Set<AnyNode>()): boolean {
  if (!value || seen.has(value)) return false;
  seen.add(value);
  if (value.type === "Identifier") {
    return hasCredentialHeaders(localInitializer(value, call), call, seen);
  }
  if (value?.type === "CallExpression" && value.callee?.name === "useRequestHeaders") {
    const selected = value.arguments[0];
    return (
      !selected ||
      (selected.type === "ArrayExpression" &&
        selected.elements.some((element: AnyNode) => isCredentialHeader(element?.value)))
    );
  }
  return (
    value?.type === "ObjectExpression" &&
    value.properties.some((property: AnyNode) =>
      property.type === "SpreadElement"
        ? hasCredentialHeaders(property.argument, call, seen)
        : isCredentialHeader(propertyName(property)),
    )
  );
}

function localInitializer(identifier: AnyNode, call: AnyNode): AnyNode {
  let scope = call.__doctorParent ?? call.parent;
  while (scope) {
    if (Array.isArray(scope.body)) {
      for (const statement of scope.body) {
        if (statement.type !== "VariableDeclaration") continue;
        const declaration = statement.declarations.find(
          (item: AnyNode) => item.id?.type === "Identifier" && item.id.name === identifier.name,
        );
        if (declaration) return statement.kind === "const" ? declaration.init : undefined;
      }
    }
    if (scope.params?.some((param: AnyNode) => param.name === identifier.name)) return;
    scope = scope.__doctorParent ?? scope.parent;
  }
}
