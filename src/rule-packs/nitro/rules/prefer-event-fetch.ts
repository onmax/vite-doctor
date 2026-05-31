import { AnyNode, createRule, report, sourceForNode } from "./shared.js";

export const preferEventFetch = createRule({
  meta: {
    id: "nitro/server/prefer-event-fetch",
    title: "Use event.$fetch in Nitro handlers",
    description: "Proxy internal API calls through event.$fetch() when request context matters.",
    why: "$fetch() does not automatically carry request-scoped context such as headers, cookies, or event context. event.$fetch() preserves the current Nitro request context for internal server calls.",
    recommendedReplacement:
      "Use event.$fetch() when proxying to other server routes from a Nitro handler.",
    category: "server",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/routing#request-handler",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "$fetch")) return;
        if (!shouldRequireEventFetch(ctx.file.text, node)) return;
        report(
          ctx,
          node,
          "nitro/server/prefer-event-fetch",
          "warn",
          "server",
          "$fetch() in Nitro handlers does not automatically carry request event context.",
          "Use event.$fetch() when proxying to other server routes.",
        );
      },
    };
  },
});

function shouldRequireEventFetch(source: string, node: AnyNode) {
  const first = node.arguments?.[0];
  const path =
    first?.type === "Literal" && typeof first.value === "string"
      ? first.value
      : sourceForNode(first, source);
  if (!path.startsWith("/api/")) return false;
  if (isRequestSensitivePath(path)) return true;
  return hasRequestScopedContextNearby(source, node.start ?? 0);
}

function isRequestSensitivePath(path: string) {
  return /\/(?:api\/)?(?:user|users|me|session|auth|account|admin|team|teams|org|organization|settings|billing|profile|private)(?:\/|$)/i.test(
    path,
  );
}

function hasRequestScopedContextNearby(source: string, offset: number) {
  const around = source.slice(Math.max(0, offset - 700), offset + 700);
  return /\b(?:getCookie|getHeader|getRequestHeader|getUserSession|requireUserSession|useSession|requireAuth|event\.context|event\.node\.req|readValidatedBody)\b/.test(
    around,
  );
}
