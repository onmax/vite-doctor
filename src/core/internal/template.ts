import type {
  ScriptAstNode,
  TemplateAstNode,
  TemplateAttributeNode,
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateExpressionNode,
  TemplateNodeKind,
  TemplateParentNode,
  TemplateRootNode,
  TemplateVisitor,
} from "../primitives.js";
import { parseScriptSync } from "./script.js";
import { getNodeVisitorKeys } from "./visitor-keys.js";

export const TemplateNodeType = {
  ROOT: 0,
  ELEMENT: 1,
  TEXT: 2,
  COMMENT: 3,
  SIMPLE_EXPRESSION: 4,
  INTERPOLATION: 5,
  ATTRIBUTE: 6,
  DIRECTIVE: 7,
} as const;

/** Options for every SFC parse, so the AST does not depend on NODE_ENV. */
export const SFC_TEMPLATE_PARSE_OPTIONS = { comments: true } as const;

const KIND_BY_TYPE: Record<number, TemplateNodeKind> = {
  0: "root",
  1: "element",
  2: "text",
  3: "comment",
  5: "interpolation",
  6: "attribute",
  7: "directive",
};

type TemplateHandler = (node: TemplateAstNode, parent: TemplateParentNode | undefined) => void;
type TemplateHandlerTable = Partial<Record<string, TemplateHandler[]>>;

export function templateAstFromDescriptor(descriptor: unknown): TemplateRootNode | null {
  const template = (descriptor as { template?: { ast?: unknown; lang?: string } | null })?.template;
  if (!template?.ast) return null;
  if (template.lang && template.lang !== "html") return null;
  return template.ast as TemplateRootNode;
}

export function dispatchTemplate(root: TemplateRootNode, visitors: readonly TemplateVisitor[]) {
  const table: TemplateHandlerTable = {};
  for (const visitor of visitors) {
    for (const key in visitor) {
      const handler = (visitor as Record<string, unknown>)[key];
      if (typeof handler !== "function") continue;
      const bound: TemplateHandler = (node, parent) => handler.call(visitor, node, parent);
      (table[key] ??= []).push(bound);
    }
  }
  const nodes: Array<[TemplateAstNode, TemplateParentNode | undefined, string]> = [];
  const ends: number[] = [];
  collectTemplateNodes(root, undefined, nodes, ends);
  const open: number[] = [];
  for (let index = 0; index < nodes.length; index++) {
    while (open.length > 0 && ends[open.at(-1)!]! <= index) runExit(open.pop()!);
    const [node, parent, kind] = nodes[index]!;
    const handlers = table[kind];
    if (handlers) for (const handler of handlers) handler(node, parent);
    open.push(index);
  }
  while (open.length > 0) runExit(open.pop()!);

  function runExit(index: number) {
    const [node, parent, kind] = nodes[index]!;
    const handlers = table[`${kind}:exit`];
    if (handlers) for (const handler of handlers) handler(node, parent);
  }
}

function collectTemplateNodes(
  node: TemplateAstNode,
  parent: TemplateParentNode | undefined,
  nodes: Array<[TemplateAstNode, TemplateParentNode | undefined, string]>,
  ends: number[],
) {
  const kind = KIND_BY_TYPE[node.type];
  if (!kind) return;
  const index = nodes.push([node, parent, kind]) - 1;
  if (node.type === TemplateNodeType.ELEMENT) {
    for (const prop of node.props) collectTemplateNodes(prop, node, nodes, ends);
  }
  if (node.type === TemplateNodeType.ROOT || node.type === TemplateNodeType.ELEMENT) {
    for (const child of node.children) collectTemplateNodes(child, node, nodes, ends);
  }
  ends[index] = nodes.length;
}

export function walkTemplate(
  node: TemplateAstNode,
  visit: (node: TemplateAstNode, parent: TemplateParentNode | undefined) => void,
  parent?: TemplateParentNode,
) {
  visit(node, parent);
  if (node.type === TemplateNodeType.ELEMENT) {
    for (const prop of node.props) walkTemplate(prop, visit, node);
  }
  if (node.type === TemplateNodeType.ROOT || node.type === TemplateNodeType.ELEMENT) {
    for (const child of node.children) walkTemplate(child, visit, node);
  }
}

/** The SFC offset just past the element's start tag, `>` or `/>` included. */
export function startTagEnd(element: TemplateElementNode, source: string): number {
  let from = element.loc.start.offset + 1 + element.tag.length;
  for (const prop of element.props) from = Math.max(from, prop.loc.end.offset);
  const close = source.indexOf(">", from);
  return close === -1 || close > element.loc.end.offset ? element.loc.end.offset : close + 1;
}

const parsedExpressions = new WeakMap<TemplateExpressionNode, ScriptAstNode | null>();

/**
 * compiler-sfc parses template expressions with Babel and records how: `ast` is `undefined` for
 * a whole `v-for`, a Program for multi-statement `v-on` handlers, an arrow function at offset 0
 * for `v-slot` and `v-for` aliases, and `false` when the expression is invalid.
 */
export function parseTemplateExpression(expression: TemplateExpressionNode): ScriptAstNode | null {
  const cached = parsedExpressions.get(expression);
  if (cached !== undefined) return cached;
  const parsed = parseExpression(expression);
  parsedExpressions.set(expression, parsed);
  return parsed;
}

function parseExpression(expression: TemplateExpressionNode): ScriptAstNode | null {
  if (expression.isStatic || !expression.content.trim()) return null;
  const babel = (expression as { ast?: unknown }).ast as
    | { type?: string; start?: number }
    | null
    | false
    | undefined;
  if (babel === undefined || babel === false) return null;
  if (babel && (babel.type === "Program" || babel.start === 0)) return null;
  const { content, loc } = expression;
  const index = loc.source.indexOf(content);
  const base = loc.start.offset + Math.max(index, 0) - 1;
  try {
    const result = parseScriptSync("template-expression.ts", `(${content})`, {
      lang: "ts",
      sourceType: "module",
      preserveParens: false,
    });
    if (result.errors.some((error) => error.severity === "Error")) return null;
    const statement = result.program.body[0];
    if (result.program.body.length !== 1 || statement?.type !== "ExpressionStatement") return null;
    const root = statement.expression as unknown as ScriptAstNode;
    shiftAndLink(root as unknown as Record<string, unknown>, undefined, base);
    return root;
  } catch {
    return null;
  }
}

function shiftAndLink(node: Record<string, unknown>, parent: unknown, base: number) {
  if (typeof node.start === "number") node.start += base;
  if (typeof node.end === "number") node.end += base;
  if (parent) {
    Object.defineProperty(node, "__doctorParent", {
      value: parent,
      configurable: true,
      enumerable: false,
    });
  }
  for (const key of getNodeVisitorKeys(node as { type?: string } & Record<string, unknown>)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child === "object" && typeof child.type === "string")
          shiftAndLink(child, node, base);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      shiftAndLink(value as Record<string, unknown>, node, base);
    }
  }
}

export function findTemplateAttribute(
  element: TemplateElementNode,
  name: string,
): TemplateAttributeNode | undefined {
  for (const prop of element.props)
    if (prop.type === TemplateNodeType.ATTRIBUTE && prop.name === name) return prop;
  return undefined;
}

/** A directive by name, and by static argument when `argument` is given. */
export function findTemplateDirective(
  element: TemplateElementNode,
  name: string,
  argument?: string,
): TemplateDirectiveNode | undefined {
  for (const prop of element.props) {
    if (prop.type !== TemplateNodeType.DIRECTIVE || prop.name !== name) continue;
    if (argument === undefined || (prop.arg?.isStatic && prop.arg.content === argument))
      return prop;
  }
  return undefined;
}

const directiveBindings = new WeakMap<TemplateDirectiveNode, string[]>();

/** Names a `v-for` or `v-slot` directive binds for its element and that element's children. */
export function templateDirectiveBindings(directive: TemplateDirectiveNode): string[] {
  const cached = directiveBindings.get(directive);
  if (cached) return cached;
  const params =
    directive.name === "for"
      ? [
          directive.forParseResult?.value,
          directive.forParseResult?.key,
          directive.forParseResult?.index,
        ]
      : directive.name === "slot"
        ? [directive.exp]
        : [];
  const names = new Set<string>();
  for (const param of params) {
    if (!param?.content.trim()) continue;
    try {
      const result = parseScriptSync("template-params.ts", `(${param.content}) => 0`, {
        lang: "ts",
        sourceType: "module",
      });
      const arrow = (result.program.body[0] as any)?.expression;
      for (const pattern of arrow?.params ?? []) collectPatternNames(pattern, names);
    } catch {
      // An invalid alias binds nothing.
    }
  }
  const bindings = [...names];
  directiveBindings.set(directive, bindings);
  return bindings;
}

export interface TemplateExpressionReference {
  id: ScriptAstNode & { type: "Identifier"; name: string };
  /** `w` for a plain assignment target, `rw` for compound assignments and updates. */
  mode: "r" | "w" | "rw";
}

/** Identifiers in a parsed template expression that refer to names declared outside it. */
export function templateExpressionReferences(
  expression: ScriptAstNode,
): TemplateExpressionReference[] {
  const references: TemplateExpressionReference[] = [];
  visitReferences(expression as AnyEstree, [], references);
  return references;
}

type AnyEstree = Record<string, any> & { type: string };

const TS_VALUE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
const TYPE_KEYS = new Set(["typeAnnotation", "typeArguments", "typeParameters", "returnType"]);

function visitReferences(
  node: AnyEstree | null | undefined,
  scopes: Set<string>[],
  references: TemplateExpressionReference[],
  mode: TemplateExpressionReference["mode"] = "r",
) {
  if (!node || typeof node.type !== "string") return;
  switch (node.type) {
    case "Identifier":
      if (!scopes.some((scope) => scope.has(node.name)))
        references.push({ id: node as TemplateExpressionReference["id"], mode });
      return;
    case "MemberExpression":
      visitReferences(node.object, scopes, references);
      if (node.computed) visitReferences(node.property, scopes, references);
      return;
    case "Property":
      if (node.computed) visitReferences(node.key, scopes, references);
      visitReferences(node.value, scopes, references);
      return;
    case "AssignmentExpression":
      visitTarget(node.left, scopes, references, node.operator === "=" ? "w" : "rw");
      visitReferences(node.right, scopes, references);
      return;
    case "UpdateExpression":
      visitTarget(node.argument, scopes, references, "rw");
      return;
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      const scope = new Set<string>();
      if (node.id?.name) scope.add(node.id.name);
      for (const param of node.params ?? []) collectPatternNames(param, scope);
      collectDeclaredNames(node.body, scope);
      const inner = [...scopes, scope];
      for (const param of node.params ?? []) visitPatternDefaults(param, inner, references);
      visitReferences(node.body, inner, references);
      return;
    }
    case "ClassExpression": {
      const inner = node.id?.name ? [...scopes, new Set([node.id.name])] : scopes;
      visitReferences(node.superClass, inner, references);
      visitReferences(node.body, inner, references);
      return;
    }
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node.computed) visitReferences(node.key, scopes, references);
      visitReferences(node.value, scopes, references);
      return;
    case "CatchClause": {
      const scope = new Set<string>();
      if (node.param) collectPatternNames(node.param, scope);
      visitReferences(node.body, [...scopes, scope], references);
      return;
    }
    case "BlockStatement": {
      const scope = new Set<string>();
      for (const statement of node.body ?? []) collectLexicalNames(statement, scope);
      visitReferencesChildren(node, [...scopes, scope], references);
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const scope = new Set<string>();
      collectLexicalNames(node.init ?? node.left, scope);
      visitReferencesChildren(node, [...scopes, scope], references);
      return;
    }
    case "SwitchStatement": {
      visitReferences(node.discriminant, scopes, references);
      const scope = new Set<string>();
      for (const branch of node.cases)
        for (const statement of branch.consequent) collectLexicalNames(statement, scope);
      for (const branch of node.cases) visitReferences(branch, [...scopes, scope], references);
      return;
    }
    case "VariableDeclarator":
      visitPatternDefaults(node.id, scopes, references);
      visitReferences(node.init, scopes, references);
      return;
    case "LabeledStatement":
      visitReferences(node.body, scopes, references);
      return;
    case "BreakStatement":
    case "ContinueStatement":
    case "MetaProperty":
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return;
  }
  if (node.type.startsWith("TS") && !TS_VALUE_WRAPPERS.has(node.type)) return;
  for (const key of getNodeVisitorKeys(node)) {
    if (TYPE_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) visitReferences(child, scopes, references);
    else visitReferences(value, scopes, references);
  }
}

function visitTarget(
  target: AnyEstree | null | undefined,
  scopes: Set<string>[],
  references: TemplateExpressionReference[],
  mode: TemplateExpressionReference["mode"],
) {
  if (!target) return;
  switch (target.type) {
    case "Identifier":
      visitReferences(target, scopes, references, mode);
      return;
    case "ObjectPattern":
      for (const property of target.properties ?? []) {
        if (property.type === "RestElement")
          visitTarget(property.argument, scopes, references, "w");
        else {
          if (property.computed) visitReferences(property.key, scopes, references);
          visitTarget(property.value, scopes, references, "w");
        }
      }
      return;
    case "ArrayPattern":
      for (const element of target.elements ?? []) visitTarget(element, scopes, references, "w");
      return;
    case "RestElement":
      visitTarget(target.argument, scopes, references, "w");
      return;
    case "AssignmentPattern":
      visitTarget(target.left, scopes, references, "w");
      visitReferences(target.right, scopes, references);
      return;
    default:
      visitReferences(target, scopes, references);
  }
}

function visitPatternDefaults(
  pattern: AnyEstree | null | undefined,
  scopes: Set<string>[],
  references: TemplateExpressionReference[],
) {
  if (!pattern) return;
  if (pattern.type === "AssignmentPattern") {
    visitPatternDefaults(pattern.left, scopes, references);
    visitReferences(pattern.right, scopes, references);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      if (property.type === "RestElement") continue;
      if (property.computed) visitReferences(property.key, scopes, references);
      visitPatternDefaults(property.value, scopes, references);
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) visitPatternDefaults(element, scopes, references);
  }
}

function collectPatternNames(pattern: AnyEstree | null | undefined, names: Set<string>) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      names.add(pattern.name);
      return;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, names);
      return;
    case "RestElement":
      collectPatternNames(pattern.argument, names);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties ?? [])
        collectPatternNames(
          property.type === "RestElement" ? property.argument : property.value,
          names,
        );
      return;
    case "ArrayPattern":
      for (const element of pattern.elements ?? []) collectPatternNames(element, names);
      return;
    case "TSParameterProperty":
      collectPatternNames(pattern.parameter, names);
  }
}

function collectLexicalNames(node: AnyEstree | null | undefined, scope: Set<string>) {
  if (node?.type === "VariableDeclaration" && node.kind !== "var")
    for (const declaration of node.declarations ?? []) collectPatternNames(declaration.id, scope);
  if ((node?.type === "FunctionDeclaration" || node?.type === "ClassDeclaration") && node.id?.name)
    scope.add(node.id.name);
}

function collectDeclaredNames(node: AnyEstree | null | undefined, scope: Set<string>) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "VariableDeclaration" && node.kind === "var")
    for (const declaration of node.declarations ?? []) collectPatternNames(declaration.id, scope);
  if (
    [
      "FunctionDeclaration",
      "ClassDeclaration",
      "ArrowFunctionExpression",
      "FunctionExpression",
      "ClassExpression",
    ].includes(node.type)
  )
    return;
  for (const key of getNodeVisitorKeys(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) collectDeclaredNames(child, scope);
    else if (value && typeof value === "object") collectDeclaredNames(value, scope);
  }
}

function visitReferencesChildren(
  node: AnyEstree,
  scopes: Set<string>[],
  references: TemplateExpressionReference[],
) {
  for (const key of getNodeVisitorKeys(node)) {
    if (TYPE_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) visitReferences(child, scopes, references);
    else visitReferences(value, scopes, references);
  }
}
