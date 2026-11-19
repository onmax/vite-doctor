import type {
  TemplateAstNode,
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateExpressionNode,
  TemplateParentNode,
  TemplateRootNode,
} from "../../../../core/index.js";
import {
  findTemplateAttribute,
  findTemplateDirective,
  TemplateNodeType,
  walkTemplate,
} from "../../../../core/rule-authoring.js";
import { parseScriptSync } from "../../../../core/internal/script.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/attrs/require-explicit-emits";

type Receiver = "any" | "focusable" | "form-control" | "form" | "image";

interface NativeEvent {
  bubbles: boolean;
  /** What a native element in the component's own DOM has to be for the event to fire on it. */
  receiver: Receiver;
}

// Only events a component's own DOM provably fires. Names such as `select`, `scroll` or `close`
// are common custom events whose native counterpart needs state Doctor cannot read.
const NATIVE_EVENTS = new Map<string, NativeEvent>([
  ...[
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseover",
    "mouseout",
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointerover",
    "pointerout",
    "touchstart",
    "touchend",
    "touchmove",
    "wheel",
  ].map((name) => [name, { bubbles: true, receiver: "any" }] as const),
  ...["keydown", "keyup", "keypress", "focusin", "focusout"].map(
    (name) => [name, { bubbles: true, receiver: "focusable" }] as const,
  ),
  ...["input", "change"].map(
    (name) => [name, { bubbles: true, receiver: "form-control" }] as const,
  ),
  ...["submit", "reset"].map((name) => [name, { bubbles: true, receiver: "form" }] as const),
  ...["mouseenter", "mouseleave"].map(
    (name) => [name, { bubbles: false, receiver: "any" }] as const,
  ),
  ...["focus", "blur"].map((name) => [name, { bubbles: false, receiver: "focusable" }] as const),
  ...["load", "error"].map((name) => [name, { bubbles: false, receiver: "image" }] as const),
]);

const NON_TEXT_INPUT_TYPES = new Set(["button", "submit", "reset", "image", "hidden"]);
// Built-ins that render their default slot in place, so slot elements stay in the root's DOM.
const IN_PLACE_COMPONENTS = new Set(["Transition", "transition"]);

interface TemplateEmit {
  /** The event name exactly as written in `$emit(...)`. */
  name: string;
  /** The native DOM event the parent's listener for it binds when it falls through. */
  domEvent: string;
  argument: AnyNode;
  /** The `v-on` directive whose handler calls `$emit`, and the element it sits on. */
  handler?: { directive: TemplateDirectiveNode; element: TemplateElementNode };
}

type EmitsDeclaration =
  | { kind: "none" }
  | { kind: "unknown" }
  | {
      kind: "known";
      names: string[];
      source: "defineEmits" | "options";
      form: "array" | "object" | "type";
      /** The runtime array literal, when the declaration is one. */
      array?: AnyNode;
    };

interface ComponentDeclarations {
  emits: EmitsDeclaration;
  /** Prop names in camelCase, or `undefined` when Doctor cannot read them. */
  props: Set<string> | undefined;
  models: string[];
  /** `false` when inheritAttrs is off, `undefined` when Doctor cannot tell. */
  inheritAttrs: boolean | undefined;
  /** Whether the component also inherits options Doctor does not read, such as mixins. */
  opaque: boolean;
  hasScriptSetup: boolean;
  hasOptionsObject: boolean;
}

export const requireExplicitEmits = createRule({
  meta: {
    id: RULE_ID,
    title: "Declare emitted events that collide with native listeners",
    description:
      "Reports a template $emit of an event the component does not declare when the parent's listener for it also falls through as a native DOM listener on the component's single native root element.",
    why: "Vue 3 treats a parent's v-on listener as a fallthrough attribute unless the child declares the event in defineEmits or emits. A listener such as @click then lands on the child's root element as a native listener too, so a click that also calls $emit('click', payload) runs the parent's handler twice: once with the payload and once with the native MouseEvent.",
    recommendedReplacement:
      "Declare the event in defineEmits (or the emits option), or emit an event with a name that is not a native DOM event.",
    examples: [
      {
        title: "Declare the emitted click event",
        language: "vue",
        invalid:
          '<template>\n  <button type="button" @click="$emit(\'click\', id)">Open</button>\n</template>',
        valid:
          '<script setup lang="ts">\ndefineEmits([\'click\'])\n</script>\n\n<template>\n  <button type="button" @click="$emit(\'click\', id)">Open</button>\n</template>',
      },
    ],
    category: "attrs",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://eslint.vuejs.org/rules/require-explicit-emits.html",
    requires: { template: true, vue: true },
    frameworkVersions: { vue: ">=3.0.0" },
  },
  create(ctx) {
    if (!ctx.file.isVueSfc || !ctx.file.text.includes("$emit")) return;
    return {
      template: {
        root(node) {
          const root = singleNativeRoot(node);
          if (!root) return;
          const emits = templateEmits(node, (expression) => parseEmitCalls(expression));
          if (emits.length === 0) return;
          const declarations = readDeclarations(
            ctx.file.sfc?.getScriptAst("merged") ?? ctx.file.scriptAst,
            Boolean((ctx.file.sfc?.descriptor as AnyNode)?.scriptSetup),
          );
          if (
            !declarations ||
            declarations.opaque ||
            declarations.inheritAttrs !== true ||
            declarations.emits.kind === "unknown" ||
            !declarations.props
          )
            return;
          const ownDom = nativeDom(root);
          const reported = new Set<string>();
          for (const emit of emits) {
            if (reported.has(emit.domEvent)) continue;
            if (isDeclared(emit.name, declarations)) continue;
            const native = NATIVE_EVENTS.get(emit.domEvent)!;
            if (!receivesNative(root, ownDom, native)) continue;
            const sameEvent = sameEventHandler(emit, ownDom);
            if (sameEvent && sameEvent.element !== root && stopsPropagation(sameEvent.directive))
              continue;
            reported.add(emit.domEvent);
            ctx.report(
              diagnostics.VUE0047({
                why: whyFor(emit, root, sameEvent?.element, native),
                fix: fixFor(emit, root, declarations, ctx.file.text),
              }),
              {
                ruleId: RULE_ID,
                severity: "warn",
                category: "attrs",
                file: ctx.file.path,
                range: ctx.range(emit.argument.start, emit.argument.end),
                fix: suggestionFor(emit, declarations, ctx.file.text),
              },
            );
          }
        },
      },
    };
  },
});

function whyFor(
  emit: TemplateEmit,
  root: TemplateElementNode,
  handlerElement: TemplateElementNode | undefined,
  native: NativeEvent,
): string {
  const listener = `@${emit.domEvent}`;
  const declared = `"${emit.name}" is not declared in defineEmits or emits, so Vue treats the parent's ${listener} listener as a fallthrough attribute and also binds it as a native ${emit.domEvent} listener on the root <${root.tag}>.`;
  if (handlerElement) {
    const where =
      handlerElement === root
        ? `the root <${root.tag}> itself`
        : `<${handlerElement.tag}>${native.bubbles ? `, and the native event bubbles to <${root.tag}>` : ""}`;
    return `$emit('${emit.name}') runs in a ${listener} handler on ${where}. ${declared} One ${emit.domEvent} runs the parent's handler twice: once from $emit with its payload, and once from the native ${emit.domEvent} with the DOM event object.`;
  }
  return `The template calls $emit('${emit.name}'). ${declared} <${root.tag}> ${receiverPhrase(native, root)}, so the parent's handler runs twice: for each $emit('${emit.name}') with its payload, and again for each native ${emit.domEvent} with the DOM event object.`;
}

function receiverPhrase(native: NativeEvent, root: TemplateElementNode): string {
  switch (native.receiver) {
    case "any":
      return native.bubbles
        ? "receives these events from every element inside it"
        : "receives these events itself";
    case "focusable":
      return native.bubbles ? "is or contains a focusable element" : "is focusable";
    case "form-control":
      return "contains a form control that fires them and they bubble";
    case "form":
      return root.tag === "form" ? "is a form" : "contains a form whose events bubble";
    case "image":
      return `is an <${root.tag}> that fires them`;
  }
}

function fixFor(
  emit: TemplateEmit,
  root: TemplateElementNode,
  declarations: ComponentDeclarations,
  source: string,
): string {
  const rename = `If the parent should keep a native ${emit.domEvent} listener on <${root.tag}>, emit an event whose name is not a native DOM event instead.`;
  const quoted = `'${emit.name}'`;
  const emits = declarations.emits;
  let declare: string;
  if (emits.kind === "known" && emits.form === "array" && emits.array) {
    const existing = (emits.array.elements ?? []).map((element: AnyNode) =>
      source.slice(element.start, element.end),
    );
    const list = `[${[...existing, quoted].join(", ")}]`;
    declare =
      emits.source === "defineEmits"
        ? `Add it to defineEmits: \`defineEmits(${list})\`.`
        : `Add it to the emits option: \`emits: ${list}\`.`;
  } else if (emits.kind === "known" && emits.form === "object") {
    declare = `Add \`${objectKey(emit.name)}: null\` to the ${emits.source === "defineEmits" ? "defineEmits" : "emits"} object.`;
  } else if (emits.kind === "known" && emits.form === "type") {
    declare = `Add \`${objectKey(emit.name)}: [...]\` with the payload types to the defineEmits type, for example \`${objectKey(emit.name)}: [value: string]\`.`;
  } else if (declarations.hasOptionsObject && !declarations.hasScriptSetup) {
    declare = `Add \`emits: [${quoted}]\` to the component options.`;
  } else if (declarations.hasScriptSetup) {
    declare = `Declare it in <script setup>: \`defineEmits([${quoted}])\`.`;
  } else {
    declare = `Declare it in a <script setup> block: \`defineEmits([${quoted}])\`.`;
  }
  return `${declare} The parent's ${`@${emit.domEvent}`} then only receives the emitted event. ${rename}`;
}

function suggestionFor(emit: TemplateEmit, declarations: ComponentDeclarations, source: string) {
  const emits = declarations.emits;
  if (emits.kind !== "known" || emits.source !== "defineEmits" || !emits.array) return null;
  const elements = emits.array.elements ?? [];
  const last = elements.at(-1);
  const quote = last ? (source[last.start] === '"' ? '"' : "'") : "'";
  const literal = `${quote}${emit.name}${quote}`;
  const at = last ? last.end : emits.array.start + 1;
  return {
    kind: "suggestion" as const,
    message: `Declare "${emit.name}" in defineEmits.`,
    edits: [{ range: { start: at, end: at }, text: last ? `, ${literal}` : literal }],
  };
}

function objectKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`;
}

/** The template's only root, when it is a native element that inherits attrs. */
function singleNativeRoot(root: TemplateRootNode): TemplateElementNode | undefined {
  const nodes = root.children.filter((child) => child.type !== TemplateNodeType.COMMENT);
  const [only] = nodes;
  if (nodes.length !== 1 || only?.type !== TemplateNodeType.ELEMENT) return undefined;
  if (only.tagType !== 0 || only.tag === "template" || findTemplateDirective(only, "for"))
    return undefined;
  return only;
}

/** Elements the root renders into its own DOM, without crossing into child components. */
function nativeDom(root: TemplateElementNode): Set<TemplateElementNode> {
  const elements = new Set<TemplateElementNode>();
  const visit = (element: TemplateElementNode) => {
    // A plain <template> renders an inert native template element.
    if (element.tagType === 0 && element.tag === "template") return;
    if (element.tagType === 0) elements.add(element);
    else if (element.tagType === 1 && !IN_PLACE_COMPONENTS.has(element.tag)) return;
    for (const child of element.children) if (child.type === TemplateNodeType.ELEMENT) visit(child);
  };
  visit(root);
  return elements;
}

function receivesNative(
  root: TemplateElementNode,
  ownDom: Set<TemplateElementNode>,
  native: NativeEvent,
): boolean {
  const candidates = native.bubbles ? [...ownDom] : [root];
  return candidates.some((element) => isReceiver(element, native.receiver));
}

function isReceiver(element: TemplateElementNode, receiver: Receiver): boolean {
  switch (receiver) {
    case "any":
      return true;
    case "form":
      return element.tag === "form";
    case "image":
      return element.tag === "img";
    case "form-control":
      return (
        element.tag === "textarea" ||
        element.tag === "select" ||
        (element.tag === "input" && isValueInput(element))
      );
    case "focusable":
      return isFocusable(element);
  }
}

function isValueInput(element: TemplateElementNode): boolean {
  if (findTemplateDirective(element, "bind", "type")) return false;
  const type = findTemplateAttribute(element, "type")?.value?.content.toLowerCase();
  return !type || !NON_TEXT_INPUT_TYPES.has(type);
}

function isFocusable(element: TemplateElementNode): boolean {
  if (
    findTemplateAttribute(element, "tabindex") ||
    findTemplateDirective(element, "bind", "tabindex")
  )
    return true;
  if (findTemplateAttribute(element, "contenteditable")) return true;
  switch (element.tag) {
    case "button":
    case "select":
    case "textarea":
      return true;
    case "input":
      return findTemplateAttribute(element, "type")?.value?.content.toLowerCase() !== "hidden";
    case "a":
      return Boolean(
        findTemplateAttribute(element, "href") || findTemplateDirective(element, "bind", "href"),
      );
    default:
      return false;
  }
}

/** The `v-on` handler that calls `$emit`, when it listens for the same native event on the root's own DOM. */
function sameEventHandler(
  emit: TemplateEmit,
  ownDom: Set<TemplateElementNode>,
): TemplateEmit["handler"] {
  const handler = emit.handler;
  if (!handler || !ownDom.has(handler.element)) return undefined;
  const arg = handler.directive.arg;
  if (arg?.type !== TemplateNodeType.SIMPLE_EXPRESSION || !arg.isStatic) return undefined;
  return domEventName(arg.content) === emit.domEvent ? handler : undefined;
}

function stopsPropagation(directive: TemplateDirectiveNode): boolean {
  return (
    directive.modifiers.some((modifier) => modifierName(modifier) === "stop") ||
    Boolean(directive.exp?.content.includes("stopPropagation"))
  );
}

function modifierName(modifier: unknown): string {
  return typeof modifier === "string" ? modifier : (modifier as TemplateExpressionNode).content;
}

function templateEmits(
  root: TemplateRootNode,
  parse: (expression: TemplateExpressionNode) => Array<{ name: string; argument: AnyNode }>,
): TemplateEmit[] {
  const emits: TemplateEmit[] = [];
  walkTemplate(root, (node: TemplateAstNode, parent: TemplateParentNode | undefined) => {
    let expression: TemplateExpressionNode | undefined;
    let handler: TemplateEmit["handler"];
    if (node.type === TemplateNodeType.INTERPOLATION) {
      expression = node.content as TemplateExpressionNode;
    } else if (node.type === TemplateNodeType.DIRECTIVE) {
      if (node.name === "for" || node.name === "slot" || !node.exp) return;
      expression = node.exp as TemplateExpressionNode;
      if (node.name === "on" && parent?.type === TemplateNodeType.ELEMENT)
        handler = { directive: node, element: parent };
    }
    if (!expression || expression.type !== TemplateNodeType.SIMPLE_EXPRESSION) return;
    for (const call of parse(expression)) {
      const domEvent = domEventName(call.name);
      if (!domEvent || !NATIVE_EVENTS.has(domEvent)) continue;
      emits.push({ ...call, domEvent, handler });
    }
  });
  return emits;
}

/**
 * The DOM event a parent's listener for `name` binds when it falls through: Vue's `emit` looks up
 * `on` + capitalize(camelize(name)), and runtime-dom hyphenates what follows `on`.
 */
function domEventName(name: string): string | undefined {
  if (!name || name.includes(":")) return undefined;
  const key = capitalize(camelize(name));
  return hyphenate(key);
}

function parseEmitCalls(
  expression: TemplateExpressionNode,
): Array<{ name: string; argument: AnyNode }> {
  const { content, loc } = expression;
  if (!content.includes("$emit")) return [];
  const offset = loc.start.offset + Math.max(loc.source.indexOf(content), 0);
  const program = parseProgram(`(${content})`, offset - 1) ?? parseProgram(content, offset);
  if (!program) return [];
  const calls: Array<{ name: string; argument: AnyNode }> = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier" || node.callee.name !== "$emit") return;
    const argument = node.arguments?.[0];
    const name = stringValue(argument);
    if (name !== undefined) calls.push({ name, argument });
  });
  return calls;
}

function parseProgram(code: string, offset: number): AnyNode {
  try {
    const result = parseScriptSync("template-expression.ts", code, {
      lang: "ts",
      sourceType: "module",
    });
    if (result.errors.some((error) => error.severity === "Error")) return null;
    const program = result.program as AnyNode;
    walk(program, (node) => {
      node.start += offset;
      node.end += offset;
    });
    return program;
  } catch {
    return null;
  }
}

function readDeclarations(
  program: AnyNode,
  hasScriptSetup: boolean,
): ComponentDeclarations | undefined {
  const declarations: ComponentDeclarations = {
    emits: { kind: "none" },
    props: new Set(),
    models: [],
    inheritAttrs: true,
    opaque: false,
    hasScriptSetup,
    hasOptionsObject: false,
  };
  const types = localTypes(program);
  for (const statement of program?.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      const options = optionsObject(statement.declaration);
      if (!options) return undefined;
      declarations.hasOptionsObject = true;
      readOptions(options, declarations);
      continue;
    }
    for (const call of macroCalls(statement)) readMacro(call, declarations, types);
  }
  return declarations;
}

function optionsObject(node: AnyNode): AnyNode {
  node = unwrapTs(node);
  if (node?.type === "ObjectExpression") return node;
  if (
    node?.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "defineComponent"
  ) {
    const options = unwrapTs(node.arguments?.[0]);
    return options?.type === "ObjectExpression" ? options : null;
  }
  return null;
}

function readOptions(options: AnyNode, declarations: ComponentDeclarations): void {
  for (const property of options.properties ?? []) {
    const key = propertyKey(property);
    if (!key) {
      declarations.opaque = true;
      continue;
    }
    const value = unwrapTs(property.value);
    if (key === "mixins" || key === "extends") declarations.opaque = true;
    if (key === "inheritAttrs") declarations.inheritAttrs = booleanValue(value);
    if (key === "emits") declarations.emits = runtimeEmits(value, "options");
    if (key === "props") declarations.props = mergeProps(declarations.props, runtimeProps(value));
  }
}

function macroCalls(statement: AnyNode): AnyNode[] {
  const roots: AnyNode[] = [];
  if (statement.type === "ExpressionStatement") roots.push(statement.expression);
  if (statement.type === "VariableDeclaration")
    for (const declarator of statement.declarations ?? []) roots.push(declarator.init);
  const calls: AnyNode[] = [];
  for (let node of roots) {
    node = unwrapTs(node);
    if (node?.type !== "CallExpression" || node.callee?.type !== "Identifier") continue;
    if (node.callee.name === "withDefaults") {
      const inner = unwrapTs(node.arguments?.[0]);
      if (inner?.type === "CallExpression") calls.push(inner);
      continue;
    }
    calls.push(node);
  }
  return calls;
}

function readMacro(
  call: AnyNode,
  declarations: ComponentDeclarations,
  types: Map<string, AnyNode>,
): void {
  const name = call.callee?.name;
  const typeArgument = (call.typeArguments ?? call.typeParameters)?.params?.[0];
  if (name === "defineEmits") {
    declarations.emits = typeArgument
      ? typeEmits(typeArgument, types)
      : runtimeEmits(call.arguments?.[0], "defineEmits");
  } else if (name === "defineProps") {
    const props = typeArgument
      ? typeProps(typeArgument, types)
      : call.arguments?.[0]
        ? runtimeProps(unwrapTs(call.arguments[0]))
        : new Set<string>();
    declarations.props = mergeProps(declarations.props, props);
  } else if (name === "defineModel") {
    const first = call.arguments?.[0];
    declarations.models.push(stringValue(first) ?? "modelValue");
  } else if (name === "defineOptions") {
    const options = unwrapTs(call.arguments?.[0]);
    if (options?.type !== "ObjectExpression") {
      declarations.opaque = true;
      return;
    }
    readOptions(options, declarations);
  }
}

function mergeProps(current: Set<string> | undefined, next: Set<string> | undefined) {
  if (!current || !next) return undefined;
  return new Set([...current, ...next]);
}

function runtimeEmits(node: AnyNode, source: "defineEmits" | "options"): EmitsDeclaration {
  node = unwrapTs(node);
  if (!node) return { kind: "known", names: [], source, form: "array" };
  if (node.type === "ArrayExpression") {
    const names: string[] = [];
    for (const element of node.elements ?? []) {
      const name = stringValue(element);
      if (name === undefined) return { kind: "unknown" };
      names.push(name);
    }
    return { kind: "known", names, source, form: "array", array: node };
  }
  if (node.type !== "ObjectExpression") return { kind: "unknown" };
  const names: string[] = [];
  for (const property of node.properties ?? []) {
    const key = propertyKey(property);
    if (!key) return { kind: "unknown" };
    names.push(key);
  }
  return { kind: "known", names, source, form: "object" };
}

function runtimeProps(node: AnyNode): Set<string> | undefined {
  node = unwrapTs(node);
  const names = new Set<string>();
  if (node?.type === "ArrayExpression") {
    for (const element of node.elements ?? []) {
      const name = stringValue(element);
      if (name === undefined) return undefined;
      names.add(camelize(name));
    }
    return names;
  }
  if (node?.type !== "ObjectExpression") return undefined;
  for (const property of node.properties ?? []) {
    const key = propertyKey(property);
    if (!key) return undefined;
    names.add(camelize(key));
  }
  return names;
}

function typeEmits(type: AnyNode, types: Map<string, AnyNode>): EmitsDeclaration {
  const names: string[] = [];
  if (type.type === "TSFunctionType") {
    const literals = literalStrings(type.params?.[0]?.typeAnnotation?.typeAnnotation);
    if (!literals) return { kind: "unknown" };
    return { kind: "known", names: literals, source: "defineEmits", form: "type" };
  }
  const members = typeMembers(type, types, new Set());
  if (!members) return { kind: "unknown" };
  for (const member of members) {
    if (member.type === "TSPropertySignature" || member.type === "TSMethodSignature") {
      const key = propertyKey(member);
      if (!key) return { kind: "unknown" };
      names.push(key);
      continue;
    }
    if (member.type !== "TSCallSignatureDeclaration") return { kind: "unknown" };
    const literals = literalStrings(member.params?.[0]?.typeAnnotation?.typeAnnotation);
    if (!literals) return { kind: "unknown" };
    names.push(...literals);
  }
  return { kind: "known", names, source: "defineEmits", form: "type" };
}

function typeProps(type: AnyNode, types: Map<string, AnyNode>): Set<string> | undefined {
  const members = typeMembers(type, types, new Set());
  if (!members) return undefined;
  const names = new Set<string>();
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature")
      return undefined;
    const key = propertyKey(member);
    if (!key) return undefined;
    names.add(camelize(key));
  }
  return names;
}

function typeMembers(
  type: AnyNode,
  types: Map<string, AnyNode>,
  seen: Set<string>,
): AnyNode[] | undefined {
  if (type?.type === "TSTypeLiteral") return type.members ?? [];
  if (type?.type === "TSIntersectionType") {
    const members: AnyNode[] = [];
    for (const part of type.types ?? []) {
      const partMembers = typeMembers(part, types, seen);
      if (!partMembers) return undefined;
      members.push(...partMembers);
    }
    return members;
  }
  if (type?.type !== "TSTypeReference" || type.typeName?.type !== "Identifier") return undefined;
  if (type.typeArguments ?? type.typeParameters) return undefined;
  const name = type.typeName.name as string;
  const declaration = types.get(name);
  if (!declaration || seen.has(name) || declaration.typeParameters) return undefined;
  seen.add(name);
  if (declaration.type === "TSTypeAliasDeclaration")
    return typeMembers(declaration.typeAnnotation, types, seen);
  const members: AnyNode[] = [...(declaration.body?.body ?? [])];
  for (const heritage of declaration.extends ?? []) {
    const parent = typeMembers(
      {
        type: "TSTypeReference",
        typeName: heritage.expression,
        typeArguments: heritage.typeArguments,
      },
      types,
      seen,
    );
    if (!parent) return undefined;
    members.push(...parent);
  }
  return members;
}

function localTypes(program: AnyNode): Map<string, AnyNode> {
  const types = new Map<string, AnyNode>();
  for (const statement of program?.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      declaration?.id?.name &&
      (declaration.type === "TSInterfaceDeclaration" ||
        declaration.type === "TSTypeAliasDeclaration")
    )
      types.set(declaration.id.name, declaration);
  }
  return types;
}

function literalStrings(type: AnyNode): string[] | undefined {
  if (type?.type === "TSLiteralType") {
    const value = type.literal?.value;
    return typeof value === "string" ? [value] : undefined;
  }
  if (type?.type !== "TSUnionType") return undefined;
  const values: string[] = [];
  for (const part of type.types ?? []) {
    const literal = literalStrings(part);
    if (!literal) return undefined;
    values.push(...literal);
  }
  return values;
}

function isDeclared(name: string, declarations: ComponentDeclarations): boolean {
  const emitted = emitKey(name);
  const emits = declarations.emits;
  if (emits.kind === "known" && emits.names.some((declared) => emitKey(declared) === emitted))
    return true;
  if (declarations.models.some((model) => emitKey(`update:${model}`) === emitted)) return true;
  return declarations.props!.has(`on${capitalize(camelize(name))}`);
}

/** Vue matches a listener to a declared event by the camelized name with its first letter lowered. */
function emitKey(name: string): string {
  const camel = camelize(name);
  return camel.charAt(0).toLowerCase() + camel.slice(1);
}

function booleanValue(node: AnyNode): boolean | undefined {
  return node?.type === "Literal" && typeof node.value === "boolean" ? node.value : undefined;
}

function stringValue(node: AnyNode): string | undefined {
  node = unwrapTs(node);
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value?.cooked ?? undefined;
  return undefined;
}

function propertyKey(property: AnyNode): string | undefined {
  if (!property || property.computed) return undefined;
  if (property.type !== "Property" && !property.type?.startsWith("TS")) return undefined;
  const key = property.key;
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function unwrapTs(node: AnyNode): AnyNode {
  while (
    node &&
    (node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "ParenthesizedExpression")
  )
    node = node.expression;
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

function camelize(name: string): string {
  return name.replace(/-(\w)/g, (_, char: string) => char.toUpperCase());
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function hyphenate(name: string): string {
  return name.replace(/\B([A-Z])/g, "-$1").toLowerCase();
}
