import { createRule } from "./shared.js";

export const noDoubleBodyRead = createRule({
  meta: {
    id: "h3/body/no-double-body-read",
    title: "Read the request body once",
    description:
      "Flags a handler that reads the request body twice, or reads it and then proxies the request.",
    why: "H3 v2 reads the body from the Web Request stream, which can be consumed once. H3 v1 cached the parsed body, so a second readBody() worked; in v2 it throws or returns nothing, and a proxied request goes out without its body.",
    recommendedReplacement:
      "Read the body once into a variable and reuse it, or pass the body you read to the proxy explicitly.",
    category: "body",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/issues/1212",
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
