import type {
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateParentNode,
} from "../../../../core/index.js";
import {
  findTemplateAttribute,
  findTemplateDirective,
  templateExpressionReferences,
  TemplateNodeType,
} from "../../../../core/rule-authoring.js";
import { parseScriptSync } from "../../../../core/internal/script.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-index-key-on-stateful-list";

const FORM_CONTROLS = new Set(["input", "textarea", "select"]);
const STATELESS_INPUT_TYPES = new Set(["hidden", "button", "submit", "reset", "image"]);
const TRANSITION_GROUP_TAGS = new Set(["TransitionGroup", "transition-group"]);
const STATELESS_COMPONENTS = new Set(["RouterLink", "router-link", "NuxtLink", "nuxt-link"]);
// For plain objects Vue passes the property key as the second alias, so only index-like names count.
const INDEX_LIKE_ALIAS =
  /^(?:i|j|ix|idx|index|pos|position|offset|[a-z]\w*(?:Index|Idx)|\w+_(?:index|idx))$/;
const TS_VALUE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);

type StatefulReason = "component" | "model" | "control" | "transition";

export const noIndexKeyOnStatefulList = createRule({
  meta: {
    id: RULE_ID,
    title: "Key stateful v-for items by a stable id",
    description:
      "Reports v-for keys bound to the iteration index when the keyed element holds state: a component, an element with v-model, a native form control, or a child of <TransitionGroup>.",
    why: "Vue reuses DOM nodes and component instances by key. With an index key, inserting, removing or reordering items keeps each instance at its position, so component state, input values and transitions attach to a different item.",
    recommendedReplacement:
      'Key each item by a stable, unique value from the item itself, such as :key="item.id".',
    examples: [
      {
        title: "Key a component list by item id",
        language: "vue",
        invalid:
          '<template>\n  <TodoRow v-for="(todo, index) in todos" :key="index" :todo="todo" />\n</template>',
        valid:
          '<template>\n  <TodoRow v-for="todo in todos" :key="todo.id" :todo="todo" />\n</template>',
      },
    ],
    category: "template",
    severity: "warn",
    fixable: false,
    docsUrl: "https://vuejs.org/guide/essentials/list.html#maintaining-state-with-key",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    let staticBindings: Set<string> | undefined;
    const isStaticBinding = (name: string) => {
      staticBindings ??= collectStaticArrayBindings(ctx.file.sfc?.getScriptAst("merged"));
      return staticBindings.has(name);
    };

    return {
      template: {
        element(node, parent) {
          const vFor = findTemplateDirective(node, "for");
          const key = findTemplateDirective(node, "bind", "key");
          if (!vFor?.forParseResult || !key?.exp) return;
          if (isUnchangingSource(vFor, isStaticBinding)) return;

          const indexAlias = indexAliasUsedByKey(vFor, key, (expression) =>
            ctx.helpers.parseTemplateExpression(expression),
          );
          if (!indexAlias) return;

          const stateful = statefulReason(node, parent);
          if (!stateful) return;

          ctx.report(
            diagnostics.VUE0035({
              why: whyFor(stateful.reason, stateful.tag, indexAlias),
              fix: `Bind :key to a stable, unique value from the item, such as :key="${valueAliasName(vFor) ?? "item"}.id", instead of the index "${indexAlias}".`,
            }),
            {
              ruleId: RULE_ID,
              severity: "warn",
              category: "template",
              file: ctx.file.path,
              range: ctx.range(key),
            },
          );
        },
      },
    };
  },
});

function whyFor(reason: StatefulReason, tag: string, indexAlias: string): string {
  const prefix = `:key uses the v-for index "${indexAlias}" on <${tag}>.`;
  switch (reason) {
    case "component":
      return `${prefix} When items are inserted, removed or reordered, Vue keeps each component instance at its position and only patches props, so local state such as refs, open panels or in-progress edits ends up on a different item.`;
    case "model":
      return `${prefix} When items are inserted, removed or reordered, Vue keeps each element at its position and rewrites the v-model value, so focus, cursor position and in-progress input stay on the old position and now edit a different item.`;
    case "control":
      return `${prefix} When items are inserted, removed or reordered, Vue keeps each form control at its position, so typed values that are not bound, focus and selection stay at the old position and show up on a different item.`;
    case "transition":
      return `${prefix} <TransitionGroup> tracks children by key, so removing or reordering items animates the element at the changed position, usually the last one, instead of the item that moved or left.`;
  }
}

function statefulReason(
  element: TemplateElementNode,
  parent: TemplateParentNode | undefined,
): { reason: StatefulReason; tag: string } | null {
  if (parent?.type === TemplateNodeType.ELEMENT && TRANSITION_GROUP_TAGS.has(parent.tag))
    return { reason: "transition", tag: element.tag };
  if (element.tagType === 3) {
    for (const child of element.children) {
      if (child.type !== TemplateNodeType.ELEMENT) continue;
      const reason = ownStatefulReason(child);
      if (reason) return { reason, tag: child.tag };
    }
    return null;
  }
  const reason = ownStatefulReason(element);
  return reason ? { reason, tag: element.tag } : null;
}

function ownStatefulReason(element: TemplateElementNode): StatefulReason | null {
  if (element.tagType === 1 && !STATELESS_COMPONENTS.has(element.tag)) return "component";
  if (findTemplateDirective(element, "model")) return "model";
  if (element.tagType === 1) return null;
  if (element.tagType !== 0 || !FORM_CONTROLS.has(element.tag)) return null;
  if (element.tag === "input") {
    const type = findTemplateAttribute(element, "type")?.value?.content.trim().toLowerCase();
    if (type && STATELESS_INPUT_TYPES.has(type)) return null;
  }
  return "control";
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

function aliasIdentifier(alias: TemplateDirectiveNode["exp"]): string | null {
  const content = alias?.content.trim();
  return content && /^[A-Za-z_$][\w$]*$/.test(content) ? content : null;
}

function valueAliasName(vFor: TemplateDirectiveNode): string | null {
  return aliasIdentifier(vFor.forParseResult?.value);
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

function isUnchangingSource(
  vFor: TemplateDirectiveNode,
  isStaticBinding: (name: string) => boolean,
): boolean {
  const source = vFor.forParseResult!.source.content.trim();
  if (/^\d+$/.test(source)) return true;
  if (/^(['"`]).*\1$/s.test(source)) return true;
  if (source.startsWith("[")) return true;
  return /^[A-Za-z_$][\w$]*$/.test(source) && isStaticBinding(source);
}

/** Top-level `const` arrays written as literals: not reactive, so the rendered list never changes. */
function collectStaticArrayBindings(program: AnyNode): Set<string> {
  const names = new Set<string>();
  for (const statement of program?.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type !== "Identifier") continue;
      let init = declarator.init;
      while (init && TS_VALUE_WRAPPERS.has(init.type)) init = init.expression;
      if (init?.type === "ArrayExpression") names.add(declarator.id.name);
    }
  }
  return names;
}
