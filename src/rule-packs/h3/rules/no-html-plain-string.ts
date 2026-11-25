import {
  type AnyNode,
  createRule,
  isH3Call,
  isH3HandlerFile,
  report,
  sourceForNode,
} from "./shared.js";

function asTemplate(markup: string): string {
  if (markup.startsWith("`")) return markup;
  const inner = markup.slice(1, -1);
  return /[`\\]|\$\{/.test(inner) ? `\`...\`` : `\`${inner}\``;
}

// Escaping a bare `<` still renders it; only a tag shows up as literal text.
const tag = /<[a-z!/]/i;

function hasMarkup(node: AnyNode): boolean {
  if (node?.type === "Literal") return typeof node.value === "string" && tag.test(node.value);
  if (node?.type !== "TemplateLiteral") return false;
  return node.quasis.some((quasi: AnyNode) => tag.test(quasi.value.cooked ?? ""));
}

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
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    return {
      CallExpression(node: AnyNode) {
        if (!isH3Call(ctx, node, ["html"]) || node.arguments.length !== 1) return;
        if (!hasMarkup(node.arguments[0])) return;
        const markup = sourceForNode(node.arguments[0], ctx.file.text);
        const callee = sourceForNode(node.callee, ctx.file.text);
        report(
          ctx,
          node,
          "h3/response/no-html-plain-string",
          "warn",
          "response",
          "html() escapes a plain string, so this markup is sent as text and the browser shows the tags.",
          `Use the tagged template, which escapes only interpolated values: ${callee}${asTemplate(markup)}. Wrap other trusted markup with raw().`,
        );
      },
    };
  },
});
