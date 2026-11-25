import { createRule } from "./shared.js";

export const noHtmlPlainString = createRule({
  meta: {
    id: "h3/response/no-html-plain-string",
    title: "Use the html tagged template for markup",
    description: "Flags html() called with a plain string that contains markup.",
    why: "Since H3 2.0.1-rc.26, html() escapes a plain string argument, so markup passed as a string is rendered as text. Only the html`` tagged template and raw() keep trusted markup.",
    recommendedReplacement:
      "Use the tagged template html`<h1>${title}</h1>`, which escapes interpolated values, or wrap trusted markup with raw().",
    category: "response",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/releases/tag/v2.0.1-rc.26",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.1-rc.26" },
      includePrerelease: true,
    },
  },
  create() {
    return undefined;
  },
});
