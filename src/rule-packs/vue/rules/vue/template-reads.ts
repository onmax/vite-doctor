import type { RuleContext, TemplateExpressionNode } from "../../../../core/index.js";
import { perFile } from "../../../../core/internal/script-scope.js";
import { parseTemplateHandler } from "../../../../core/internal/template.js";
import {
  templateDirectiveBindings,
  templateExpressionReferences,
  TemplateNodeType,
  walkTemplate,
} from "../../../../core/rule-authoring.js";
import type { AnyNode } from "./shared.js";
import { memberName, unwrapTs } from "./vue-api.js";

export type PropertyPath = ReadonlyArray<string | undefined>;

export interface TemplateWrite {
  path: PropertyPath;
  operation?: AnyNode;
}

export function matchesPrefix(prefix: PropertyPath, path: PropertyPath): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every(
      (key, index) => key === undefined || path[index] === undefined || key === path[index],
    )
  );
}

interface TemplateNames {
  /** Read while the template renders, outside `v-for` and slot locals. */
  reads: Set<string>;
  /** Paths assigned anywhere in the template; an empty path replaces the binding. */
  writes: Map<string, TemplateWrite[]>;
}

/**
 * Names the template reads while it renders: interpolations, bindings, and directive values,
 * minus `v-for` and slot locals. Event handlers run outside render, so they are not reads.
 */
export function renderTemplateReads(ctx: RuleContext): Set<string> {
  return templateNames(ctx).reads;
}

/** Names the template assigns, as in `@click="items = []"` or `v-model="items"`. */
export function templateWrites(ctx: RuleContext, name: string): readonly TemplateWrite[] {
  return templateNames(ctx).writes.get(name) ?? [];
}

function templateNames(ctx: RuleContext): TemplateNames {
  return perFile(ctx, "vue-template-names", () => collectTemplateNames(ctx));
}

function collectTemplateNames(ctx: RuleContext): TemplateNames {
  const reads = new Set<string>();
  const writes = new Map<string, TemplateWrite[]>();
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
    mode: "render" | "handler" | "model" = "render",
  ) {
    const ast =
      expression &&
      (mode === "handler"
        ? parseTemplateHandler(expression)
        : ctx.helpers.parseTemplateExpression(expression));
    if (!ast) return;
    for (const { id, mode: access } of templateExpressionReferences(ast)) {
      if (locals.has(id.name)) continue;
      if (mode !== "handler" && access !== "w") reads.add(id.name);
      const write =
        templateWrite(id, mode === "model" ? unwrapTs(ast) : undefined) ??
        (access !== "r" ? { path: [] } : undefined);
      if (!write) continue;
      let bindingWrites = writes.get(id.name);
      if (!bindingWrites) writes.set(id.name, (bindingWrites = []));
      bindingWrites.push(write);
    }
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
    else if (node.name === "on") collect(node.exp, loop, "handler");
    else if (node.name === "model") collect(node.exp, loop, "model");
    else if (node.name !== "slot") collect(node.exp, loop);
  });
  return { reads, writes };
}

function templateWrite(id: AnyNode, model: AnyNode): TemplateWrite | undefined {
  const path: (string | undefined)[] = [];
  let node = id;
  for (let parent = node.__doctorParent; parent; parent = node.__doctorParent) {
    if (unwrapTs(parent) === node) {
      node = parent;
      continue;
    }
    if (parent.type === "MemberExpression" && parent.object === node) {
      path.push(memberName(parent));
      node = parent;
      continue;
    }
    if (
      (parent.type === "AssignmentExpression" && parent.left === node) ||
      (parent.type === "UpdateExpression" && parent.argument === node) ||
      (parent.type === "UnaryExpression" &&
        parent.operator === "delete" &&
        parent.argument === node)
    )
      return { path, operation: parent };
    break;
  }
  if (unwrapTs(node) === model || isPatternWrite(node)) return { path };
  return undefined;
}

function isPatternWrite(node: AnyNode): boolean {
  let inPattern = false;
  for (let parent = node.__doctorParent; parent; parent = node.__doctorParent) {
    if (
      (parent.type === "Property" &&
        parent.value === node &&
        parent.__doctorParent?.type === "ObjectPattern") ||
      parent.type === "ObjectPattern" ||
      (parent.type === "ArrayPattern" && parent.elements.includes(node)) ||
      (parent.type === "AssignmentPattern" && parent.left === node) ||
      (parent.type === "RestElement" && parent.argument === node)
    ) {
      inPattern = true;
      node = parent;
      continue;
    }
    return (
      parent.left === node &&
      ((inPattern && parent.type === "AssignmentExpression") ||
        parent.type === "ForInStatement" ||
        parent.type === "ForOfStatement")
    );
  }
  return false;
}
