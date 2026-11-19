import type { TemplateAttributeNode, TemplateDirectiveNode } from "../../../../core/index.js";
import { TemplateNodeType } from "../../../../core/rule-authoring.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-useless-template-attributes";

const STRUCTURAL_DIRECTIVES = new Set(["if", "else-if", "else", "for", "slot"]);
// Vue 2 slot syntax. Doctor targets Vue 3 and leaves migration leftovers to the upgrade.
const VUE2_SLOT_ATTRIBUTES = new Set(["slot-scope", "scope"]);

type Prop = TemplateAttributeNode | TemplateDirectiveNode;

export const noUselessTemplateAttributes = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not put attributes on a structural <template>",
    description:
      "Reports attributes and directives Vue does not apply on a <template> with v-if, v-else-if, v-else, v-for or v-slot.",
    why: "A structural <template> does not render an element. Attributes such as id, class, slot, listeners and refs never reach a rendered element, and key and caching directives only work on certain structural templates.",
    recommendedReplacement:
      "Apply the attribute or directive to an intended rendered target that supports it. Preserve branch selection when adding visibility, and keep working list keys on a non-slot <template v-for>.",
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
          const structural = node.props.filter(isStructuralDirective);
          const first = structural[0];
          if (!first) return;
          const directiveNames = new Set(structural.map((prop) => prop.name));
          const owner = `<template ${propName(first)}>`;

          for (const prop of node.props) {
            if (!isDropped(prop, directiveNames)) continue;
            const name = propName(prop);
            ctx.report(
              diagnostics.VUE0044({
                why: `\`${name}\` on ${owner} is dropped. A <template> with ${propName(first)} renders only its children, so Vue never applies \`${name}\`: ${effectOf(prop, name)}`,
                fix: fixFor(prop, name),
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

function isAttribute(prop: Prop, name: string): boolean {
  return prop.type === TemplateNodeType.ATTRIBUTE
    ? prop.name === name
    : prop.name === "bind" && prop.arg?.isStatic === true && prop.arg.content === name;
}

function isDropped(prop: Prop, structural: ReadonlySet<string>): boolean {
  const slot = structural.has("slot");
  if (isAttribute(prop, "key")) return slot || !structural.has("for");
  if (prop.type === TemplateNodeType.ATTRIBUTE) return !VUE2_SLOT_ATTRIBUTES.has(prop.name);
  if (STRUCTURAL_DIRECTIVES.has(prop.name) || prop.name === "cloak") return false;
  if (prop.name === "memo") return slot || !structural.has("for");
  if (prop.name === "once") return slot || structural.has("else-if") || structural.has("else");
  return true;
}

function propName(prop: Prop): string {
  if (prop.type === TemplateNodeType.ATTRIBUTE) return prop.name;
  return prop.rawName ?? prop.loc.source.split("=")[0]!.trim();
}

function effectOf(prop: Prop, name: string): string {
  if (isAttribute(prop, "key")) return "the authored key does not control runtime identity.";
  if (isAttribute(prop, "slot")) return "no rendered element is assigned to the named native slot.";
  if (isAttribute(prop, "ref")) return "the template ref is never set and stays null.";
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
    case "memo":
      return "Vue does not memoize the children using these dependencies.";
    case "once":
      return "Vue does not cache the children as a one-time render.";
    default:
      return `the \`${name}\` directive's hooks never run.`;
  }
}

function fixFor(prop: Prop, name: string): string {
  if (isAttribute(prop, "key"))
    return `Put \`${name}\` on the rendered element or component whose identity it should control.`;
  if (isAttribute(prop, "slot"))
    return `Put \`${name}\` on the rendered element that should be assigned to the native slot.`;
  if (prop.type === TemplateNodeType.DIRECTIVE) {
    switch (prop.name) {
      case "show":
        return `Apply \`${name}\` to the intended rendered element or elements that support it. Keep visibility separate from branch selection so hiding content does not unmount it or select a different branch.`;
      case "model":
        return `Bind \`${name}\` to an intended form control or component that supports it, using a writable expression in that scope.`;
      case "html":
      case "text":
        return `Apply \`${name}\` to a compatible rendered element whose content should be replaced, without template children of its own.`;
      case "memo":
      case "once":
        return `Apply \`${name}\` to a compatible rendered element or component whose rendering should be cached.`;
    }
  }
  return `Apply \`${name}\` to the intended rendered element or component that supports it.`;
}
