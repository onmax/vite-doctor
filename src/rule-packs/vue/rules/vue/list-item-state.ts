import type {
  Confidence,
  DiagnosticEvidence,
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateParentNode,
} from "../../../../core/index.js";
import {
  findTemplateDirective,
  walkTemplate,
  TemplateNodeType,
} from "../../../../core/rule-authoring.js";
import {
  componentState,
  isStatefulControl,
  nameSuggestsState,
  resolveComponentFile,
} from "./component-state.js";
import type { AnyNode } from "./shared.js";

const KEY_FIELDS = ["id", "uuid", "key"];
const DYNAMIC_COMPONENT_TAGS = new Set(["component", "Component"]);
const TRANSITION_GROUP_TAGS = new Set(["TransitionGroup", "transition-group"]);
const STATELESS_COMPONENTS = new Set(["RouterLink", "router-link", "NuxtLink", "nuxt-link"]);
const TS_VALUE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);

export type StatefulReason = "component" | "model" | "control" | "transition";

/** Why a `v-for` item holds state that Vue moves only when the item is keyed by identity. */
export interface Stateful {
  reason: StatefulReason;
  tag: string;
  /** What Doctor read about the state, for components. */
  evidence?: string;
  /** Lower than the Rule's own confidence when Doctor could not read what the component keeps. */
  confidence?: Confidence;
  /** The component source Doctor read the evidence from. */
  source?: string;
}

/** The `confidence` and `evidence` report options a Stateful classification carries. */
export function statefulReportOptions(stateful: Stateful): {
  confidence?: Confidence;
  evidence?: DiagnosticEvidence[];
} {
  return {
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
  };
}

/** Whether a `v-for` element holds state of its own, or, for `<template v-for>`, through a child. */
export function statefulReason(
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

export function ownStatefulReason(
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
export function stableKeyExpression(
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

export function aliasIdentifier(alias: TemplateDirectiveNode["exp"]): string | null {
  const content = alias?.content.trim();
  return content && /^[A-Za-z_$][\w$]*$/.test(content) ? content : null;
}

/**
 * A check for `v-for` sources whose rendered list never changes: number ranges, string and array
 * literals, and top-level `const` array literals of the current file.
 */
export function unchangingSourceCheck(ctx: RuleContext): (vFor: TemplateDirectiveNode) => boolean {
  let staticBindings: Set<string> | undefined;
  const isStaticBinding = (name: string) => {
    staticBindings ??= collectStaticArrayBindings(ctx.file.sfc?.getScriptAst("merged"));
    return staticBindings.has(name);
  };
  return (vFor) => isUnchangingSource(vFor, isStaticBinding);
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
      const init = unwrapTs(declarator.init);
      if (init?.type === "ArrayExpression") names.add(declarator.id.name);
    }
  }
  return names;
}
