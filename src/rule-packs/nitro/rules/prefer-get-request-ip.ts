import { type AnyNode, createRule, isNitroServerFile, report } from "./shared.js";
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
    docsUrl: "https://h3.dev/utils/request#getrequestipevent",
    requires: { script: true, nitro: true },
    prefilter: { names: ["getHeader", "getRequestHeader"] },
  },
  create(ctx) {
    if (!isNitroServerFile(ctx)) return;
    return {
      CallExpression(node: AnyNode) {
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
