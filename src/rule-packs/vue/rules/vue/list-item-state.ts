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
import { bindingNames, type AnyNode } from "./shared.js";

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

export function verifiedKeyExpression(
  ctx: RuleContext,
  vFor: TemplateDirectiveNode,
  source: AnyNode,
): string | undefined {
  const alias = aliasIdentifier(vFor.forParseResult!.value);
  if (!alias) return undefined;
  const sfc = ctx.file.sfc;
  const fields =
    source?.type === "ArrayExpression"
      ? distinctLiteralKeys(source)
      : sfc?.blockHashes.scriptSetup
        ? itemFields(sfc.getScriptAst("merged"), vFor.forParseResult!.source.content, true)
        : undefined;
  const field = KEY_FIELDS.find((name) => fields?.has(name));
  return field ? `${alias}.${field}` : undefined;
}

function distinctLiteralKeys(array: AnyNode): Set<string> {
  if (!array.elements.length) return new Set();
  return new Set(
    KEY_FIELDS.filter((field) => {
      const values = new Set<string | number>();
      return array.elements.every((item: AnyNode) => {
        const object = unwrapTs(item);
        if (
          object?.type !== "ObjectExpression" ||
          object.properties.some(
            (prop: AnyNode) => prop.type !== "Property" || prop.computed || prop.kind !== "init",
          )
        )
          return false;
        const property = object.properties.findLast(
          (prop: AnyNode) => (prop.key.name ?? prop.key.value) === field,
        );
        const literal = unwrapTs(property?.value);
        const value = literal?.value;
        if (
          literal?.type !== "Literal" ||
          (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) ||
          values.has(value)
        )
          return false;
        values.add(value);
        return true;
      });
    }),
  );
}

/** Fields the items of a `v-for` source have, read from its script literal or declared type. */
function itemFields(program: AnyNode, source: string, verify = false): Set<string> {
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
      if (
        typeof key === "string" &&
        (!verify ||
          (member.type === "TSPropertySignature" &&
            !member.optional &&
            !member.computed &&
            ["TSStringKeyword", "TSNumberKeyword", "TSSymbolKeyword"].includes(
              member.typeAnnotation?.typeAnnotation?.type,
            )))
      )
        fields.add(key);
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
  const inspect = (node: AnyNode) => {
    if (node.type === "VariableDeclarator" && !viaProps && node.id?.name === name) {
      let init = unwrapTs(node.init);
      if (verify) addMembers(elementType(node.id.typeAnnotation?.typeAnnotation));
      if (init?.type === "CallExpression") {
        if (
          verify &&
          !["ref", "shallowRef", "reactive", "shallowReactive"].includes(init.callee?.name)
        )
          return;
        addMembers(elementType(typeArguments(init)?.[0]));
        init = unwrapTs(init.arguments?.[0]);
      }
      if (init?.type === "ArrayExpression") {
        if (!verify) addLiteral(init);
        else if (init.elements.length) {
          fields.clear();
          for (const field of distinctLiteralKeys(init)) fields.add(field);
        }
      }
    }
    if (!verify && node.type === "CallExpression" && node.callee?.name === "defineProps") {
      for (const member of membersOf(typeArguments(node)?.[0])) {
        if ((member.key?.name ?? member.key?.value) === name)
          addMembers(elementType(member.typeAnnotation?.typeAnnotation));
      }
    }
  };
  if (!verify) {
    walk(program, inspect);
    return fields;
  }

  let props: AnyNode;
  const addProp = (expression: AnyNode, prop: string, fallback?: AnyNode) => {
    const member = membersOf(typeArguments(definePropsCall(expression))?.[0]).find(
      (entry) => !entry.computed && (entry.key?.name ?? entry.key?.value) === prop,
    );
    addMembers(elementType(member?.typeAnnotation?.typeAnnotation));
    if (fallback) restrictToDefault(fallback);
    if (expression.callee?.name === "withDefaults") {
      const defaults = unwrapTs(expression.arguments?.[1]);
      if (
        defaults?.type !== "ObjectExpression" ||
        defaults.properties.some((entry: AnyNode) => entry.type !== "Property" || entry.computed)
      ) {
        fields.clear();
        return;
      }
      const property = defaults.properties.findLast(
        (entry: AnyNode) => (entry.key.name ?? entry.key.value) === prop,
      );
      if (property) restrictToDefault(property.value);
    }
  };
  const restrictToDefault = (expression: AnyNode) => {
    let value = unwrapTs(expression);
    if (value?.type === "ArrowFunctionExpression") value = unwrapTs(value.body);
    if (value?.type === "ArrayExpression" && value.elements.length === 0) return;
    const valid = value?.type === "ArrayExpression" ? distinctLiteralKeys(value) : undefined;
    for (const field of fields) if (!valid?.has(field)) fields.delete(field);
  };
  const localName = viaProps ?? name;
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "ImportDeclaration" && declaration.importKind !== "type") {
      if (declaration.specifiers.some((entry: AnyNode) => entry.local.name === localName))
        return fields;
    }
    if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
      if (declaration.id?.name === localName) return fields;
    }
    if (declaration?.type === "ExpressionStatement" && definePropsCall(declaration.expression))
      props = declaration.expression;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const binding of declaration.declarations) {
      const call = definePropsCall(binding.init);
      if (call) props = binding.init;
      if (!bindingNames(binding.id).includes(localName)) continue;
      if (viaProps) {
        if (binding.id.name === localName && call) addProp(binding.init, name);
      } else if (call && binding.id.type === "ObjectPattern") {
        const property = binding.id.properties.find((entry: AnyNode) => {
          if (entry.type !== "Property" || entry.computed) return false;
          const value = entry.value.type === "AssignmentPattern" ? entry.value.left : entry.value;
          return value.type === "Identifier" && value.name === localName;
        });
        if (property)
          addProp(
            binding.init,
            property.key.name ?? property.key.value,
            property.value.type === "AssignmentPattern" ? property.value.right : undefined,
          );
      } else inspect(binding);
      return fields;
    }
  }
  if ((!viaProps || viaProps === "$props") && props) addProp(props, name);
  return fields;
}

function definePropsCall(node: AnyNode): AnyNode {
  if (node?.type !== "CallExpression") return undefined;
  const call = node.callee?.name === "withDefaults" ? node.arguments?.[0] : node;
  return call?.type === "CallExpression" && call.callee?.name === "defineProps" ? call : undefined;
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
