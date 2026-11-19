import type {
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateParentNode,
} from "../../../../core/index.js";
import {
  findTemplateAttribute,
  findTemplateDirective,
  TemplateNodeType,
} from "../../../../core/rule-authoring.js";
import {
  ownStatefulReason,
  statefulReportOptions,
  verifiedKeyExpression,
  type Stateful,
} from "./list-item-state.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/require-v-for-key";
const TRANSITION_GROUP_TAGS = new Set(["TransitionGroup", "transition-group"]);

export const requireVForKey = createRule({
  meta: {
    id: RULE_ID,
    title: "Key v-for items that hold state",
    description:
      "Reports v-for elements without a key when an item holds state: a component whose source keeps local state, an element with v-model, a native form control, or a child of <TransitionGroup>. Unkeyed lists of stateless elements are not reported.",
    why: "Without a key, Vue patches a v-for list in place. When items are inserted, removed or reordered, each component instance and form control stays at its position, so local state, typed input and focus end up on a different item, and <TransitionGroup> does not animate unkeyed children at all.",
    recommendedReplacement:
      "Bind :key to a stable, unique field of the item, such as its id. Lists of plain elements without state can stay unkeyed.",
    examples: [
      {
        title: "Key a component list by item id",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nimport TodoRow from "./TodoRow.vue"; // keeps a draft in ref()\n</script>\n<template>\n  <TodoRow v-for="todo in todos" :todo="todo" />\n</template>',
        valid:
          '<script setup lang="ts">\nimport TodoRow from "./TodoRow.vue"; // keeps a draft in ref()\n</script>\n<template>\n  <TodoRow v-for="todo in todos" :key="todo.id" :todo="todo" />\n</template>',
      },
    ],
    category: "template",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/list.html#maintaining-state-with-key",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    const parents = new WeakMap<TemplateElementNode, TemplateParentNode>();

    return {
      template: {
        element(node, parent) {
          if (parent) parents.set(node, parent);
          const vFor = findTemplateDirective(node, "for");
          if (!vFor?.forParseResult || iterationMayHaveKey(node)) return;

          const source = ctx.helpers.parseTemplateExpression(vFor.forParseResult.source);
          if (emptySource(source)) return;
          const transition = inTransitionGroup(node, parents) && unkeyedTransitionChild(ctx, node);
          if (!transition && fixedSource(source)) return;
          const own = transition
            ? ({ reason: "transition", tag: node.tag } as const)
            : ownStatefulReason(ctx, node, false);
          const stateful = own ?? descendantState(ctx, node);
          if (!stateful) return;

          const keyExpression = hasLocalTemplateScope(node, parents)
            ? undefined
            : verifiedKeyExpression(ctx, vFor, source);
          const insertAt = vFor.loc.end.offset;
          ctx.report(
            diagnostics.VUE0045({
              why: whyFor(stateful, node, vFor, !own),
              fix: keyExpression
                ? `Add :key="${keyExpression}" to <${node.tag} v-for>, or bind another stable, unique field of the item. Do not key it by the v-for index, which keeps the same problem.`
                : `Bind :key on <${node.tag} v-for> to a stable, unique field of the item, such as its id. Do not key it by the v-for index, which keeps the same problem.`,
            }),
            {
              ruleId: RULE_ID,
              severity: "warn",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(vFor),
              ...statefulReportOptions(stateful),
              ...(stateful.reason === "transition" ? { confidence: "proven" as const } : {}),
              ...(keyExpression
                ? {
                    fix: {
                      kind: "suggestion" as const,
                      edits: [
                        {
                          range: { start: insertAt, end: insertAt },
                          text: ` :key="${keyExpression}"`,
                        },
                      ],
                    },
                  }
                : {}),
            },
          );
        },
      },
    };
  },
});

function hasExplicitKey(node: TemplateElementNode): boolean {
  return !!(findTemplateAttribute(node, "key") || findTemplateDirective(node, "bind", "key"));
}

function mayBindKey(node: TemplateElementNode): boolean {
  return node.props.some(
    (prop) =>
      prop.type === TemplateNodeType.DIRECTIVE &&
      prop.name === "bind" &&
      (!prop.arg || !prop.arg.isStatic),
  );
}

function hasConditional(node: TemplateElementNode): boolean {
  return !!(
    findTemplateDirective(node, "if") ||
    findTemplateDirective(node, "else-if") ||
    findTemplateDirective(node, "else")
  );
}

function iterationMayHaveKey(node: TemplateElementNode): boolean {
  if (hasExplicitKey(node)) return true;
  if (node.tagType !== 3) return mayBindKey(node);
  return node.children.some(
    (child) =>
      child.type === TemplateNodeType.ELEMENT &&
      !findTemplateDirective(child, "for") &&
      !hasConditional(child) &&
      (hasExplicitKey(child) ||
        (node.children.length === 1 && child.tagType !== 3 && mayBindKey(child))),
  );
}

function inTransitionGroup(
  node: TemplateElementNode,
  parents: WeakMap<TemplateElementNode, TemplateParentNode>,
): boolean {
  if (hasConditional(node) || (node.tagType === 3 && findTemplateDirective(node, "slot")))
    return false;
  let parent = parents.get(node);
  if (parent?.type === TemplateNodeType.ELEMENT && parent.tagType === 3) {
    const slot = findTemplateDirective(parent, "slot");
    if (!slot || !isDefaultSlot(slot)) return false;
    parent = parents.get(parent);
  }
  if (parent?.type !== TemplateNodeType.ELEMENT || !TRANSITION_GROUP_TAGS.has(parent.tag))
    return false;
  const slot = findTemplateDirective(parent, "slot");
  return !slot || isDefaultSlot(slot);
}

function isDefaultSlot(slot: TemplateDirectiveNode): boolean {
  return !slot.arg || (slot.arg.isStatic && slot.arg.content === "default");
}

/**
 * TransitionGroup flattens fragments, propagating their keys. Slot outlets can supply unknown
 * keys, and text and comments do not trigger the warning.
 */
function unkeyedTransitionChild(ctx: RuleContext, node: TemplateElementNode): boolean {
  if (node.tagType === 2) return false;
  if (node.tagType !== 3) return true;
  return node.children.some(
    (child) =>
      child.type === TemplateNodeType.ELEMENT &&
      !hasConditional(child) &&
      !iterationMayHaveKey(child) &&
      !hasEmptyLoop(ctx, child) &&
      unkeyedTransitionChild(ctx, child),
  );
}

function hasLocalTemplateScope(
  node: TemplateElementNode,
  parents: WeakMap<TemplateElementNode, TemplateParentNode>,
): boolean {
  for (
    let parent = parents.get(node);
    parent?.type === TemplateNodeType.ELEMENT;
    parent = parents.get(parent)
  ) {
    if (findTemplateDirective(parent, "for") || findTemplateDirective(parent, "slot")) return true;
  }
  return false;
}

function fixedSource(node: AnyNode): boolean {
  return (
    (node?.type === "Literal" &&
      (typeof node.value === "string" ||
        (typeof node.value === "number" && Number.isInteger(node.value) && node.value >= 0))) ||
    (node?.type === "TemplateLiteral" && !node.expressions.length) ||
    (node?.type === "ArrayExpression" && node.elements.every(fixedValue))
  );
}

function fixedValue(node: AnyNode): boolean {
  if (!node || node.type === "Literal" || fixedSource(node)) return true;
  return (
    node.type === "ObjectExpression" &&
    node.properties.every(
      (property: AnyNode) =>
        property.type === "Property" &&
        !property.computed &&
        property.kind === "init" &&
        fixedValue(property.value),
    )
  );
}

function emptySource(node: AnyNode): boolean {
  return (
    (node?.type === "Literal" && (node.value === "" || node.value === 0)) ||
    (node?.type === "ArrayExpression" && node.elements.length === 0) ||
    (node?.type === "TemplateLiteral" &&
      !node.expressions.length &&
      node.quasis[0]?.value.cooked === "")
  );
}

function hasEmptyLoop(ctx: RuleContext, element: TemplateElementNode): boolean {
  const source = findTemplateDirective(element, "for")?.forParseResult?.source;
  return !!source && emptySource(ctx.helpers.parseTemplateExpression(source));
}

function descendantState(ctx: RuleContext, element: TemplateElementNode): Stateful | null {
  for (const child of element.children) {
    if (child.type !== TemplateNodeType.ELEMENT || hasEmptyLoop(ctx, child)) continue;
    const stateful = ownStatefulReason(ctx, child, false) ?? descendantState(ctx, child);
    if (stateful) return stateful;
  }
  return null;
}

function whyFor(
  stateful: Stateful,
  element: TemplateElementNode,
  vFor: TemplateDirectiveNode,
  inside: boolean,
): string {
  const item = `<${element.tag} ${vFor.loc.source}>`;
  if (stateful.reason === "transition")
    return `${item} inside <TransitionGroup> has no key. <TransitionGroup> sets transition hooks only on keyed children and warns "<TransitionGroup> children must be keyed." in development, so these items enter, leave and move without animating.`;
  const summary = `${item} has no key${inside ? ` and renders <${stateful.tag}>` : ""}.`;
  const reuse =
    "Without a key Vue patches the list in place: when items are inserted, removed or reordered,";
  if (inside) {
    const evidence = stateful.evidence ? ` ${stateful.evidence}.` : "";
    return `${summary}${evidence} ${reuse} state in <${stateful.tag}> can stay with the old position or be lost when Vue replaces the subtree. Descendant keys do not key the outer item.`;
  }
  const prefix = `${summary} ${reuse}`;
  switch (stateful.reason) {
    case "component":
      return `${item} has no key${inside ? ` and renders <${stateful.tag}>` : ""}. ${stateful.evidence}. Without a key Vue patches the list in place: when items are inserted, removed or reordered, each <${stateful.tag}> instance stays at its position and only gets new props, so that local state ends up on a different item.`;
    case "model":
      return `${prefix} each <${stateful.tag}> stays at its position and only its v-model value is rewritten, so focus, cursor position and in-progress input stay at the old position and now edit a different item.`;
    case "control":
      return `${prefix} each <${stateful.tag}> stays at its position, so typed values that are not bound, focus and selection show up on a different item.`;
  }
}
