import { createRule } from "./shared.js";

export const noEventFirstArg = createRule({
  meta: {
    id: "h3/response/no-event-first-arg",
    title: "Drop the event argument from H3 v2 response helpers",
    description:
      "Flags redirect(), noContent(), html(), and iterable() called with the event as their first argument.",
    why: 'H3 v2 response helpers build a response value and no longer take the event. Passing it shifts every argument: redirect(event, "/login") uses the event as the location, and html(event, markup) renders the event instead of the markup.',
    recommendedReplacement:
      'Drop the event argument and return the helper\'s result, such as return redirect("/login").',
    category: "response",
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
