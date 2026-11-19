import type { TemplateDirectiveNode, TemplateElementNode } from "../../../../core/index.js";
import {
  findTemplateAttribute,
  findTemplateDirective,
  startTagEnd,
  TemplateNodeType,
} from "../../../../core/rule-authoring.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/require-toggle-inside-transition";

const TRANSITION_TAGS = new Set(["Transition", "transition"]);
const TOGGLE_DIRECTIVES = new Set(["if", "else-if", "else", "show"]);
const BUILT_IN_DIRECTIVES = new Set([
  "bind",
  "on",
  "model",
  "text",
  "html",
  "once",
  "memo",
  "cloak",
  "for",
  "slot",
  "pre",
]);

export const requireToggleInsideTransition = createRule({
  meta: {
    id: RULE_ID,
    title: "Toggle the child of <Transition>",
    description:
      "Reports a nested <Transition> whose native child never toggles or repeats with v-for instead of using <TransitionGroup>.",
    why: "<Transition> animates only when its child enters or leaves: a v-if/v-else branch switching, v-show changing, or a :key changing. A plain element that stays mounted never triggers enter or leave, so the enter/leave classes and CSS never apply. Without appear, the first render does not animate either.",
    recommendedReplacement:
      "Add v-if or v-show to the child, bind a :key that changes, add appear to animate on first render, or remove the <Transition>. For lists, use <TransitionGroup> with a stable, unique :key per item.",
    examples: [
      {
        title: "Toggle the transitioned element",
        language: "vue",
        invalid:
          '<template>\n  <main>\n    <Transition name="fade">\n      <div class="toast">{{ message }}</div>\n    </Transition>\n  </main>\n</template>',
        valid:
          '<template>\n  <main>\n    <Transition name="fade">\n      <div v-if="message" class="toast">{{ message }}</div>\n    </Transition>\n  </main>\n</template>',
      },
    ],
    category: "template",
    severity: "warn",
    confidence: "proven",
    fixable: false,
    docsUrl: "https://vuejs.org/guide/built-ins/transition.html",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    const rootTemplateWrappers = new WeakSet<TemplateElementNode>();
    return {
      template: {
        element(node, parent) {
          const mayInheritAttrs =
            parent?.type === TemplateNodeType.ROOT ||
            (parent?.type === TemplateNodeType.ELEMENT && rootTemplateWrappers.has(parent));
          if (mayInheritAttrs) {
            if (node.tagType === 3) rootTemplateWrappers.add(node);
            return;
          }
          if (node.tagType !== 1 || !TRANSITION_TAGS.has(node.tag)) return;
          if (findTemplateAttribute(node, "is")?.value?.content.startsWith("vue:")) return;
          if (mayAnimateThroughTransitionProps(node)) return;
          const child = transitionedChild(node);
          if (!child || !isStaticNativeChild(child)) return;

          const name = node.tag;
          const loop = findTemplateDirective(child, "for");
          ctx.report(
            diagnostics.VUE0046({
              why: loop
                ? `<${child.tag}> inside <${name}> repeats with v-for. When the list has more than one item, Vue warns that <${name}> can only be used on a single element and renders only the first item.`
                : `<${child.tag}> inside <${name}> has no v-if, v-show or bound :key, so it never enters or leaves and the transition never runs. Its enter and leave classes and CSS never apply, and without appear the first render does not animate either.`,
              fix: loop
                ? `Replace <${name}> with <TransitionGroup> and bind a stable, unique :key for each v-for item, or move the v-for outside <${name}> and toggle each item with v-if.`
                : `Add v-if or v-show to <${child.tag}> so it enters and leaves, bind a :key that changes when the content should animate, add appear to <${name}> if the goal is an enter animation on mount, or remove the <${name}>.`,
            }),
            {
              ruleId: RULE_ID,
              severity: "warn",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(child.loc.start.offset, startTagEnd(child, ctx.file.text)),
            },
          );
        },
      },
    };
  },
});

function mayAnimateThroughTransitionProps(transition: TemplateElementNode): boolean {
  if (findTemplateAttribute(transition, "appear")) return true;
  for (const prop of transition.props) {
    if (prop.type !== TemplateNodeType.DIRECTIVE) continue;
    if (prop.name === "show" || isCustomDirective(prop)) return true;
    if (prop.name !== "bind") continue;
    if (!prop.arg || !prop.arg.isStatic) return true;
    if (prop.arg.content === "appear" && prop.exp?.content.trim() !== "false") return true;
  }
  return false;
}

/**
 * The element Transition renders, as upstream reads it: the first element child. An explicit
 * default slot `<template #default>` is unwrapped because Transition renders that slot.
 */
function transitionedChild(transition: TemplateElementNode): TemplateElementNode | undefined {
  const first = firstElement(transition);
  if (!first || first.tag !== "template") return first;
  const slot = findTemplateDirective(first, "slot");
  if (!slot) return first;
  if (slot.arg && !(slot.arg.isStatic && slot.arg.content === "default")) return undefined;
  if (
    first.props.some(
      (prop) =>
        prop.type === TemplateNodeType.DIRECTIVE &&
        (TOGGLE_DIRECTIVES.has(prop.name) || prop.name === "for"),
    )
  ) {
    return undefined;
  }
  return firstElement(first);
}

function firstElement(parent: TemplateElementNode): TemplateElementNode | undefined {
  for (const child of parent.children)
    if (child.type === TemplateNodeType.ELEMENT) return child as TemplateElementNode;
  return undefined;
}

/**
 * Only native elements Doctor can read in full. Slots, components (their root may toggle),
 * `is` on an element, object spreads that may carry a key, and custom directives, which can
 * drive Transition hooks the way v-show does, all count as unknown.
 */
function isStaticNativeChild(child: TemplateElementNode): boolean {
  if (child.tagType !== 0 && child.tagType !== 3) return false;
  if (findTemplateAttribute(child, "is")) return false;
  for (const prop of child.props) {
    if (prop.type !== TemplateNodeType.DIRECTIVE) continue;
    if (TOGGLE_DIRECTIVES.has(prop.name)) return false;
    if (isCustomDirective(prop)) return false;
    if (prop.name === "bind" && bindsKeyOrUnknown(prop)) return false;
  }
  return true;
}

function isCustomDirective(directive: TemplateDirectiveNode): boolean {
  return !BUILT_IN_DIRECTIVES.has(directive.name) && !TOGGLE_DIRECTIVES.has(directive.name);
}

function bindsKeyOrUnknown(bind: TemplateDirectiveNode): boolean {
  if (!bind.arg || !bind.arg.isStatic) return true;
  return bind.arg.content === "key" || bind.arg.content === "is";
}
