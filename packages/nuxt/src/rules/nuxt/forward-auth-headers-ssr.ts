import { AnyNode, createRule, isClientOnlyPath, isNuxtRuntimeFile, report } from "./shared.js";

export const forwardAuthHeadersSsr = createRule({
  meta: {
    id: "nuxt/fetch/forward-auth-headers-ssr",
    title: "Forward auth headers for SSR server fetches",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
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
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (/useRequestFetch|useFetch|headers\s*:|cookie/i.test(snippet)) return;
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
