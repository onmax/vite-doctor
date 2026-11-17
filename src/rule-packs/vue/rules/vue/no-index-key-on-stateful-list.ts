import type {
  Confidence,
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateParentNode,
} from "../../../../core/index.js";
import {
  findTemplateDirective,
  templateExpressionReferences,
  walkTemplate,
  TemplateNodeType,
} from "../../../../core/rule-authoring.js";
import { parseScriptSync } from "../../../../core/internal/script.js";
import {
  componentState,
  isStatefulControl,
  nameSuggestsState,
  resolveComponentFile,
} from "./component-state.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-index-key-on-stateful-list";

const KEY_FIELDS = ["id", "uuid", "key"];
const DYNAMIC_COMPONENT_TAGS = new Set(["component", "Component"]);
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

interface Stateful {
  reason: StatefulReason;
  tag: string;
  /** What Doctor read about the state, for components. */
  evidence?: string;
  /** Lower than the Rule's own confidence when Doctor could not read what the component keeps. */
  confidence?: Confidence;
  /** The component source Doctor read the evidence from. */
  source?: string;
}

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
              ...(stateful.confidence ? { confidence: stateful.confidence } : {}),
              ...(stateful.source
                ? {
                    evidence: [
                      {
                        kind: "facts" as const,
                        file: stateful.source,
                        summary: stateful.evidence!,
                      },
                    ],
                  }
                : {}),
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

function statefulReason(
  ctx: RuleContext,
  element: TemplateElementNode,
  parent: TemplateParentNode | undefined,
): Stateful | null {
  if (parent?.type === TemplateNodeType.ELEMENT && TRANSITION_GROUP_TAGS.has(parent.tag))
    return { reason: "transition", tag: element.tag };
  if (element.tagType === 3) {
    for (const child of element.children) {
      if (child.type !== TemplateNodeType.ELEMENT) continue;
      const stateful = ownStatefulReason(ctx, child);
      if (stateful) return stateful;
    }
    return null;
  }
  return ownStatefulReason(ctx, element);
}

function ownStatefulReason(
  ctx: RuleContext,
  element: TemplateElementNode,
  inspectSlots = true,
): Stateful | null {
  const tag = element.tag;
  if (findTemplateDirective(element, "model")) return { reason: "model", tag };
  if (element.tagType === 0) return isStatefulControl(element) ? { reason: "control", tag } : null;
  if (element.tagType !== 1 || STATELESS_COMPONENTS.has(tag) || DYNAMIC_COMPONENT_TAGS.has(tag))
    return null;
  const file = resolveComponentFile(ctx, ctx.file.sfc?.getScriptAst("merged"), ctx.file.path, tag);
  if (!file) {
    if (!nameSuggestsState(tag)) return null;
    return {
      reason: "component",
      tag,
      confidence: "heuristic-low",
      evidence: `Doctor could not read <${tag}>'s source, so this rests on its name, which says it holds input or open state`,
    };
  }
  const state = componentState(ctx, file);
  let slotState: Stateful | null = null;
  if (inspectSlots) {
    // The walker already visits all descendants; each callback only classifies its own element.
    walkTemplate(element, (node) => {
      if (slotState || node === element || node.type !== TemplateNodeType.ELEMENT) return;
      slotState = ownStatefulReason(ctx, node, false);
    });
  }
  if (slotState) return slotState;
  if (state.kind === "stateless") return null;
  const name = file.split("/").pop()!;
  const evidence =
    state.kind === "stateful"
      ? `${name} keeps local state in ${state.evidence}`
      : `Doctor could not confirm that ${name} keeps local state: ${state.evidence}`;
  return {
    reason: "component",
    tag,
    ...(state.kind === "unknown" ? { confidence: "heuristic-low" as const } : {}),
    evidence,
    source: file,
  };
}

/** `item.id` when the item shows a unique field in the template, its literal or its type. */
function stableKeyExpression(
  ctx: RuleContext,
  vFor: TemplateDirectiveNode,
  element: TemplateElementNode,
): string | undefined {
  const value = vFor.forParseResult!.value;
  const alias = aliasIdentifier(value);
  // Destructuring and literal template text do not establish a key property.
  if (!alias) return undefined;
  const reads = new Set<string>();
  walkTemplate(element, (node) => {
    const value =
      node.type === TemplateNodeType.DIRECTIVE
        ? node.exp
        : node.type === TemplateNodeType.INTERPOLATION
          ? node.content
          : undefined;
    if (!value || value.isStatic) return;
    const expression = ctx.helpers.parseTemplateExpression(value);
    if (!expression) return;
    const visit = (part: AnyNode) => {
      if (!part || typeof part !== "object") return;
      if (
        part.type === "MemberExpression" &&
        !part.computed &&
        part.object?.type === "Identifier" &&
        part.object.name === alias
      )
        reads.add(part.property?.name);
      for (const [key, value] of Object.entries(part)) {
        if (key === "parent" || key.startsWith("_")) continue;
        for (const child of Array.isArray(value) ? value : [value])
          if (child && typeof child === "object") visit(child);
      }
    };
    visit(expression);
  });
  const read = KEY_FIELDS.find((field) => reads.has(field));
  if (read) return `${alias}.${read}`;
  const fields = itemFields(
    ctx.file.sfc?.getScriptAst("merged"),
    vFor.forParseResult!.source.content,
  );
  const field = KEY_FIELDS.find((name) => fields.has(name));
  return field ? `${alias}.${field}` : undefined;
}

/** Fields the items of a `v-for` source have, read from its script literal or declared type. */
function itemFields(program: AnyNode, source: string): Set<string> {
  const fields = new Set<string>();
  const match = /^(?:(props|\$props)\.)?([A-Za-z_$][\w$]*)$/.exec(source.trim());
  if (!program || !match) return fields;
  const [, viaProps, name] = match;
  const types = new Map<string, AnyNode>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      declaration?.id?.name &&
      (declaration.type === "TSInterfaceDeclaration" ||
        declaration.type === "TSTypeAliasDeclaration")
    )
      types.set(declaration.id.name, declaration);
  }
  const membersOf = (type: AnyNode, seen = new Set<AnyNode>()): AnyNode[] => {
    if (!type || seen.has(type)) return [];
    seen.add(type);
    if (type.type === "TSTypeLiteral") return type.members ?? [];
    if (type.type === "TSInterfaceDeclaration") return type.body?.body ?? [];
    if (type.type === "TSTypeAliasDeclaration") return membersOf(type.typeAnnotation, seen);
    if (type.type === "TSTypeReference") return membersOf(types.get(type.typeName?.name), seen);
    if (type.type === "TSIntersectionType")
      return (type.types ?? []).flatMap((part: AnyNode) => membersOf(part, seen));
    return [];
  };
  const elementType = (type: AnyNode): AnyNode => {
    if (type?.type === "TSArrayType") return type.elementType;
    const generic = typeArguments(type)?.[0];
    if (
      type?.type === "TSTypeReference" &&
      ["Array", "ReadonlyArray"].includes(type.typeName?.name)
    )
      return generic;
    if (type?.type === "TSTypeOperator") return elementType(type.typeAnnotation);
    return undefined;
  };
  const addMembers = (type: AnyNode) => {
    for (const member of membersOf(type)) {
      const key = member.key?.name ?? member.key?.value;
      if (typeof key === "string") fields.add(key);
    }
  };
  const addLiteral = (array: AnyNode) => {
    const objects = (array?.elements ?? []).filter(
      (item: AnyNode) => item?.type === "ObjectExpression",
    );
    if (!objects.length || objects.length !== array.elements.length) return;
    const [first, ...rest] = objects.map(
      (object: AnyNode) =>
        new Set<string>(
          (object.properties ?? []).map(
            (property: AnyNode) => property.key?.name ?? property.key?.value,
          ),
        ),
    );
    for (const key of first) if (rest.every((keys: Set<string>) => keys.has(key))) fields.add(key);
  };
  walk(program, (node) => {
    if (node.type === "VariableDeclarator" && !viaProps && node.id?.name === name) {
      let init = unwrapTs(node.init);
      if (init?.type === "CallExpression") {
        addMembers(elementType(typeArguments(init)?.[0]));
        init = unwrapTs(init.arguments?.[0]);
      }
      if (init?.type === "ArrayExpression") addLiteral(init);
    }
    if (node.type === "CallExpression" && node.callee?.name === "defineProps") {
      for (const member of membersOf(typeArguments(node)?.[0])) {
        if ((member.key?.name ?? member.key?.value) === name)
          addMembers(elementType(member.typeAnnotation?.typeAnnotation));
      }
    }
  });
  return fields;
}

function typeArguments(node: AnyNode): AnyNode[] | undefined {
  return (node?.typeArguments ?? node?.typeParameters)?.params;
}

function unwrapTs(node: AnyNode): AnyNode {
  while (node && TS_VALUE_WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key.startsWith("_")) continue;
    if (value && typeof value === "object") walk(value, visit);
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

function aliasIdentifier(alias: TemplateDirectiveNode["exp"]): string | null {
  const content = alias?.content.trim();
  return content && /^[A-Za-z_$][\w$]*$/.test(content) ? content : null;
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
