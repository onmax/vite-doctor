import { codeForRuleId, diagnosticForCode } from "../../../../core/index.js";
import type {
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../../core/internal-diagnostic-handles.js";
import { walkTemplate } from "../../../../core/internal/template.js";
import { diagnosticCodesByRuleId, diagnostics } from "../../diagnostics.js";
import { HtmlSourceTracer, type HtmlSource, type TemplateLocals } from "./html-source.js";
import { createRule } from "./shared.js";

const RULE_ID = "vue/security/restrict-v-html";
const NAMES = /[A-Za-z_$][\w$]*/g;

export const restrictVHtml = createRule({
  meta: {
    id: RULE_ID,
    title: "Restrict v-html to trusted HTML",
    category: "security",
    severity: "error",
    confidence: "heuristic-high",
    fixable: false,
    docsUrl: "https://vuejs.org/guide/best-practices/security.html#html-injection",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    let tracer: HtmlSourceTracer | undefined;
    const scopes: TemplateLocals[] = [new Map()];
    const opened = new Set<TemplateElementNode>();
    return {
      template: {
        element(node) {
          const locals = templateLocals(ctx, node, scopes.at(-1)!);
          if (locals) {
            scopes.push(locals);
            opened.add(node);
          }
          const directive = node.props.find(
            (prop): prop is TemplateDirectiveNode => prop.type === 7 && prop.name === "html",
          );
          if (!directive) return;
          const expression = directive.exp && ctx.helpers.parseTemplateExpression(directive.exp);
          const source: HtmlSource = expression
            ? (tracer ??= new HtmlSourceTracer(ctx, modelTargets(ctx))).templateExpression(
                expression,
                scopes.at(-1)!,
              )
            : directive.exp?.content.trim()
              ? { trust: "unknown", source: "an expression Doctor could not parse" }
              : { trust: "trusted" };
          if (source.trust !== "trusted")
            reportSource(ctx, node, directive.exp?.content.trim() ?? "", source);
        },
        "element:exit"(node) {
          if (opened.delete(node)) scopes.pop();
        },
      },
    };
  },
});

function reportSource(
  ctx: RuleContext,
  node: TemplateElementNode,
  expression: string,
  source: Exclude<HtmlSource, { trust: "trusted" }>,
) {
  const code = codeForRuleId(diagnosticCodesByRuleId, RULE_ID);
  const diagnostic = code && diagnosticForCode(diagnostics, code);
  if (!diagnostic) throw doctorInternalDiagnostics.DOC0013({ ruleId: RULE_ID });
  const via = source.via ? ` ${source.via} keeps any raw HTML in that value.` : "";
  const why =
    source.trust === "untrusted"
      ? `v-html inserts \`${expression}\` as HTML without escaping it, and the value comes from ${source.source}, which a visitor can control.${via} Markup in it such as \`<img src=x onerror=...>\` runs as script in the page.`
      : `v-html inserts \`${expression}\` as HTML without escaping it, and Doctor could not trace where ${source.source} gets its value.${via} If it can hold text from a visitor, a request, the URL, or storage, markup in it runs as script in the page.`;
  const fix =
    source.trust === "untrusted"
      ? "Render the value as text with {{ }} or v-text, or sanitize it with DOMPurify.sanitize() or sanitize-html before binding it to v-html."
      : "Check where the value is made. Sanitize it there with DOMPurify.sanitize() or sanitize-html, or render it as text. If only your own code or an escaping renderer such as Shiki produces it, suppress this diagnostic with that reason.";
  ctx.helpers.report(ctx, node, diagnostic({ why, fix }), {
    ruleId: RULE_ID,
    severity: source.trust === "untrusted" ? "error" : "warn",
    category: "security",
    confidence: source.trust === "untrusted" ? "heuristic-high" : "heuristic-low",
    evidence: [
      {
        kind: "ast",
        file: ctx.file.path,
        summary:
          source.trust === "untrusted"
            ? `Traced \`${expression}\` to ${source.source}.`
            : `Could not trace \`${expression}\` past ${source.source}.`,
      },
    ],
  });
}

/** The names `v-for` and `v-slot` on this element add, or `null` when it adds none. */
function templateLocals(
  ctx: RuleContext,
  node: TemplateElementNode,
  outer: TemplateLocals,
): TemplateLocals | null {
  let locals: Map<string, { list: unknown; locals: TemplateLocals }> | null = null;
  for (const prop of node.props) {
    if (prop.type !== 7) continue;
    if (prop.name === "for" && prop.forParseResult) {
      const list = ctx.helpers.parseTemplateExpression(prop.forParseResult.source);
      const { value, key, index } = prop.forParseResult;
      for (const alias of [value, key, index])
        for (const name of alias?.content.match(NAMES) ?? [])
          (locals ??= new Map(outer)).set(name, { list, locals: outer });
    }
    if (prop.name === "slot" && prop.exp)
      for (const name of prop.exp.content.match(NAMES) ?? [])
        (locals ??= new Map(outer)).set(name, { list: null, locals: outer });
  }
  return locals as TemplateLocals | null;
}

/** Property paths that a `v-model` in the template writes. */
function modelTargets(ctx: RuleContext): Set<string> {
  const names = new Set<string>();
  const root = ctx.file.sfc?.getTemplateAst();
  if (!root) return names;
  walkTemplate(root, (node) => {
    if (node.type !== 1) return;
    for (const prop of node.props) {
      if (prop.type !== 7 || prop.name !== "model" || !prop.exp) continue;
      let expression = ctx.helpers.parseTemplateExpression(prop.exp) as {
        type: string;
        name?: string;
        object?: unknown;
        computed?: boolean;
        property?: { name?: string; value?: unknown };
      } | null;
      const path: string[] = [];
      while (expression?.type === "MemberExpression") {
        path.unshift(
          expression.computed
            ? typeof expression.property?.value === "string"
              ? expression.property.value
              : "*"
            : (expression.property?.name ?? "*"),
        );
        expression = expression.object as typeof expression;
      }
      if (expression?.type === "Identifier" && expression.name)
        names.add([expression.name, ...path].join("."));
    }
  });
  return names;
}
