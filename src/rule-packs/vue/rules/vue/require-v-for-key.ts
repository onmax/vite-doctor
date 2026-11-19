import type {
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import {
  findTemplateAttribute,
  findTemplateDirective,
  TemplateNodeType,
} from "../../../../core/rule-authoring.js";
import {
  ownStatefulReason,
  stableKeyExpression,
  statefulReason,
  statefulReportOptions,
  unchangingSourceCheck,
  type Stateful,
} from "./list-item-state.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/require-v-for-key";

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
    const isUnchangingSource = unchangingSourceCheck(ctx);

    return {
      template: {
        element(node, parent) {
          const vFor = findTemplateDirective(node, "for");
          if (!vFor?.forParseResult || mayHaveKey(node)) return;
          if (node.tagType === 3 && node.children.some((child) => mayHaveKey(child))) return;
          if (isUnchangingSource(vFor)) return;

          const own = statefulReason(ctx, node, parent);
          const stateful = own ?? descendantState(ctx, node);
          if (!stateful) return;
          const inside = !own || node.tagType === 3;

          const keyExpression = stableKeyExpression(ctx, vFor, node);
          const insertAt = vFor.loc.end.offset;
          ctx.report(
            diagnostics.VUE0045({
              why: whyFor(stateful, node, vFor, inside),
              fix: keyExpression
                ? `Add :key="${keyExpression}" to <${node.tag} v-for>, or bind another stable, unique field of the item. Do not key it by the v-for index, which keeps the same problem.`
                : `Bind :key on <${node.tag} v-for> to a stable, unique field of the item, such as its id. Doctor found no id field on the item to name here. Do not key it by the v-for index, which keeps the same problem.`,
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

/** A `key`, `:key`, or a binding such as `v-bind="item"` that may carry one. */
function mayHaveKey(node: TemplateElementNode["children"][number]): boolean {
  if (node.type !== TemplateNodeType.ELEMENT) return false;
  if (findTemplateAttribute(node, "key")) return true;
  return node.props.some(
    (prop) =>
      prop.type === TemplateNodeType.DIRECTIVE &&
      prop.name === "bind" &&
      (!prop.arg || !prop.arg.isStatic || prop.arg.content === "key"),
  );
}

/**
 * State rendered inside an unkeyed item, such as a component in a `<li v-for>`. Vue patches those
 * descendants in place along with the item. A keyed descendant or a nested v-for has its own
 * identity, so the walk stops there.
 */
function descendantState(ctx: RuleContext, element: TemplateElementNode): Stateful | null {
  for (const child of element.children) {
    if (child.type !== TemplateNodeType.ELEMENT) continue;
    if (findTemplateDirective(child, "for") || mayHaveKey(child)) continue;
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
  const prefix = `${item} has no key${inside ? ` and renders <${stateful.tag}>` : ""}. Without a key Vue patches the list in place: when items are inserted, removed or reordered,`;
  switch (stateful.reason) {
    case "component":
      return `${item} has no key${inside ? ` and renders <${stateful.tag}>` : ""}. ${stateful.evidence}. Without a key Vue patches the list in place: when items are inserted, removed or reordered, each <${stateful.tag}> instance stays at its position and only gets new props, so that local state ends up on a different item.`;
    case "model":
      return `${prefix} each <${stateful.tag}> stays at its position and only its v-model value is rewritten, so focus, cursor position and in-progress input stay at the old position and now edit a different item.`;
    case "control":
      return `${prefix} each <${stateful.tag}> stays at its position, so typed values that are not bound, focus and selection show up on a different item.`;
  }
}
