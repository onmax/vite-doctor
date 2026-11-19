import type { TemplateDirectiveNode } from "../../../../core/index.js";
import {
  findTemplateDirective,
  templateExpressionReferences,
} from "../../../../core/rule-authoring.js";
import { parseScriptSync } from "../../../../core/internal/script.js";
import {
  aliasIdentifier,
  stableKeyExpression,
  statefulReason,
  statefulReportOptions,
  unchangingSourceCheck,
  type Stateful,
} from "./list-item-state.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-index-key-on-stateful-list";

// For plain objects Vue passes the property key as the second alias, so only index-like names count.
const INDEX_LIKE_ALIAS =
  /^(?:i|j|ix|idx|index|pos|position|offset|[a-z]\w*(?:Index|Idx)|\w+_(?:index|idx))$/;

export const noIndexKeyOnStatefulList = createRule({
  meta: {
    id: RULE_ID,
    title: "Key stateful v-for items by a stable id",
    description:
      "Reports v-for keys bound to the iteration index when the keyed element holds state: a component whose source keeps local state, an element with v-model, a native form control, or a child of <TransitionGroup>.",
    why: "Vue reuses DOM nodes and component instances by key. With an index key, inserting, removing or reordering items keeps each instance at its position, so component state, input values and transitions attach to a different item.",
    recommendedReplacement:
      "Key each item by a stable, unique field of the item itself, such as its id.",
    examples: [
      {
        title: "Key a component list by item id",
        language: "vue",
        invalid:
          '<script setup lang="ts">\nimport TodoRow from "./TodoRow.vue"; // keeps a draft in ref()\n</script>\n<template>\n  <TodoRow v-for="(todo, index) in todos" :key="index" :todo="todo" />\n</template>',
        valid:
          '<script setup lang="ts">\nimport TodoRow from "./TodoRow.vue"; // keeps a draft in ref()\n</script>\n<template>\n  <TodoRow v-for="todo in todos" :key="todo.id" :todo="todo" />\n</template>',
      },
    ],
    category: "template",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: false,
    docsUrl: "https://vuejs.org/guide/essentials/list.html#maintaining-state-with-key",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    const isUnchangingSource = unchangingSourceCheck(ctx);

    return {
      template: {
        element(node, parent) {
          const vFor = findTemplateDirective(node, "for");
          const key = findTemplateDirective(node, "bind", "key");
          if (!vFor?.forParseResult || !key?.exp) return;
          if (isUnchangingSource(vFor)) return;

          const indexAlias = indexAliasUsedByKey(vFor, key, (expression) =>
            ctx.helpers.parseTemplateExpression(expression),
          );
          if (!indexAlias) return;

          const stateful = statefulReason(ctx, node, parent);
          if (!stateful) return;

          const keyExpression = stableKeyExpression(ctx, vFor, node);
          ctx.report(
            diagnostics.VUE0035({
              why: whyFor(stateful, indexAlias),
              fix: keyExpression
                ? `Bind :key to a stable, unique value from the item, such as :key="${keyExpression}", instead of the index "${indexAlias}".`
                : `Bind :key to a stable, unique field of the item instead of the index "${indexAlias}". Doctor found no id field on the item to name here.`,
            }),
            {
              ruleId: RULE_ID,
              severity: "warn",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(key),
              ...statefulReportOptions(stateful),
            },
          );
        },
      },
    };
  },
});

function whyFor(stateful: Stateful, indexAlias: string): string {
  const prefix = `:key uses the v-for index "${indexAlias}" on <${stateful.tag}>.`;
  switch (stateful.reason) {
    case "component":
      return `${prefix} ${stateful.evidence}. When items are inserted, removed or reordered, Vue keeps each component instance at its position and only patches props, so that local state ends up on a different item.`;
    case "model":
      return `${prefix} When items are inserted, removed or reordered, Vue keeps each element at its position and rewrites the v-model value, so focus, cursor position and in-progress input stay on the old position and now edit a different item.`;
    case "control":
      return `${prefix} When items are inserted, removed or reordered, Vue keeps each form control at its position, so typed values that are not bound, focus and selection stay at the old position and show up on a different item.`;
    case "transition":
      return `${prefix} <TransitionGroup> tracks children by key, so removing or reordering items animates the element at the changed position, usually the last one, instead of the item that moved or left.`;
  }
}

function indexAliasUsedByKey(
  vFor: TemplateDirectiveNode,
  key: TemplateDirectiveNode,
  parse: (expression: NonNullable<TemplateDirectiveNode["exp"]>) => AnyNode,
): string | null {
  const { value, key: second, index: third } = vFor.forParseResult!;
  const candidates = new Set<string>();
  const sourceContent = vFor.forParseResult!.source.content.trim();
  const source = parse(vFor.forParseResult!.source);
  const sourceKind = classifyForSource(source, sourceContent);
  const objectSource = /^(?:record|object|map|dict)$/i.test(sourceContent);
  const thirdName = aliasIdentifier(third);
  if ((sourceKind === "object" || objectSource) && thirdName) candidates.add(thirdName);
  const secondName = aliasIdentifier(second);
  if (
    sourceKind !== "object" &&
    !objectSource &&
    secondName &&
    (sourceKind === "array-like" || INDEX_LIKE_ALIAS.test(secondName))
  )
    candidates.add(secondName);
  if (candidates.size === 0) return null;

  const expression = parse(key.exp!);
  if (!expression) return null;
  const names = new Set(templateExpressionReferences(expression).map((ref) => ref.id.name));
  const valueNames = patternNames(value);
  // A key that also reads the item, such as `${item.type}-${i}`, is a different trade-off.
  for (const name of valueNames) if (names.has(name)) return null;
  for (const name of candidates) if (names.has(name)) return name;
  return null;
}

function classifyForSource(source: AnyNode, content: string): "object" | "array-like" | "unknown" {
  if (/^(?:record|object|map|dict)$/i.test(content.trim())) return "object";
  if (source?.type === "ObjectExpression") return "object";
  if (
    source?.type === "ArrayExpression" ||
    source?.type === "StringLiteral" ||
    source?.type === "NumericLiteral" ||
    source?.type === "Literal"
  ) {
    return source.type === "Literal" && typeof source.value === "object" ? "unknown" : "array-like";
  }
  // Template-only identifiers have no binding information here. Preserve the
  // established name heuristic while recognizing the common object iteration name.
  return "unknown";
}

function patternNames(alias: TemplateDirectiveNode["exp"]): string[] {
  const content = alias?.content.trim();
  if (!content) return [];
  const simple = aliasIdentifier(alias);
  if (simple) return [simple];
  try {
    const result = parseScriptSync("v-for-alias.ts", `(${content}) => 0`, {
      lang: "ts",
      sourceType: "module",
    });
    const arrow = (result.program.body[0] as AnyNode)?.expression;
    const names: string[] = [];
    for (const param of arrow?.params ?? []) collectNames(param, names);
    return names;
  } catch {
    return [];
  }
}

function collectNames(pattern: AnyNode, names: string[]) {
  if (!pattern) return;
  if (pattern.type === "Identifier") names.push(pattern.name);
  else if (pattern.type === "AssignmentPattern") collectNames(pattern.left, names);
  else if (pattern.type === "RestElement") collectNames(pattern.argument, names);
  else if (pattern.type === "ObjectPattern")
    for (const property of pattern.properties ?? [])
      collectNames(property.type === "RestElement" ? property : property.value, names);
  else if (pattern.type === "ArrayPattern")
    for (const element of pattern.elements ?? []) collectNames(element, names);
}
