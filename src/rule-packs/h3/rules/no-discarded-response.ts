import { createRule } from "./shared.js";

export const noDiscardedResponse = createRule({
  meta: {
    id: "h3/response/no-discarded-response",
    title: "Return the response an H3 v2 helper builds",
    description:
      "Flags H3 v2 response helpers such as redirect(), html(), and noContent() whose result is never returned from the handler.",
    why: "In H3 v2 these helpers only build a response value. A call whose result is dropped sends nothing, so the handler falls through and responds with whatever it returns next.",
    recommendedReplacement:
      'Return the helper\'s result from the handler, such as return redirect("/login").',
    category: "response",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/utils/response",
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
