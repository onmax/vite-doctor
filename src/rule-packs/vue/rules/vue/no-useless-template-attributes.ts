import type {
  TemplateAttributeNode,
  TemplateDirectiveNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import { TemplateNodeType } from "../../../../core/rule-authoring.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-useless-template-attributes";

const STRUCTURAL_DIRECTIVES = new Set(["if", "else-if", "else", "for", "slot"]);
// Vue still reads these on a structural <template>: `v-memo` and `v-once` cache its children,
// and `v-cloak` has no effect on any element compiled from an SFC.
const KEPT_DIRECTIVES = new Set(["memo", "once", "cloak"]);
// Vue 2 slot syntax. Doctor targets Vue 3 and leaves migration leftovers to the upgrade.
const VUE2_SLOT_ATTRIBUTES = new Set(["slot", "slot-scope", "scope"]);

type Prop = TemplateAttributeNode | TemplateDirectiveNode;

export const noUselessTemplateAttributes = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not put attributes on a structural <template>",
    description:
      "Reports attributes and directives on a <template> with v-if, v-else-if, v-else, v-for or v-slot. Vue renders only that <template>'s children and drops everything else on it without a warning.",
    why: "A <template> that carries v-if, v-else-if, v-else, v-for or v-slot is not rendered as an element. Vue drops any other attribute or directive on it, so an id, class, listener, ref or directive there never reaches the page, and CSS, anchors, tests or code that rely on it find nothing.",
    recommendedReplacement:
      "Move the attribute onto the element inside the <template> it was meant for, or wrap the children in an element that carries it. Keep `key` on <template v-for>.",
    examples: [
      {
        title: "Put the id on a rendered element",
        language: "vue",
        invalid:
          '<template>\n  <template v-if="open" id="panel">\n    <section>{{ details }}</section>\n  </template>\n</template>',
        valid:
          '<template>\n  <template v-if="open">\n    <section id="panel">{{ details }}</section>\n  </template>\n</template>',
      },
    ],
    category: "template",
    severity: "warn",
    confidence: "proven",
    fixable: false,
    docsUrl: "https://vuejs.org/guide/essentials/conditional.html#v-if-on-template",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      template: {
        element(node) {
          if (node.tag !== "template" || node.tagType !== 3) return;
          const structural = node.props.find(isStructuralDirective);
          if (!structural) return;
          const owner = `<template ${propName(structural)}>`;
          const target = onlyChildElement(node);

          for (const prop of node.props) {
            if (!isDropped(prop)) continue;
            const name = propName(prop);
            ctx.report(
              diagnostics.VUE0044({
                why: `\`${name}\` on ${owner} is dropped. A <template> with ${propName(structural)} renders only its children, so Vue never applies \`${name}\` and gives no warning: ${effectOf(prop, name)}`,
                fix: fixFor(prop, name, structural, target),
              }),
              {
                ruleId: RULE_ID,
                severity: "warn",
                category: "template",
                file: ctx.file.path,
                range: ctx.range(prop.loc.start.offset, prop.loc.end.offset),
              },
            );
          }
        },
      },
    };
  },
});

function isStructuralDirective(prop: Prop): prop is TemplateDirectiveNode {
  return prop.type === TemplateNodeType.DIRECTIVE && STRUCTURAL_DIRECTIVES.has(prop.name);
}

function isDropped(prop: Prop): boolean {
  if (prop.type === TemplateNodeType.ATTRIBUTE)
    return prop.name !== "key" && !VUE2_SLOT_ATTRIBUTES.has(prop.name);
  if (STRUCTURAL_DIRECTIVES.has(prop.name) || KEPT_DIRECTIVES.has(prop.name)) return false;
  if (prop.name === "bind" && prop.arg?.isStatic)
    return prop.arg.content !== "key" && prop.arg.content !== "slot";
  return true;
}

function propName(prop: Prop): string {
  if (prop.type === TemplateNodeType.ATTRIBUTE) return prop.name;
  return prop.rawName ?? prop.loc.source.split("=")[0]!.trim();
}

function effectOf(prop: Prop, name: string): string {
  const isRef =
    prop.type === TemplateNodeType.ATTRIBUTE
      ? prop.name === "ref"
      : prop.name === "bind" && prop.arg?.isStatic && prop.arg.content === "ref";
  if (isRef) return "the template ref is never set and stays null.";
  if (prop.type === TemplateNodeType.ATTRIBUTE)
    return `no rendered element gets \`${name}\`, so CSS, anchors, tests and lookups such as document.getElementById that expect it find nothing.`;
  switch (prop.name) {
    case "bind":
      return prop.arg
        ? `no rendered element gets the bound \`${name}\`, so CSS, tests and code that expect it find nothing.`
        : "none of the bound attributes reach a rendered element.";
    case "on":
      return "the listener is never attached, so its handler never runs.";
    case "show":
      return "v-show never hides or shows anything here.";
    case "html":
    case "text":
      return `\`${name}\` never replaces the content; the <template>'s own children render instead.`;
    case "model":
      return "v-model binds nothing, so no input updates the value.";
    default:
      return `the \`${name}\` directive's hooks never run.`;
  }
}

function fixFor(
  prop: Prop,
  name: string,
  structural: TemplateDirectiveNode,
  target: TemplateElementNode | undefined,
): string {
  if (
    prop.type === TemplateNodeType.DIRECTIVE &&
    prop.name === "show" &&
    (structural.name === "if" || structural.name === "else-if")
  )
    return target
      ? `Move \`${name}\` onto <${target.tag}> inside this <template>, or fold its condition into ${propName(structural)}.`
      : `Fold the \`${name}\` condition into ${propName(structural)}, or put \`${name}\` on each element inside this <template>.`;
  if (target)
    return `Move \`${name}\` onto <${target.tag}>, the only element inside this <template>.`;
  return `Wrap the children of this <template> in an element, such as a <div>, and put \`${name}\` on it, or move \`${name}\` onto the child element it was meant for.`;
}

/** The single element a moved attribute would land on, when the <template> renders nothing else. */
function onlyChildElement(template: TemplateElementNode): TemplateElementNode | undefined {
  let found: TemplateElementNode | undefined;
  for (const child of template.children) {
    if (child.type === TemplateNodeType.COMMENT) continue;
    if (child.type === TemplateNodeType.TEXT && !child.content.trim()) continue;
    if (child.type !== TemplateNodeType.ELEMENT || found) return undefined;
    found = child;
  }
  // A <slot> takes attributes as slot props and a nested <template> may drop them again.
  if (!found || found.tagType === 2 || found.tag === "template") return undefined;
  return found;
}
