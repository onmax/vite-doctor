import type {
  DoctorRule,
  RuleContext,
  TemplateChildNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import { findTemplateDirective, TemplateNodeType } from "../../../../core/rule-authoring.js";
import { createEslintVueRule, createRule, type AnyNode } from "./shared.js";

const RULE_ID = "vue/props/no-unused-props";

const PROPS_HELPERS_ESLINT_FOLLOWS = new Set(["toRefs", "toRef"]);

export const noUnusedProps = withCompleteReferences(
  createEslintVueRule({
    doctorId: RULE_ID,
    eslintId: "vue/no-unused-properties",
    eslintOptions: () => ({ groups: ["props"] }),
    templateReferences: true,
    keepMessage: (message, ctx) => {
      const name = /^'([^']+)'/.exec(message.message)?.[1];
      return !name || !propsKeptOffRoot(ctx).has(name);
    },
    meta: {
      id: RULE_ID,
      title: "Remove props the component never reads",
      category: "props",
      severity: "warn",
      confidence: "heuristic-high",
      fixable: false,
      docsUrl: "https://eslint.vuejs.org/rules/no-unused-properties.html",
      requires: { sfc: true, vue: true },
    },
  }),
);

/**
 * eslint-plugin-vue only sees reads it can follow. It treats the props object passed to an
 * unknown function, such as useVModel(props) or reactiveOmit(props, 'class'), as reading
 * nothing, and it cannot read src or Pug templates. Those files are skipped.
 */
function withCompleteReferences(rule: DoctorRule): DoctorRule {
  return createRule({
    meta: rule.meta,
    create(ctx) {
      if (rendersMarkdown(ctx.file.relativePath)) return;
      const template = (
        ctx.file.sfc?.descriptor as { template?: { src?: string; lang?: string; content?: string } }
      )?.template;
      if (template && (template.src || (template.lang && template.lang !== "html"))) return;
      const propsNames = propsObjectNames(ctx);
      if (propsNames === null) return;
      if (templateUsesWholeProps(template?.content ?? "", propsNames)) return;
      return rule.create(ctx);
    },
  });
}

/** Names bound to the whole props object, or `null` when one escapes to code eslint cannot follow. */
function propsObjectNames(ctx: RuleContext): Set<string> | null {
  const program = ctx.file.sfc?.getScriptAst("merged");
  if (!program) return new Set();
  const names = new Set<string>();
  const declarations = new Set<AnyNode>();
  walk(program, null, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      isPropsMacro(node.init)
    ) {
      names.add(node.id.name);
      declarations.add(node.id);
    }
    const setup = setupFunction(node);
    const param = setup?.params?.[0];
    const paramIdentifier =
      param?.type === "Identifier"
        ? param
        : param?.type === "AssignmentPattern" && param.left?.type === "Identifier"
          ? param.left
          : null;
    if (paramIdentifier) {
      names.add(paramIdentifier.name);
      declarations.add(paramIdentifier);
    }
  });
  if (names.size === 0) return names;
  const followedHelpers = vueImportsOf(program, PROPS_HELPERS_ESLINT_FOLLOWS);

  let escapes = false;
  walk(program, null, (node, parent) => {
    if (escapes || node.type !== "Identifier" || !names.has(node.name) || declarations.has(node))
      return;
    if (!parent) return;
    if (parent.type === "MemberExpression" && parent.object === node) return;
    if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
      return;
    if (
      parent.type === "VariableDeclarator" &&
      parent.init === node &&
      parent.id?.type === "ObjectPattern"
    ) {
      if (
        (parent.id.properties ?? []).some((property: AnyNode) => property.type === "RestElement")
      ) {
        escapes = true;
        return;
      }
      return;
    }
    if (
      parent.type === "CallExpression" &&
      parent.arguments?.[0] === node &&
      parent.callee?.type === "Identifier" &&
      followedHelpers.has(parent.callee.name)
    )
      return;
    if (parent.type.startsWith("TS")) return;
    escapes = true;
  });
  return escapes ? null : names;
}

// eslint follows toRefs(props) only when the helper is imported from vue, not auto-imported.
function vueImportsOf(program: AnyNode, imported: Set<string>): Set<string> {
  const locals = new Set<string>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.source?.value !== "vue") continue;
    for (const specifier of statement.specifiers ?? []) {
      const name = specifier.imported?.name ?? specifier.imported?.value;
      if (specifier.type === "ImportSpecifier" && imported.has(name))
        locals.add(specifier.local.name);
    }
  }
  return locals;
}

function isPropsMacro(node: AnyNode): boolean {
  if (node?.type !== "CallExpression" || node.callee?.type !== "Identifier") return false;
  if (node.callee.name === "defineProps") return true;
  return node.callee.name === "withDefaults" && isPropsMacro(node.arguments?.[0]);
}

function setupFunction(node: AnyNode): AnyNode {
  if (node.type !== "Property" || node.computed) return null;
  if ((node.key?.name ?? node.key?.value) !== "setup") return null;
  const value = node.value;
  return value?.type === "FunctionExpression" || value?.type === "ArrowFunctionExpression"
    ? value
    : null;
}

// A whole-props value in the template, such as fn(props), is a read eslint does not count.
function templateUsesWholeProps(template: string, names: Set<string>): boolean {
  for (const name of ["$props", ...names]) {
    const escaped = name.replace(/\$/g, "\\$");
    const pattern = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(?!\\s*(?:\\?\\.|\\.|\\[))`);
    if (pattern.test(template)) return true;
  }
  return false;
}

function walk(
  node: AnyNode,
  parent: AnyNode,
  visit: (node: AnyNode, parent: AnyNode) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, parent, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("_") || key === "parent") continue;
    if (value && typeof value === "object") walk(value, node, visit);
  }
}

/**
 * Components in Nuxt Content's `components/content/` and Prose components render Markdown. The
 * parser passes them every attribute an author writes, so they declare props only to accept them.
 */
function rendersMarkdown(relativePath: string): boolean {
  const name = relativePath.split("/").pop() ?? "";
  return /(?:^|\/)components\/content\//.test(relativePath) || /^(?:Prose[A-Z]|prose-)/.test(name);
}

const keptOffRoot = new WeakMap<object, { text: string; props: Set<string> }>();

/**
 * Unread props that keep an attribute off the single root. Without the declaration, a value a
 * parent passes falls through to that root: a global or element attribute such as `title` changes
 * what the element does, and an object, array or function renders as a string such as
 * `[object Object]`. Doctor cannot tell that declaration from a leftover, so it reports neither.
 */
function propsKeptOffRoot(ctx: RuleContext): Set<string> {
  const cached = keptOffRoot.get(ctx.file);
  if (cached?.text === ctx.file.text) return cached.props;
  const kept = new Set<string>();
  keptOffRoot.set(ctx.file, { text: ctx.file.text, props: kept });
  const program = ctx.file.sfc?.getScriptAst("merged") as AnyNode;
  const template = ctx.file.sfc?.getTemplateAst();
  if (!template || inheritsNoAttrs(program)) return kept;
  const root = singleRoot(template.children);
  if (!root) return kept;
  for (const [name, structured] of declaredProps(program)) {
    if (structured || isRootAttribute(name, root)) kept.add(name);
  }
  return kept;
}

/** The root tags attrs fall through to, one per `v-if` branch, or `undefined` for a fragment. */
function singleRoot(children: TemplateChildNode[]): TemplateElementNode[] | undefined {
  const groups: TemplateElementNode[][] = [];
  for (const child of children) {
    if (child.type === TemplateNodeType.COMMENT) continue;
    if (child.type === TemplateNodeType.TEXT && !child.content.trim()) continue;
    if (child.type !== TemplateNodeType.ELEMENT) return undefined;
    const chained = findTemplateDirective(child, "else-if") || findTemplateDirective(child, "else");
    if (chained && groups.length) groups.at(-1)!.push(child);
    else groups.push([child]);
  }
  const [root] = groups;
  if (groups.length !== 1 || !root) return undefined;
  const fallsThrough = root.every(
    (element) =>
      (element.tagType === 0 || element.tagType === 1) && !findTemplateDirective(element, "for"),
  );
  return fallsThrough ? root : undefined;
}

function isRootAttribute(prop: string, root: TemplateElementNode[]): boolean {
  const names = new Set([
    prop.toLowerCase(),
    prop.replace(/[A-Z]/g, (char) => `-${char}`).toLowerCase(),
  ]);
  for (const name of names) {
    if (GLOBAL_ATTRIBUTES.has(name) || /^(?:aria|data)-/.test(name)) return true;
    for (const element of root) {
      if (element.tagType === 0 && ELEMENT_ATTRIBUTES[element.tag]?.includes(name)) return true;
    }
  }
  return false;
}

function inheritsNoAttrs(program: AnyNode): boolean {
  let found = false;
  walk(program, null, (node) => {
    if (found || node.type !== "ObjectExpression") return;
    found = (node.properties ?? []).some(
      (property: AnyNode) =>
        property.type === "Property" &&
        (property.key?.name ?? property.key?.value) === "inheritAttrs" &&
        property.value?.type === "Literal" &&
        property.value.value === false,
    );
  });
  return found;
}

/** Declared prop names, each with whether its type is an object, array or function. */
function declaredProps(program: AnyNode): Map<string, boolean> {
  const props = new Map<string, boolean>();
  if (!program) return props;
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
  const structured = (type: AnyNode, seen = new Set<AnyNode>()): boolean => {
    if (!type || seen.has(type)) return false;
    seen.add(type);
    switch (type.type) {
      case "TSTypeLiteral":
      case "TSArrayType":
      case "TSTupleType":
      case "TSFunctionType":
      case "TSMappedType":
      case "TSObjectKeyword":
        return true;
      case "TSParenthesizedType":
        return structured(type.typeAnnotation, seen);
      case "TSUnionType": {
        const members = (type.types ?? []).filter(
          (member: AnyNode) =>
            member.type !== "TSNullKeyword" && member.type !== "TSUndefinedKeyword",
        );
        return members.length > 0 && members.every((member: AnyNode) => structured(member, seen));
      }
      case "TSTypeReference": {
        const name = type.typeName?.name;
        if (STRUCTURED_TYPE_NAMES.has(name)) return true;
        const local = types.get(name);
        if (local?.type === "TSInterfaceDeclaration") return true;
        return local ? structured(local.typeAnnotation, seen) : false;
      }
      default:
        return false;
    }
  };
  const members = (type: AnyNode): AnyNode[] => {
    if (type?.type === "TSTypeLiteral") return type.members ?? [];
    if (type?.type === "TSTypeReference") {
      const local = types.get(type.typeName?.name);
      if (local?.type === "TSInterfaceDeclaration") return local.body?.body ?? [];
      return members(local?.typeAnnotation);
    }
    if (type?.type === "TSIntersectionType") return (type.types ?? []).flatMap(members);
    return [];
  };
  const readRuntime = (options: AnyNode) => {
    if (options?.type === "ArrayExpression") {
      for (const element of options.elements ?? [])
        if (typeof element?.value === "string") props.set(element.value, false);
      return;
    }
    if (options?.type !== "ObjectExpression") return;
    for (const property of options.properties ?? []) {
      const name = property.key?.name ?? property.key?.value;
      if (property.type !== "Property" || typeof name !== "string") continue;
      let value = unwrapTs(property.value);
      if (value?.type === "ObjectExpression") {
        const type = value.properties?.find(
          (option: AnyNode) => (option.key?.name ?? option.key?.value) === "type",
        );
        value = unwrapTs(type?.value);
      }
      const constructors =
        value?.type === "ArrayExpression" ? (value.elements ?? []).map(unwrapTs) : [value];
      props.set(
        name,
        constructors.length > 0 &&
          constructors.every(
            (constructor: AnyNode) =>
              constructor?.type === "Identifier" && STRUCTURED_CONSTRUCTORS.has(constructor.name),
          ),
      );
    }
  };
  walk(program, null, (node) => {
    if (node.type === "CallExpression" && node.callee?.name === "defineProps") {
      const typeArgument = (node.typeArguments ?? node.typeParameters)?.params?.[0];
      for (const member of members(typeArgument)) {
        const name = member.key?.name ?? member.key?.value;
        if (member.type === "TSPropertySignature" && typeof name === "string")
          props.set(name, structured(member.typeAnnotation?.typeAnnotation));
        if (member.type === "TSMethodSignature" && typeof name === "string") props.set(name, true);
      }
      readRuntime(node.arguments?.[0]);
    }
    if (
      node.type === "Property" &&
      (node.key?.name ?? node.key?.value) === "props" &&
      !node.computed
    )
      readRuntime(node.value);
  });
  return props;
}

function unwrapTs(node: AnyNode): AnyNode {
  while (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression")
    node = node.expression;
  return node;
}

const STRUCTURED_TYPE_NAMES = new Set([
  "Array",
  "ReadonlyArray",
  "Record",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Object",
  "Function",
  "Date",
]);
const STRUCTURED_CONSTRUCTORS = new Set(["Object", "Array", "Function", "Date", "Map", "Set"]);

const GLOBAL_ATTRIBUTES = new Set([
  "accesskey",
  "autocapitalize",
  "autocorrect",
  "autofocus",
  "class",
  "contenteditable",
  "dir",
  "draggable",
  "enterkeyhint",
  "exportparts",
  "hidden",
  "id",
  "inert",
  "inputmode",
  "is",
  "itemid",
  "itemprop",
  "itemref",
  "itemscope",
  "itemtype",
  "lang",
  "nonce",
  "part",
  "popover",
  "role",
  "slot",
  "spellcheck",
  "style",
  "tabindex",
  "title",
  "translate",
  "writingsuggestions",
]);

const MEDIA = ["src", "controls", "autoplay", "loop", "muted", "preload", "crossorigin"];
const FORM_ASSOCIATED = ["disabled", "form", "name"];
const ELEMENT_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "rel", "download", "hreflang", "ping", "referrerpolicy", "type"],
  audio: MEDIA,
  blockquote: ["cite"],
  button: [
    ...FORM_ASSOCIATED,
    "type",
    "value",
    "formaction",
    "formenctype",
    "formmethod",
    "formnovalidate",
    "formtarget",
    "popovertarget",
    "popovertargetaction",
    "command",
    "commandfor",
  ],
  canvas: ["width", "height"],
  data: ["value"],
  del: ["cite", "datetime"],
  details: ["open", "name"],
  dialog: ["open"],
  fieldset: FORM_ASSOCIATED,
  form: ["action", "method", "enctype", "target", "novalidate", "name", "autocomplete", "rel"],
  iframe: [
    "src",
    "srcdoc",
    "name",
    "allow",
    "allowfullscreen",
    "width",
    "height",
    "loading",
    "sandbox",
    "referrerpolicy",
  ],
  img: [
    "src",
    "alt",
    "srcset",
    "sizes",
    "width",
    "height",
    "loading",
    "decoding",
    "crossorigin",
    "usemap",
    "ismap",
    "referrerpolicy",
    "fetchpriority",
  ],
  input: [
    ...FORM_ASSOCIATED,
    "accept",
    "alt",
    "autocomplete",
    "capture",
    "checked",
    "dirname",
    "height",
    "list",
    "max",
    "maxlength",
    "min",
    "minlength",
    "multiple",
    "pattern",
    "placeholder",
    "readonly",
    "required",
    "size",
    "src",
    "step",
    "type",
    "value",
    "width",
  ],
  ins: ["cite", "datetime"],
  label: ["for"],
  li: ["value"],
  meter: ["value", "min", "max", "low", "high", "optimum"],
  ol: ["reversed", "start", "type"],
  optgroup: ["disabled", "label"],
  option: ["disabled", "label", "selected", "value"],
  output: [...FORM_ASSOCIATED, "for"],
  progress: ["value", "max"],
  q: ["cite"],
  select: [...FORM_ASSOCIATED, "autocomplete", "multiple", "required", "size"],
  td: ["colspan", "rowspan", "headers"],
  textarea: [
    ...FORM_ASSOCIATED,
    "autocomplete",
    "cols",
    "dirname",
    "maxlength",
    "minlength",
    "placeholder",
    "readonly",
    "required",
    "rows",
    "wrap",
  ],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
  time: ["datetime"],
  video: [...MEDIA, "poster", "width", "height", "playsinline"],
};
