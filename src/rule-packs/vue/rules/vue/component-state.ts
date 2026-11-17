import { basename, dirname, isAbsolute, resolve } from "pathe";
import type { RuleContext, TemplateAstNode } from "../../../../core/index.js";
import { loadVueCompilerSfc } from "../../../../core/internal/lazy-parsers.js";
import { createVueScriptForParsing, parseVueScriptsResult } from "../../../../core/internal/sfc.js";
import {
  SFC_TEMPLATE_PARSE_OPTIONS,
  TemplateNodeType,
  findTemplateAttribute,
  findTemplateDirective,
  templateAstFromDescriptor,
  walkTemplate,
} from "../../../../core/internal/template.js";
import { parseScriptScope, type ScriptScope } from "../../../../core/internal/script-scope.js";
import { vueApiCall } from "./vue-api.js";
import { camelize } from "./component-usage.js";
import type { AnyNode } from "./shared.js";

/** What Doctor read about the local state one component instance keeps. */
export type ComponentState =
  | { kind: "stateful"; file: string; evidence: string }
  | { kind: "unknown"; file?: string; evidence: string }
  | { kind: "stateless"; file: string };

const STATE_APIS = new Set([
  "ref",
  "shallowRef",
  "reactive",
  "shallowReactive",
  "customRef",
  "defineModel",
]);
const FORM_CONTROLS = new Set(["input", "textarea", "select"]);
const STATELESS_INPUT_TYPES = new Set(["hidden", "button", "submit", "reset", "image"]);
const STATEFUL_BUILT_INS = new Set([
  "Transition",
  "transition",
  "TransitionGroup",
  "transition-group",
  "KeepAlive",
  "keep-alive",
]);
// Words in a component name that promise input, selection or open state, such as UInput or
// SelectMenu. Doctor reports components it cannot read only when their name says this.
const STATEFUL_NAME_WORDS = new Set([
  "Input",
  "Textarea",
  "Select",
  "Checkbox",
  "Radio",
  "Switch",
  "Toggle",
  "Slider",
  "Editor",
  "Combobox",
  "Autocomplete",
  "Accordion",
  "Collapsible",
  "Disclosure",
  "Details",
  "Tabs",
  "Form",
]);
const MAX_DEPTH = 4;

/** Whether a native element is a form control that keeps typed text, a choice, or focus. */
export function isStatefulControl(element: AnyNode): boolean {
  if (element.tagType !== 0 || !FORM_CONTROLS.has(element.tag)) return false;
  if (element.tag !== "input") return true;
  const type = findTemplateAttribute(element, "type")?.value?.content.trim().toLowerCase();
  return !type || !STATELESS_INPUT_TYPES.has(type);
}

/** Whether a native element keeps state of its own, such as typed text or an open `<details>`. */
function nativeElementState(element: AnyNode): string | undefined {
  if (element.tagType !== 0) return undefined;
  if (isStatefulControl(element)) return `<${element.tag}>`;
  if (element.tag === "details") return "<details>";
  if (findTemplateAttribute(element, "contenteditable")) return "contenteditable";
  return undefined;
}

/** Whether a component name promises state, for components whose source Doctor cannot read. */
export function nameSuggestsState(tag: string): boolean {
  const pascal = pascalCase(tag);
  return (pascal.match(/[A-Z][a-z0-9]*/g) ?? []).some((word) => STATEFUL_NAME_WORDS.has(word));
}

/**
 * The SFC a template tag renders, through a relative `.vue` import of `program` or the Nuxt
 * component registry, or `undefined` when Doctor cannot tell.
 */
export function resolveComponentFile(
  ctx: RuleContext,
  program: AnyNode,
  fromFile: string,
  tag: string,
): string | undefined {
  const candidates = new Set([tag, camelize(tag), pascalCase(tag)]);
  for (const statement of program?.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    const source = statement.source?.value;
    const specifier = (statement.specifiers ?? []).find((item: AnyNode) =>
      candidates.has(item.local?.name),
    );
    if (!specifier) continue;
    if (specifier.type !== "ImportDefaultSpecifier") return undefined;
    if (typeof source !== "string" || !source.endsWith(".vue")) return undefined;
    if (source.startsWith(".")) return resolve(dirname(fromFile), source);
    return isAbsolute(source) ? source : undefined;
  }
  if (!/^[A-Z]|-/.test(tag)) return undefined;
  const name = pascalCase(tag).replace(/^Lazy(?=[A-Z])/, "");
  for (const entry of ctx.project.nuxt?.components.values() ?? []) {
    if (typeof entry?.name !== "string" || typeof entry.file !== "string") continue;
    if (pascalCase(entry.name) !== name || !entry.file.endsWith(".vue")) continue;
    return isAbsolute(entry.file) ? entry.file : resolve(ctx.project.root, entry.file);
  }
  return undefined;
}

/**
 * The local state one instance of the SFC keeps: Vue state in `<script setup>` or `setup()`,
 * Options API `data`, `defineModel()`, `v-model`, native controls, `<details>`, transitions, or a
 * child component that keeps state. A ref the template binds as `ref="name"` is a DOM handle, not
 * state, and refs in a plain `<script>` are shared by every instance.
 */
export function componentState(
  ctx: RuleContext,
  file: string,
  seen: Set<string> = new Set(),
): ComponentState {
  // Both the remaining depth and cycle exclusions affect recursive conclusions.
  const key = `vue/component-state:${JSON.stringify([file, [...seen].sort()])}`;
  const cached = ctx.cache.get<ComponentState>(key);
  if (cached) return cached;
  if (seen.has(file) || seen.size >= MAX_DEPTH) return { kind: "stateless", file };
  seen.add(file);
  const state = readComponentState(ctx, file, seen);
  seen.delete(file);
  ctx.cache.set(key, state);
  return state;
}

function readComponentState(ctx: RuleContext, file: string, seen: Set<string>): ComponentState {
  const name = basename(file);
  const text = ctx.fs.readText(file);
  if (text === undefined)
    return { kind: "unknown", file, evidence: `Doctor could not read ${name}` };
  const { descriptor, errors } = loadVueCompilerSfc().parse(text, {
    filename: file,
    sourceMap: false,
    templateParseOptions: SFC_TEMPLATE_PARSE_OPTIONS,
  });
  const scripts = parseVueScriptsResult(file, descriptor, text);
  const template = templateAstFromDescriptor(descriptor);
  if (errors.length || scripts.incomplete || (descriptor.template && !template))
    return { kind: "unknown", file, evidence: `Doctor could not parse ${name}` };

  const templateRefs = new Set<string>();
  if (template)
    walkTemplate(template as TemplateAstNode, (node) => {
      if (node.type !== TemplateNodeType.ELEMENT) return;
      const ref = findTemplateAttribute(node, "ref")?.value?.content;
      if (ref) templateRefs.add(ref);
    });

  const script = createVueScriptForParsing(descriptor, text);
  const scope = parseScriptScope(script.text, {
    sourceType: "module",
    dialect: script.lang === "tsx" || script.lang === "jsx" ? script.lang : "ts",
  });
  const scriptEvidence = scriptState(scope, descriptor, templateRefs);
  if (scriptEvidence) return { kind: "stateful", file, evidence: scriptEvidence };

  let unknown: string | undefined;
  let stateful: string | undefined;
  if (template)
    walkTemplate(template as TemplateAstNode, (node) => {
      if (stateful || node.type !== TemplateNodeType.ELEMENT) return;
      if (findTemplateDirective(node, "model")) {
        stateful = "v-model";
        return;
      }
      const native = nativeElementState(node);
      if (native) {
        stateful = native;
        return;
      }
      if (node.tagType !== 1) return;
      if (STATEFUL_BUILT_INS.has(node.tag)) {
        stateful = `<${node.tag}>`;
        return;
      }
      const child = resolveComponentFile(ctx, scripts.ast, file, node.tag);
      if (!child) {
        if (nameSuggestsState(node.tag))
          unknown ??= `<${node.tag}>, which Doctor could not read and whose name says it holds input or open state`;
        return;
      }
      const state = componentState(ctx, child, seen);
      if (state.kind === "stateful")
        stateful = `<${node.tag}>, which keeps it in ${state.evidence}`;
      else if (state.kind === "unknown") unknown ??= `<${node.tag}>: ${state.evidence}`;
    });
  if (stateful) return { kind: "stateful", file, evidence: stateful };
  if (unknown) return { kind: "unknown", file, evidence: unknown };
  return { kind: "stateless", file };
}

function scriptState(
  scope: ScriptScope,
  descriptor: AnyNode,
  templateRefs: Set<string>,
): string | undefined {
  const setup = descriptor.scriptSetup?.loc;
  const inSetupBlock = (node: AnyNode) =>
    !!setup && node.start >= setup.start.offset && node.end <= setup.end.offset;
  let evidence: string | undefined;
  const visit = (node: AnyNode, parent: AnyNode, perInstance: boolean) => {
    if (evidence || !node || typeof node.type !== "string") return;
    if (
      node.type === "Property" &&
      !node.computed &&
      ["setup", "data"].includes(node.key?.name ?? node.key?.value) &&
      isFunction(node.value)
    ) {
      if ((node.key.name ?? node.key.value) === "data" && !inSetupBlock(node)) {
        evidence = "data()";
        return;
      }
      perInstance = true;
    }
    const api =
      node.type === "CallExpression" ? vueApiCall(scope, node.callee, STATE_APIS) : undefined;
    if (
      api &&
      (perInstance || inSetupBlock(node)) &&
      !isTemplateRef(node, parent, templateRefs, api)
    ) {
      evidence = `${api}()`;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key.startsWith("_")) continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (child && typeof child === "object") visit(child, node, perInstance);
    }
  };
  visit(scope.ast, undefined, false);
  return evidence;
}

// `const root = ref<HTMLElement>()` with `<div ref="root">` holds the element, not item state.
function isTemplateRef(
  call: AnyNode,
  parent: AnyNode,
  templateRefs: Set<string>,
  api: string,
): boolean {
  if (api !== "ref" && api !== "shallowRef") return false;
  const initial = call.arguments?.[0];
  const empty =
    !initial ||
    (initial.type === "Literal" && initial.value === null) ||
    (initial.type === "Identifier" && initial.name === "undefined");
  return (
    empty &&
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier" &&
    templateRefs.has(parent.id.name)
  );
}

function isFunction(node: AnyNode): boolean {
  return node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";
}

function pascalCase(tag: string): string {
  const camel = camelize(tag);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}
