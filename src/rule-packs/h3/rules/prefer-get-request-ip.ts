import { type AnyNode, createRule, h3Major, isH3HandlerFile, report } from "./shared.js";
import { isIpHeaderRead, isRequestSensitiveUse } from "./request-helpers.js";

export const preferGetRequestIp = createRule({
  meta: {
    id: "h3/request/prefer-get-request-ip",
    title: "Use request IP utilities instead of raw IP headers",
    description:
      "Request-sensitive H3 handlers should not trust client-controlled forwarding headers directly.",
    recommendedReplacement:
      "Use getRequestIP(event) and configure trusted proxies centrally instead of reading IP headers directly.",
    category: "request",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/utils/request#getrequestipevent",
    requires: { script: true },
    prefilter: { names: ["getHeader", "getRequestHeader", "headers"] },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    return {
      CallExpression(node: AnyNode) {
        if (!isIpHeaderRead(ctx, node)) return;
        if (!isRequestSensitiveUse(ctx, node)) return;
        report(
          ctx,
          node,
          "h3/request/prefer-get-request-ip",
          "warn",
          "request",
          "This request-sensitive code reads a forwarded client IP header directly.",
          (h3Major(ctx) ?? 0) >= 2
            ? "Configure srvx's trustProxy option for the proxies in front of the server, then read the client address with getRequestIP(event) or event.req.ip."
            : "Use the h3 request IP utility with trusted proxy configuration.",
        );
      },
    };
  },
});
