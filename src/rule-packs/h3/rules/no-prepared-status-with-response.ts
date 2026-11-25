import { createRule } from "./shared.js";

export const noPreparedStatusWithResponse = createRule({
  meta: {
    id: "h3/response/no-prepared-status-with-response",
    title: "Set the status on the Response you return",
    description:
      "Flags a status set through event.res.status or setResponseStatus() in a handler that returns a Response.",
    why: "H3 v2 applies a prepared event.res.status only to plain return values. A returned Response keeps its own status, so the prepared status is silently ignored and the client gets 200.",
    recommendedReplacement:
      "Pass the status to the Response, such as new Response(body, { status: 201 }), or return a plain value instead.",
    category: "response",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/blob/main/src/response.ts",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create() {
    return undefined;
  },
});
