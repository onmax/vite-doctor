import type {
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateExpressionNode,
  TemplateRootNode,
} from "../../../../core/index.js";
import {
  findTemplateAttribute,
  findTemplateDirective,
  templateDirectiveBindings,
  TemplateNodeType,
} from "../../../../core/rule-authoring.js";
import { parseScriptSync } from "../../../../core/internal/script.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/attrs/require-explicit-emits";

// Native events a user action fires, and whether they bubble. Names such as `select`, `scroll` or
// `close` are common custom events, so they stay off the list.
const NATIVE_EVENTS = new Map<string, boolean>([
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
    "keydown",
    "keyup",
    "keypress",
    "focusin",
    "focusout",
    "input",
    "change",
    "submit",
    "reset",
  ].map((name) => [name, true] as const),
  ...["mouseenter", "mouseleave", "focus", "blur", "load", "error"].map(
    (name) => [name, false] as const,
  ),
]);

// Built-in directives that never add a DOM listener which could stop propagation.
const BUILT_IN_DIRECTIVES = new Set([
  "bind",
  "on",
  "if",
  "else",
  "else-if",
  "for",
  "show",
  "model",
  "text",
  "html",
  "slot",
  "once",
  "memo",
  "cloak",
]);
// Built-ins that render their default slot in place, so slot elements stay in the root's DOM.
const IN_PLACE_COMPONENTS = new Set(["Transition", "transition"]);

interface EmitCall {
  name: string;
  /** The event-name argument's range in the SFC source. */
  start: number;
  end: number;
}

interface Handler {
  /** False when the handler could reach the event object in a way Doctor cannot follow. */
  readable: boolean;
  emits: EmitCall[];
}

type EmitsForm =
  | { style: "array"; source: "defineEmits" | "options"; array?: AnyNode }
  | { style: "object"; source: "defineEmits" | "options" }
  | { style: "properties"; target: string }
  | { style: "call-signatures"; target: string; param: string }
  | { style: "function"; type: AnyNode; eventType: AnyNode }
  | { style: "models" };

type EmitsDeclaration = { kind: "unknown" } | { kind: "known"; names: string[]; form?: EmitsForm };

interface OptionFacts {
  emits?: EmitsDeclaration;
  /** Prop names in camelCase, `null` when Doctor cannot read them. */
  props?: Set<string> | null;
  inheritAttrs?: boolean | null;
  opaque: boolean;
}

interface ComponentDeclarations {
  /** Effective emits, after Vue replaces the normal script's option with setup-generated ones. */
  emits: EmitsDeclaration;
  props: Set<string>;
  hasScriptSetup: boolean;
  hasOptionsObject: boolean;
  /** Whether a script binding named `$emit` shadows the component emitter in the template. */
  shadowsEmit: boolean;
}

interface DomTree {
  /** Native elements the root renders into its own DOM, in document order. */
  native: TemplateElementNode[];
  parents: Map<TemplateElementNode, TemplateElementNode>;
}

export const requireExplicitEmits = createRule({
  meta: {
    id: RULE_ID,
    title: "Declare emitted events that collide with native listeners",
    description:
      "Reports a template $emit of an event the component does not declare when it runs in a handler for the same native event, and that native event provably reaches the component's single native root element, where the parent's listener falls through.",
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
          const dom = domTree(root);
          const candidates = emitCandidates(dom, root);
          if (candidates.length === 0) return;
          const declarations = readDeclarations(
            ctx.file.sfc?.getScriptAst("merged") ?? ctx.file.scriptAst,
            ctx.file.sfc?.descriptor as AnyNode,
            ctx.file.text,
          );
          if (!declarations || declarations.shadowsEmit) return;
          const reported = new Set<string>();
          for (const { emit, element, event } of candidates) {
            if (reported.has(event) || isDeclared(emit.name, declarations)) continue;
            if (!pathIsClear(element, root, event, dom.parents)) continue;
            reported.add(event);
            ctx.report(
              diagnostics.VUE0047({
                why: whyFor(emit, event, element, root),
                fix: fixFor(emit, event, root, declarations, ctx.file.text),
              }),
              {
                ruleId: RULE_ID,
                severity: "warn",
                category: "attrs",
                file: ctx.file.path,
                range: ctx.range(emit.start, emit.end),
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
  emit: EmitCall,
  event: string,
  element: TemplateElementNode,
  root: TemplateElementNode,
): string {
  const where =
    element === root
      ? `the root <${root.tag}>`
      : `<${element.tag}>, and nothing between it and the root <${root.tag}> stops the native ${event} from bubbling there`;
  return `$emit('${emit.name}') runs in a @${event} handler on ${where}. "${emit.name}" is not declared in defineEmits or emits, so Vue treats the parent's @${event} listener as a fallthrough attribute and also binds it as a native ${event} listener on the root <${root.tag}>. Each ${event} that runs this $emit runs the parent's handler twice: once from $emit with its payload, and once from the native ${event} with the DOM event object.`;
}

function fixFor(
  emit: EmitCall,
  event: string,
  root: TemplateElementNode,
  declarations: ComponentDeclarations,
  source: string,
): string {
  const rename = `If the parent should keep a native ${event} listener on <${root.tag}>, emit an event whose name is not a native DOM event instead.`;
  return `${declareGuidance(emit.name, declarations, source)} The parent's @${event} then only receives the emitted event. ${rename}`;
}

function declareGuidance(name: string, declarations: ComponentDeclarations, source: string) {
  const quoted = `'${name}'`;
  const form = declarations.emits.kind === "known" ? declarations.emits.form : undefined;
  switch (form?.style) {
    case "array": {
      if (!form.array) return `Replace \`defineEmits()\` with \`defineEmits([${quoted}])\`.`;
      const elements: AnyNode[] = form.array.elements ?? [];
      const quote = quoteOf(elements.at(-1), source);
      const list = `[${[...elements.map((element) => source.slice(element.start, element.end)), `${quote}${name}${quote}`].join(", ")}]`;
      return form.source === "defineEmits"
        ? `Add it to defineEmits: \`defineEmits(${list})\`.`
        : `Add it to the emits option: \`emits: ${list}\`.`;
    }
    case "object":
      return `Add \`${objectKey(name)}: null\` to the ${form.source === "defineEmits" ? "defineEmits" : "emits"} object.`;
    case "properties":
      return `Add the property \`${objectKey(name)}: [...args: any[]]\` to ${form.target}, with the payload types in the tuple.`;
    case "call-signatures":
      return `Add the call signature \`(${form.param}: ${quoted}, ...args: any[]): void\` to ${form.target}, with the payload types after the event name.`;
    case "function":
      return `Add ${quoted} to the event type of the defineEmits function type: \`${functionTypeWith(form, name, source)}\`.`;
    case "models":
      return `Add \`defineEmits([${quoted}])\` to <script setup>. Vue merges it with the defineModel() update events.`;
  }
  if (declarations.hasOptionsObject && !declarations.hasScriptSetup)
    return `Add \`emits: [${quoted}]\` to the component options.`;
  if (declarations.hasScriptSetup)
    return `Declare it in <script setup>: \`defineEmits([${quoted}])\`.`;
  return `Declare it in a <script setup> block: \`defineEmits([${quoted}])\`.`;
}

function functionTypeWith(
  form: Extract<EmitsForm, { style: "function" }>,
  name: string,
  source: string,
): string {
  const { type, eventType } = form;
  return `${source.slice(type.start, eventType.end)} | '${name}'${source.slice(eventType.end, type.end)}`;
}

function suggestionFor(emit: EmitCall, declarations: ComponentDeclarations, source: string) {
  const emits = declarations.emits;
  const form = emits.kind === "known" ? emits.form : undefined;
  if (form?.style !== "array" || form.source !== "defineEmits" || !form.array) return null;
  const last = (form.array.elements ?? []).at(-1);
  const quote = quoteOf(last, source);
  const literal = `${quote}${emit.name}${quote}`;
  const at = last ? last.end : form.array.start + 1;
  return {
    kind: "suggestion" as const,
    message: `Declare "${emit.name}" in defineEmits.`,
    edits: [{ range: { start: at, end: at }, text: last ? `, ${literal}` : literal }],
  };
}

function quoteOf(node: AnyNode, source: string): string {
  return node && source[node.start] === '"' ? '"' : "'";
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
function domTree(root: TemplateElementNode): DomTree {
  const tree: DomTree = { native: [], parents: new Map() };
  const visit = (element: TemplateElementNode) => {
    // A plain <template> renders an inert native template element.
    if (element.tagType === 0 && element.tag === "template") return;
    if (element.tagType === 0) tree.native.push(element);
    else if (element.tagType === 1 && !IN_PLACE_COMPONENTS.has(element.tag)) return;
    for (const child of element.children) {
      if (child.type !== TemplateNodeType.ELEMENT) continue;
      tree.parents.set(child, element);
      visit(child);
    }
  };
  visit(root);
  return tree;
}

/** Template `$emit` calls that run in a handler for the native event of the same name. */
function emitCandidates(dom: DomTree, root: TemplateElementNode) {
  const candidates: Array<{ emit: EmitCall; element: TemplateElementNode; event: string }> = [];
  for (const element of dom.native) {
    for (const prop of element.props) {
      if (prop.type !== TemplateNodeType.DIRECTIVE || prop.name !== "on") continue;
      const event = listenerEvent(prop);
      const bubbles = event === null ? undefined : NATIVE_EVENTS.get(event);
      if (bubbles === undefined || (!bubbles && element !== root)) continue;
      // A capture handler runs before the target, so descendants could still stop the event.
      if (hasModifier(prop, "capture")) continue;
      const handler = readHandler(prop);
      if (!handler.readable) continue;
      for (const emit of handler.emits) {
        if (domEventName(emit.name) !== event) continue;
        if (emitShadowed(element, dom.parents)) continue;
        candidates.push({ emit, element, event });
      }
    }
  }
  return candidates;
}

/** The event a `v-on` directive listens for, as runtime-dom binds it, or `null` for a dynamic or object `v-on`. */
function listenerEvent(directive: TemplateDirectiveNode): string | null {
  const arg = directive.arg;
  if (arg?.type !== TemplateNodeType.SIMPLE_EXPRESSION || !arg.isStatic) return null;
  const event = domEventName(arg.content) ?? arg.content;
  if (event === "click") {
    if (hasModifier(directive, "right")) return "contextmenu";
    if (hasModifier(directive, "middle")) return "mouseup";
  }
  return event;
}

function hasModifier(directive: TemplateDirectiveNode, name: string): boolean {
  return directive.modifiers.some(
    (modifier) =>
      (typeof modifier === "string" ? modifier : (modifier as TemplateExpressionNode).content) ===
      name,
  );
}

function emitShadowed(
  element: TemplateElementNode,
  parents: Map<TemplateElementNode, TemplateElementNode>,
): boolean {
  for (let current: TemplateElementNode | undefined = element; current;) {
    for (const prop of current.props) {
      if (prop.type !== TemplateNodeType.DIRECTIVE) continue;
      if (prop.name !== "for" && prop.name !== "slot") continue;
      if (templateDirectiveBindings(prop).includes("$emit")) return true;
    }
    current = parents.get(current);
  }
  return false;
}

/**
 * Whether the native event that runs the handler on `element` provably reaches the root's
 * fallthrough listener: nothing on the way can stop it, and every listener for it is one Doctor can read.
 */
function pathIsClear(
  element: TemplateElementNode,
  root: TemplateElementNode,
  event: string,
  parents: Map<TemplateElementNode, TemplateElementNode>,
): boolean {
  for (let current: TemplateElementNode | undefined = element; current;) {
    const isRoot = current === root;
    for (const prop of current.props) {
      if (prop.type === TemplateNodeType.ATTRIBUTE) {
        // Script code can add listeners to a template ref after Vue's own.
        if (!isRoot && prop.name === "ref") return false;
        continue;
      }
      // A custom directive's `created` hook can add a listener before Vue binds the root's own.
      if (!BUILT_IN_DIRECTIVES.has(prop.name)) return false;
      if (prop.name === "bind") {
        const arg = prop.arg;
        if (arg?.type !== TemplateNodeType.SIMPLE_EXPRESSION || !arg.isStatic) return false;
        if (/^on[A-Z]/.test(arg.content) || (!isRoot && arg.content === "ref")) return false;
        continue;
      }
      if (prop.name !== "on") continue;
      const listens = listenerEvent(prop);
      if (listens === null) return false;
      if (listens !== event) continue;
      // `.stop` on the root itself does not keep the event from the root's other listeners.
      if (!isRoot && hasModifier(prop, "stop")) return false;
      if (!readHandler(prop).readable) return false;
    }
    if (isRoot) return true;
    current = parents.get(current);
  }
  return false;
}

/**
 * Reads a `v-on` handler. Doctor can follow it when it never hands the event object to code it
 * cannot read: no method handler, no function with parameters, and `$event` only for property reads.
 */
function readHandler(directive: TemplateDirectiveNode): Handler {
  const expression = directive.exp;
  if (!expression) return { readable: true, emits: [] };
  if (expression.type !== TemplateNodeType.SIMPLE_EXPRESSION) return { readable: false, emits: [] };
  const content = expression.content;
  if (!content.trim()) return { readable: true, emits: [] };
  const asExpression = parseProgram(`(${content})`);
  let body: AnyNode;
  let shift = 1;
  if (asExpression) {
    const value = unwrapTs(asExpression.body?.[0]?.expression);
    if (value?.type === "Identifier" || value?.type === "MemberExpression")
      return { readable: false, emits: [] };
    if (value?.type === "ArrowFunctionExpression" || value?.type === "FunctionExpression") {
      if (value.type === "FunctionExpression" || (value.params?.length ?? 0) > 0)
        return { readable: false, emits: [] };
      body = value.body;
    } else body = value;
  } else {
    body = parseProgram(content);
    shift = 0;
    if (!body) return { readable: false, emits: [] };
  }
  const toSource = sourceOffsets(expression);
  const emits: EmitCall[] = [];
  let readable = true;
  walkWithAncestors(body, [], (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
      readable = false;
      return;
    }
    if (node.type === "Identifier" && node.name === "$event" && isReference(node, parent)) {
      if (!isPropertyRead(node, ancestors)) readable = false;
      return;
    }
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier" || node.callee.name !== "$emit") return;
    const argument = node.arguments?.[0];
    const name = stringValue(argument);
    if (name === undefined || !toSource) return;
    emits.push({
      name,
      start: toSource(argument.start - shift),
      end: toSource(argument.end - shift),
    });
  });
  return { readable, emits };
}

function isReference(node: AnyNode, parent: AnyNode): boolean {
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  if (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
    return false;
  return true;
}

/** `$event.target` is a read; `$event.stopPropagation()`, `$event.cancelBubble = true` or a bare `$event` are not. */
function isPropertyRead(node: AnyNode, ancestors: AnyNode[]): boolean {
  const member = ancestors.at(-1);
  if (member?.type !== "MemberExpression" || member.object !== node || member.computed)
    return false;
  let child = member;
  let index = ancestors.length - 2;
  while (ancestors[index]?.type === "ParenthesizedExpression") child = ancestors[index--];
  const user = ancestors[index];
  if (user?.type === "CallExpression" && user.callee === child) return false;
  if (user?.type === "AssignmentExpression" && user.left === child) return false;
  if (user?.type === "UpdateExpression" || user?.type === "UnaryExpression") return false;
  return true;
}

/** Maps an offset in the decoded expression back to the raw SFC text, or `undefined` if Doctor cannot. */
function sourceOffsets(
  expression: TemplateExpressionNode,
): ((index: number) => number) | undefined {
  const { content, loc } = expression;
  const raw = loc.source;
  const base = loc.start.offset;
  if (raw === content) return (index) => base + index;
  const map: number[] = [];
  let decoded = "";
  for (let index = 0; index < raw.length;) {
    const entity =
      raw[index] === "&"
        ? /^&(#\d+|#[xX][\da-fA-F]+|[A-Za-z]+);/.exec(raw.slice(index, index + 12))
        : null;
    const text = entity ? decodeEntity(entity[1]!) : raw[index]!;
    if (text === undefined) return undefined;
    for (let unit = 0; unit < text.length; unit++) map.push(index);
    decoded += text;
    index += entity ? entity[0].length : 1;
  }
  map.push(raw.length);
  if (decoded !== content) return undefined;
  return (index) => base + map[index]!;
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

function decodeEntity(entity: string): string | undefined {
  if (entity.startsWith("#")) {
    const code =
      entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : undefined;
  }
  return NAMED_ENTITIES[entity];
}

/**
 * The DOM event a parent's listener for `name` binds when it falls through: Vue's `emit` looks up
 * `on` + capitalize(camelize(name)), and runtime-dom hyphenates what follows `on`.
 */
function domEventName(name: string): string | undefined {
  if (!name || name.includes(":")) return undefined;
  return hyphenate(capitalize(camelize(name)));
}

function parseProgram(code: string): AnyNode {
  try {
    const result = parseScriptSync("template-expression.ts", code, {
      lang: "ts",
      sourceType: "module",
    });
    if (result.errors.some((error) => error.severity === "Error")) return null;
    return result.program as AnyNode;
  } catch {
    return null;
  }
}

/**
 * Vue's effective component declarations. With both script blocks, the compiler spreads the normal
 * script's options first and then writes setup-generated `props`, `emits` and `defineOptions()`
 * over them, so a setup declaration replaces the normal script's option instead of merging with it.
 */
function readDeclarations(
  program: AnyNode,
  descriptor: AnyNode,
  source: string,
): ComponentDeclarations | undefined {
  const scriptBlock = descriptor?.script;
  const setupBlock = descriptor?.scriptSetup;
  if (scriptBlock?.src || setupBlock?.src) return undefined;
  if (!program && (scriptBlock?.content?.trim() || setupBlock?.content?.trim())) return undefined;
  const inSetup = (statement: AnyNode) =>
    Boolean(setupBlock) &&
    statement.start >= setupBlock.loc.start.offset &&
    statement.end <= setupBlock.loc.end.offset;
  const statements: AnyNode[] = program?.body ?? [];
  const setupStatements = statements.filter(inSetup);
  const normalStatements = statements.filter((statement) => !inSetup(statement));
  const types = localTypes(statements);
  if (!types) return undefined;

  const normal: OptionFacts = { opaque: false };
  let hasOptionsObject = false;
  for (const statement of normalStatements) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    const options = optionsObject(statement.declaration);
    if (!options) return undefined;
    hasOptionsObject = true;
    readOptions(options, normal);
  }

  const setup = setupBlock ? readSetup(setupStatements, types, source) : undefined;
  if (setup === null) return undefined;
  const options = setup?.options;
  if (normal.opaque || options?.opaque) return undefined;
  const inheritAttrs =
    options?.inheritAttrs !== undefined ? options.inheritAttrs : (normal.inheritAttrs ?? true);
  if (inheritAttrs !== true) return undefined;

  let emits: EmitsDeclaration = normal.emits ?? { kind: "known", names: [] };
  if (setup && (setup.emits || setup.models.length > 0)) {
    const declared = setup.emits ?? { kind: "known", names: [], form: { style: "models" } };
    if (declared.kind === "unknown") return undefined;
    emits = {
      kind: "known",
      names: [...declared.names, ...setup.models.map((model) => `update:${model}`)],
      form: declared.form,
    };
  }
  if (emits.kind === "unknown") return undefined;

  let props = normal.props === undefined ? new Set<string>() : normal.props;
  if (setup && (setup.props !== undefined || setup.models.length > 0))
    props = setup.props === undefined ? new Set() : setup.props;
  if (!props) return undefined;

  return {
    emits,
    props,
    hasScriptSetup: Boolean(setupBlock),
    hasOptionsObject,
    shadowsEmit: Boolean(setupBlock) && topLevelBindings(statements).has("$emit"),
  };
}

interface SetupFacts {
  emits?: EmitsDeclaration;
  props?: Set<string> | null;
  models: string[];
  options: OptionFacts;
}

/** Reads the setup macros, or `null` when they cannot be read. */
function readSetup(
  statements: AnyNode[],
  types: Map<string, AnyNode[]>,
  source: string,
): SetupFacts | null {
  const facts: SetupFacts = { models: [], options: { opaque: false } };
  for (const statement of statements) {
    for (const call of macroCalls(statement)) {
      const name = call.callee?.name;
      const typeArgument = (call.typeArguments ?? call.typeParameters)?.params?.[0];
      if (name === "defineEmits") {
        // Vue rejects a second defineEmits() call.
        if (facts.emits) return null;
        facts.emits = typeArgument
          ? typeEmits(typeArgument, types, source)
          : runtimeEmits(call.arguments?.[0], "defineEmits");
      } else if (name === "defineProps") {
        if (facts.props !== undefined) return null;
        facts.props = typeArgument
          ? typeProps(typeArgument, types)
          : call.arguments?.[0]
            ? (runtimeProps(call.arguments[0]) ?? null)
            : new Set<string>();
      } else if (name === "defineModel") {
        const first = unwrapTs(call.arguments?.[0]);
        const model =
          first === undefined || first?.type === "ObjectExpression"
            ? "modelValue"
            : stringValue(first);
        if (model === undefined) return null;
        facts.models.push(model);
      } else if (name === "defineOptions") {
        const options = unwrapTs(call.arguments?.[0]);
        if (options?.type !== "ObjectExpression") return null;
        readOptions(options, facts.options);
      }
    }
  }
  return facts;
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

function readOptions(options: AnyNode, facts: OptionFacts): void {
  for (const property of options.properties ?? []) {
    const key = propertyKey(property);
    if (!key) {
      facts.opaque = true;
      continue;
    }
    const value = unwrapTs(property.value);
    if (key === "mixins" || key === "extends") facts.opaque = true;
    if (key === "inheritAttrs") facts.inheritAttrs = booleanValue(value) ?? null;
    if (key === "emits") facts.emits = runtimeEmits(value, "options");
    if (key === "props") facts.props = runtimeProps(value) ?? null;
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

function runtimeEmits(node: AnyNode, source: "defineEmits" | "options"): EmitsDeclaration {
  node = unwrapTs(node);
  if (!node) return { kind: "known", names: [], form: { style: "array", source } };
  if (node.type === "ArrayExpression") {
    const names: string[] = [];
    for (const element of node.elements ?? []) {
      const name = stringValue(element);
      if (name === undefined) return { kind: "unknown" };
      names.push(name);
    }
    return { kind: "known", names, form: { style: "array", source, array: node } };
  }
  if (node.type !== "ObjectExpression") return { kind: "unknown" };
  const names: string[] = [];
  for (const property of node.properties ?? []) {
    const key = propertyKey(property);
    if (!key) return { kind: "unknown" };
    names.push(key);
  }
  return { kind: "known", names, form: { style: "object", source } };
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

function typeEmits(type: AnyNode, types: Map<string, AnyNode[]>, source: string): EmitsDeclaration {
  if (type.type === "TSFunctionType") {
    const eventType = type.params?.[0]?.typeAnnotation?.typeAnnotation;
    const literals = literalStrings(eventType);
    if (!literals) return { kind: "unknown" };
    return { kind: "known", names: literals, form: { style: "function", type, eventType } };
  }
  const members = typeMembers(type, types, new Set());
  if (!members) return { kind: "unknown" };
  const names: string[] = [];
  let calls = 0;
  let param = "e";
  for (const member of members) {
    if (member.type === "TSPropertySignature" || member.type === "TSMethodSignature") {
      const key = propertyKey(member);
      if (!key) return { kind: "unknown" };
      names.push(key);
      continue;
    }
    if (member.type !== "TSCallSignatureDeclaration") return { kind: "unknown" };
    const first = member.params?.[0];
    const literals = literalStrings(first?.typeAnnotation?.typeAnnotation);
    if (!literals) return { kind: "unknown" };
    if (calls === 0 && first?.type === "Identifier")
      param = source.slice(first.start, first.start + first.name.length);
    calls++;
    names.push(...literals);
  }
  // Vue rejects a defineEmits() type that mixes call signatures and properties.
  if (calls > 0 && calls < members.length) return { kind: "unknown" };
  const target = typeTarget(type, types);
  return {
    kind: "known",
    names,
    form: calls > 0 ? { style: "call-signatures", target, param } : { style: "properties", target },
  };
}

function typeTarget(type: AnyNode, types: Map<string, AnyNode[]>): string {
  if (type.type === "TSTypeLiteral") return "the defineEmits type literal";
  if (type.type === "TSTypeReference" && type.typeName?.type === "Identifier") {
    const declaration = types.get(type.typeName.name)?.[0];
    const keyword = declaration?.type === "TSInterfaceDeclaration" ? "interface" : "type";
    return `\`${keyword} ${type.typeName.name}\``;
  }
  return "one of the object types in the defineEmits type";
}

function typeProps(type: AnyNode, types: Map<string, AnyNode[]>): Set<string> | null {
  const members = typeMembers(type, types, new Set());
  if (!members) return null;
  const names = new Set<string>();
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") return null;
    const key = propertyKey(member);
    if (!key) return null;
    names.add(camelize(key));
  }
  return names;
}

function typeMembers(
  type: AnyNode,
  types: Map<string, AnyNode[]>,
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
  const declarations = types.get(name);
  if (!declarations || seen.has(name)) return undefined;
  seen.add(name);
  const members: AnyNode[] = [];
  // Interfaces with the same name merge, so every declaration contributes members.
  for (const declaration of declarations) {
    if (declaration.typeParameters) return undefined;
    if (declaration.type === "TSTypeAliasDeclaration") {
      const aliased = typeMembers(declaration.typeAnnotation, types, seen);
      if (!aliased) return undefined;
      members.push(...aliased);
      continue;
    }
    members.push(...(declaration.body?.body ?? []));
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
  }
  return members;
}

/** Top-level interfaces and type aliases from both script blocks, or `undefined` when a name is declared ambiguously. */
function localTypes(statements: AnyNode[]): Map<string, AnyNode[]> | undefined {
  const types = new Map<string, AnyNode[]>();
  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      !declaration?.id?.name ||
      (declaration.type !== "TSInterfaceDeclaration" &&
        declaration.type !== "TSTypeAliasDeclaration")
    )
      continue;
    const existing = types.get(declaration.id.name);
    if (!existing) {
      types.set(declaration.id.name, [declaration]);
      continue;
    }
    // Only interfaces merge; any other repeat is a TypeScript error Doctor does not resolve.
    if (
      declaration.type !== "TSInterfaceDeclaration" ||
      existing.some((other) => other.type !== "TSInterfaceDeclaration")
    )
      return undefined;
    existing.push(declaration);
  }
  return types;
}

/** Names the script blocks declare at the top level, which the template can see. */
function topLevelBindings(statements: AnyNode[]): Set<string> {
  const names = new Set<string>();
  const collect = (pattern: AnyNode) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        names.add(pattern.name);
        return;
      case "ObjectPattern":
        for (const property of pattern.properties ?? [])
          collect(property.type === "RestElement" ? property.argument : property.value);
        return;
      case "ArrayPattern":
        for (const element of pattern.elements ?? []) collect(element);
        return;
      case "RestElement":
        collect(pattern.argument);
        return;
      case "AssignmentPattern":
        collect(pattern.left);
    }
  };
  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (!declaration) continue;
    if (declaration.type === "ImportDeclaration")
      for (const specifier of declaration.specifiers ?? []) collect(specifier.local);
    else if (declaration.type === "VariableDeclaration")
      for (const declarator of declaration.declarations ?? []) collect(declarator.id);
    else if (declaration.id) collect(declaration.id);
  }
  return names;
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
  return declarations.props.has(`on${capitalize(camelize(name))}`);
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

function walkWithAncestors(
  node: AnyNode,
  ancestors: AnyNode[],
  visit: (node: AnyNode, ancestors: AnyNode[]) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkWithAncestors(child, ancestors, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key.startsWith("_")) continue;
    if (value && typeof value === "object") walkWithAncestors(value, ancestors, visit);
  }
  ancestors.pop();
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
