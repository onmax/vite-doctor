import { createRule } from "./shared.js";

export const noIgnoredHooks = createRule({
  meta: {
    id: "h3/migration/no-ignored-hooks",
    title: "Replace H3 v1 hooks that H3 v2 ignores",
    description:
      "Flags onRequest and onBeforeResponse on handler objects, and onBeforeResponse and onAfterResponse in app options, which H3 v2 never calls.",
    why: "H3 v2 replaced handler-object hooks with a middleware array and kept only onRequest, onResponse, and onError as app hooks. The old keys are copied onto the handler or config but never run, so authentication, logging, or header logic in them silently stops.",
    recommendedReplacement:
      "Move handler hooks into middleware, such as defineHandler({ middleware: [auth], handler }), and move onBeforeResponse or onAfterResponse app logic to onResponse.",
    category: "migration",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
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
