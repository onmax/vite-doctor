import { type AnyNode, createRule, report } from "../nuxt/shared.js";
import { isIpHeaderRead, isRequestSensitiveUse } from "./request-helpers.js";

export const preferGetRequestIp = createRule({
  meta: {
    id: "nitro/request/prefer-get-request-ip",
    title: "Use request IP utilities instead of raw IP headers",
    description:
      "Request-sensitive Nitro code should not trust client-controlled forwarding headers directly.",
    recommendedReplacement:
      "Use the H3/Nitro request IP utility and centralize trusted proxy handling instead of reading IP headers directly.",
    category: "request",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!isIpHeaderRead(node, ctx.file.text)) return;
        if (!isRequestSensitiveUse(ctx, node)) return;
        report(
          ctx,
          node,
          "nitro/request/prefer-get-request-ip",
          "warn",
          "request",
          "This request-sensitive code reads a forwarded client IP header directly.",
          "Use the H3/Nitro request IP utility with trusted proxy configuration.",
        );
      },
    };
  },
});
