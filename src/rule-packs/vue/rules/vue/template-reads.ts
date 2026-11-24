import type { RuleContext, TemplateExpressionNode } from "../../../../core/index.js";
import { perFile } from "../../../../core/internal/script-scope.js";
import {
  templateDirectiveBindings,
  templateExpressionReferences,
  TemplateNodeType,
  walkTemplate,
} from "../../../../core/rule-authoring.js";

interface TemplateNames {
  /** Read while the template renders, outside `v-for` and slot locals. */
  reads: Set<string>;
  /** Assigned anywhere in the template, event handlers and `v-model` included. */
  writes: Set<string>;
}

/**
 * Names the template reads while it renders: interpolations, bindings, and directive values,
 * minus `v-for` and slot locals. Event handlers run outside render, so they are not reads.
 */
export function renderTemplateReads(ctx: RuleContext): Set<string> {
  return templateNames(ctx).reads;
}

/** Names the template assigns, as in `@click="items = []"` or `v-model="items"`. */
export function templateWrites(ctx: RuleContext): Set<string> {
  return templateNames(ctx).writes;
}

function templateNames(ctx: RuleContext): TemplateNames {
  return perFile(ctx, "vue-template-names", () => collectTemplateNames(ctx));
}

function collectTemplateNames(ctx: RuleContext): TemplateNames {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const root = ctx.file.templateAst;
  if (!root) return { reads, writes };
  const empty = new Set<string>();
  const scopes = new WeakMap<
    object,
    { outer: Set<string>; loop: Set<string>; body: Set<string> }
  >();
  function collect(
    expression: TemplateExpressionNode | undefined,
    locals: Set<string>,
    render = true,
  ) {
    const ast = expression && ctx.helpers.parseTemplateExpression(expression);
    if (!ast) return undefined;
    for (const { id, mode } of templateExpressionReferences(ast)) {
      if (locals.has(id.name)) continue;
      if (mode !== "r") writes.add(id.name);
      if (render && mode !== "w") reads.add(id.name);
    }
    return ast;
  }
  walkTemplate(root, (node, parent) => {
    const scope = parent && scopes.get(parent);
    const inherited = scope?.body ?? empty;
    if (node.type === TemplateNodeType.ELEMENT) {
      let loop = inherited;
      let slotBindings: string[] = [];
      for (const prop of node.props) {
        if (prop.type !== TemplateNodeType.DIRECTIVE) continue;
        if (prop.name === "for") loop = new Set([...loop, ...templateDirectiveBindings(prop)]);
        if (prop.name === "slot") slotBindings = templateDirectiveBindings(prop);
      }
      const body = slotBindings.length ? new Set([...loop, ...slotBindings]) : loop;
      scopes.set(node, { outer: inherited, loop, body });
    }
    if (node.type === TemplateNodeType.INTERPOLATION) collect(node.content, inherited);
    if (node.type !== TemplateNodeType.DIRECTIVE) return;
    const outer = scope?.outer ?? empty;
    const loop = scope?.loop ?? empty;
    if (node.arg && !node.arg.isStatic) collect(node.arg, loop);
    if (node.name === "for") collect(node.forParseResult?.source, outer);
    else if (node.name === "if" || node.name === "else-if") collect(node.exp, outer);
    else if (node.name === "on") collect(node.exp, loop, false);
    else if (node.name === "model") {
      const ast = collect(node.exp, loop) as { type: string; name?: string } | undefined;
      if (ast?.type === "Identifier" && !loop.has(ast.name!)) writes.add(ast.name!);
    } else if (node.name !== "slot") collect(node.exp, loop);
  });
  return { reads, writes };
}
