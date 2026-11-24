import type {
  ComponentFacts,
  ComponentPropFact,
  ComponentRootBranch,
  ComponentUsageFact,
  SourceRange,
  TemplateChildNode,
  TemplateDirectiveNode,
  TemplateElementNode,
  TemplateRootNode,
} from "../primitives.js";

import { analyzeScriptProgram } from "./script-scope.js";
import {
  findTemplateDirective,
  parseTemplateExpression,
  TemplateNodeType,
  templateDirectiveBindings,
  templateRoots,
} from "./template.js";

type AnyNode = any;
type RangeOf = (start: number, end: number) => SourceRange;

const BUILT_IN_COMPONENTS = new Set([
  "component",
  "transition",
  "transitiongroup",
  "keepalive",
  "teleport",
  "suspense",
]);
const DECLARATION_MACROS = new Set([
  "defineProps",
  "defineEmits",
  "defineModel",
  "defineOptions",
  "defineSlots",
  "withDefaults",
]);
const OPTION_KEYS_WITHOUT_LOGIC = new Set(["name", "inheritAttrs"]);
const VUE_ATTRS_READERS = new Set(["useAttrs", "getCurrentInstance"]);
const MEMBER_PATH = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*`;
const COMPARISON = new RegExp(
  String.raw`(?<![\w$.])(${MEMBER_PATH})\s*(?:===|!==|==|!=)\s*(${MEMBER_PATH})(?![\w$(\[])`,
  "g",
);
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

export interface ComponentFactsCollector {
  /** Receives every script AST node of the File Facts walk. */
  visitScript(node: AnyNode): void;
  /** Walks the template once; `visitAttribute` sees each static attribute for other File Facts. */
  finish(
    template: TemplateRootNode | null,
    visitAttribute: (name: string, value: string | undefined, start: number, end: number) => void,
  ): ComponentFacts;
}

/** Collects Component Facts of one SFC from the ASTs Doctor already parsed for it. */
export function createComponentFactsCollector(
  descriptor: AnyNode,
  scriptAst: AnyNode,
  rangeOf: RangeOf,
): ComponentFactsCollector {
  const facts: ComponentFacts = {
    inlineRouteRulesMayDisableSsr: false,
    dynamicRenders: [],
    localComponentLookupKnown: false,
    models: [],
    imports: [],
    ownLogic: false,
    ownMarkup: false,
    rootNodes: 0,
    roots: [],
    inheritAttrs: true,
    readsAttrs: false,
    comparisons: [],
    usages: [],
    bindingReferences: [],
  };
  const references = new Set<string>();
  let importEnd = -1;
  readScriptDeclarations(facts, descriptor, scriptAst, rangeOf);
  return {
    visitScript(node) {
      if (
        node.type === "CallExpression" &&
        node.callee?.name === "defineRouteRules" &&
        inlineRouteRulesMayDisableSsr(node.arguments?.[0])
      )
        facts.inlineRouteRulesMayDisableSsr = true;
      if (node.type === "ImportDeclaration") {
        importEnd = node.end;
        return;
      }
      if (node.type === "Identifier" || node.type === "JSXIdentifier") {
        if (node.start >= importEnd) references.add(node.name);
        return;
      }
      if (node.type === "BinaryExpression" && isEquality(node.operator)) {
        const left = memberPath(node.left);
        const right = memberPath(node.right);
        if (left && right) facts.comparisons.push({ left, right, in: "script" });
      }
    },
    finish(template, visitAttribute) {
      if (template) walkComponentTemplate(facts, template, references, rangeOf, visitAttribute);
      facts.readsAttrs ||= references.has("$attrs") || referencesVueAttrsReader(scriptAst);
      const imported = new Set(facts.imports.map((item) => item.local));
      facts.bindingReferences = [...references].filter((name) => imported.has(name)).sort();
      return facts;
    },
  };
}

function inlineRouteRulesMayDisableSsr(argument: AnyNode): boolean {
  while (
    ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(argument?.type)
  )
    argument = argument.expression;
  if (argument?.type !== "ObjectExpression") return true;
  for (let index = argument.properties.length - 1; index >= 0; index--) {
    const property = argument.properties[index];
    const key = property.key;
    if (!key || (property.computed && key.type !== "Literal")) return true;
    if ((key.name ?? key.value) === "ssr") return property.value?.value !== true;
  }
  return false;
}

function referencesVueAttrsReader(program: AnyNode): boolean {
  const specifiers = new Set(
    (program?.body ?? [])
      .filter(
        (node: AnyNode) =>
          node.type === "ImportDeclaration" &&
          node.importKind !== "type" &&
          node.source.value === "vue",
      )
      .flatMap((node: AnyNode) => node.specifiers)
      .filter(
        (node: AnyNode) =>
          node.type === "ImportSpecifier" &&
          node.importKind !== "type" &&
          VUE_ATTRS_READERS.has(node.imported.name ?? node.imported.value),
      ),
  );
  if (!specifiers.size) return false;
  const { scopes } = analyzeScriptProgram(program, "module");
  return scopes.some((scope) =>
    scope.variables.some(
      (variable) =>
        variable.defs.some((definition) => specifiers.has(definition.node)) &&
        variable.references.some((reference) => reference.isValueReference && reference.isRead()),
    ),
  );
}

function readScriptDeclarations(
  facts: ComponentFacts,
  descriptor: AnyNode,
  program: AnyNode,
  rangeOf: RangeOf,
): void {
  const body: AnyNode[] = program?.body ?? [];
  const setup = blockRange(descriptor?.scriptSetup);
  const types = new Map<string, AnyNode>();
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      declaration?.id?.name &&
      (declaration.type === "TSInterfaceDeclaration" ||
        declaration.type === "TSTypeAliasDeclaration")
    )
      types.set(declaration.id.name, types.has(declaration.id.name) ? undefined : declaration);
  }
  let declaresProps = false;
  let declaresEmits = false;
  let plainScriptCode = false;
  let normalOptions: AnyNode =
    descriptor?.script?.src || (descriptor?.script && !program) ? null : undefined;
  let setupOptions: AnyNode = descriptor?.scriptSetup && !program ? null : undefined;
  for (const statement of body) {
    const inSetup = setup !== undefined && statement.start >= setup[0] && statement.end <= setup[1];
    if (isTypeOnlyStatement(statement)) continue;
    if (statement.type === "ImportDeclaration") {
      if (inSetup && statement.importKind !== "type") readImport(facts, statement);
      continue;
    }
    if (!inSetup) {
      if (statement.type === "ExportDefaultDeclaration")
        normalOptions = componentOptions(statement.declaration);
      if (!isOptionsWithoutLogic(statement)) facts.ownLogic = plainScriptCode = true;
      continue;
    }
    if (isMacroCall(statement, "defineProps")) declaresProps = true;
    if (isMacroCall(statement, "defineEmits")) declaresEmits = true;
    if (
      statement.type === "ExpressionStatement" &&
      isMacroCall(statement, "defineOptions") &&
      statement.expression.arguments?.length
    )
      setupOptions = statement.expression.arguments[0];
    if (!readMacroStatement(facts, statement, types, rangeOf)) facts.ownLogic = true;
  }
  const option = (name: string) => {
    const fromSetup = setupOptions === undefined ? "absent" : readOption(setupOptions, name);
    return fromSetup === "absent" && normalOptions !== undefined
      ? readOption(normalOptions, name)
      : fromSetup;
  };
  const inherit = option("inheritAttrs");
  const components = option("components");
  const registry =
    components === "absent" || components === "unknown"
      ? undefined
      : localComponentRegistry(program, components.value);
  const name = option("name");
  if (
    name !== "absent" &&
    name !== "unknown" &&
    name.value?.type === "Literal" &&
    typeof name.value.value === "string"
  )
    facts.runtimeComponentName = name.value.value;
  const delegated = option("mixins") !== "absent" || option("extends") !== "absent";
  facts.localComponentLookupKnown =
    !delegated &&
    (name === "absent" || facts.runtimeComponentName !== undefined) &&
    (components === "absent" ||
      registry?.properties.every((property: AnyNode) => propertyKey(property) !== undefined) ===
        true);
  if (registry) {
    facts.localComponents = registry.properties
      .map(propertyKey)
      .filter((name: unknown): name is string => typeof name === "string");
  }
  facts.inheritAttrs =
    inherit === "absent"
      ? true
      : inherit !== "unknown" &&
          inherit.value?.type === "Literal" &&
          typeof inherit.value.value === "boolean"
        ? inherit.value.value
        : undefined;
  if (delegated) {
    facts.props = undefined;
    facts.emits = undefined;
  } else {
    if (!declaresProps && !plainScriptCode && option("props") === "absent") facts.props = [];
    if (!declaresEmits && !plainScriptCode && option("emits") === "absent") facts.emits = [];
  }
}

function localComponentRegistry(program: AnyNode, value: AnyNode): AnyNode {
  if (value?.type === "ObjectExpression") return value;
  if (value?.type !== "Identifier") return undefined;
  const { scopes } = analyzeScriptProgram(program, "module");
  for (const scope of scopes) {
    const variable = scope.references.find((reference) => reference.identifier === value)?.resolved;
    if (!variable || variable.defs.length !== 1) continue;
    const definition = variable.defs[0];
    if (
      definition?.type === "Variable" &&
      definition.parent.kind === "const" &&
      definition.node.id.type === "Identifier" &&
      definition.node.init?.type === "ObjectExpression" &&
      variable.references.every(
        (reference) => reference.init === true || reference.identifier === value,
      )
    )
      return definition.node.init;
  }
  return undefined;
}

function componentOptions(declaration: AnyNode): AnyNode {
  return declaration?.type === "CallExpression" && declaration.callee?.name === "defineComponent"
    ? declaration.arguments?.[0]
    : declaration;
}

function readOption(options: AnyNode, name: string): "absent" | "unknown" | { value: AnyNode } {
  if (options?.type !== "ObjectExpression") return "unknown";
  for (let index = options.properties.length - 1; index >= 0; index--) {
    const property = options.properties[index];
    if (property.type === "SpreadElement") {
      const spread = readOption(property.argument, name);
      if (spread !== "absent") return spread;
      continue;
    }
    const key =
      property.computed && property.key?.type === "Literal"
        ? String(property.key.value)
        : propertyKey(property);
    if (key === name) return { value: property.value };
    if (property.computed && key === undefined) return "unknown";
  }
  return "absent";
}

function isMacroCall(statement: AnyNode, name: string): boolean {
  const call = statement.type === "ExpressionStatement" ? statement.expression : undefined;
  if (statement.type === "VariableDeclaration")
    return (statement.declarations ?? []).some((declarator: AnyNode) =>
      isMacroInitializer(declarator.init, name),
    );
  return isMacroInitializer(call, name);
}

function isMacroInitializer(initializer: AnyNode, name: string): boolean {
  let call = initializer;
  if (call?.callee?.name === "withDefaults") call = call.arguments?.[0];
  return call?.type === "CallExpression" && call.callee?.name === name;
}

function blockRange(block: AnyNode): [number, number] | undefined {
  const start = block?.loc?.start?.offset;
  const end = block?.loc?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? [start, end] : undefined;
}

function isTypeOnlyStatement(statement: AnyNode): boolean {
  const declaration =
    statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
  if (statement.type === "ExportNamedDeclaration" && !declaration)
    return statement.exportKind === "type";
  return (
    declaration?.type === "TSInterfaceDeclaration" ||
    declaration?.type === "TSTypeAliasDeclaration" ||
    (declaration?.type === "TSModuleDeclaration" && declaration.declare === true)
  );
}

function isOptionsWithoutLogic(statement: AnyNode): boolean {
  if (statement.type !== "ExportDefaultDeclaration") return false;
  const options = componentOptions(statement.declaration);
  return (
    options?.type === "ObjectExpression" &&
    (options.properties ?? []).every(
      (property: AnyNode) =>
        property.type === "Property" &&
        !property.computed &&
        OPTION_KEYS_WITHOUT_LOGIC.has(property.key?.name) &&
        property.value?.type === "Literal",
    )
  );
}

function readImport(facts: ComponentFacts, statement: AnyNode): void {
  const source = String(statement.source?.value ?? "");
  for (const specifier of statement.specifiers ?? []) {
    if (specifier.importKind === "type" || !specifier.local?.name) continue;
    const imported =
      specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : specifier.type === "ImportNamespaceSpecifier"
          ? "*"
          : String(specifier.imported?.name ?? specifier.imported?.value ?? "default");
    facts.imports.push({ local: specifier.local.name, imported, source });
  }
}

/** Reads a top-level macro statement; `false` when the statement is code of the component's own. */
function readMacroStatement(
  facts: ComponentFacts,
  statement: AnyNode,
  types: Map<string, AnyNode>,
  rangeOf: RangeOf,
): boolean {
  if (statement.type === "ExpressionStatement")
    return readMacroCall(facts, statement.expression, undefined, types, rangeOf);
  if (statement.type !== "VariableDeclaration" || !statement.declarations?.length) return false;
  let recognized = false;
  let allRecognized = true;
  for (const declarator of statement.declarations) {
    const handled = readMacroCall(facts, declarator.init, declarator.id, types, rangeOf);
    recognized ||= handled;
    allRecognized &&= handled;
  }
  return recognized && allRecognized;
}

function readMacroCall(
  facts: ComponentFacts,
  call: AnyNode,
  id: AnyNode,
  types: Map<string, AnyNode>,
  rangeOf: RangeOf,
): boolean {
  if (call?.type !== "CallExpression" || call.callee?.type !== "Identifier") return false;
  const name = call.callee.name as string;
  if (!DECLARATION_MACROS.has(name)) return false;
  if (name === "withDefaults") {
    const inner = call.arguments?.[0];
    if (inner?.callee?.name !== "defineProps") return false;
    readProps(facts, inner, id, types, rangeOf);
    const defaults = call.arguments?.[1];
    const defaulted = new Set<string>();
    if (defaults?.type === "ObjectExpression")
      for (const property of defaults.properties ?? []) {
        const key = propertyKey(property);
        if (key) defaulted.add(camelize(key));
      }
    else if (defaults) facts.props = undefined;
    for (const prop of facts.props ?? []) if (defaulted.has(prop.name)) prop.default = true;
    return true;
  }
  if (name === "defineProps") {
    readProps(facts, call, id, types, rangeOf);
    return true;
  }
  if (name === "defineEmits") {
    if (id?.type === "Identifier") facts.emitBinding = id.name;
    else if (id) return false;
    facts.emits = readEmits(call, types);
    return true;
  }
  if (name === "defineModel") {
    const first = call.arguments?.[0];
    const modelName =
      first?.type === "Literal" && typeof first.value === "string" ? first.value : "modelValue";
    const options = first?.type === "ObjectExpression" ? first : call.arguments?.[1];
    facts.models.push({
      name: modelName,
      binding: id?.type === "Identifier" ? id.name : undefined,
      default: hasProperty(options, "default"),
      range: rangeOf(call.start, call.end),
    });
    return true;
  }
  return true;
}

function readProps(
  facts: ComponentFacts,
  call: AnyNode,
  id: AnyNode,
  types: Map<string, AnyNode>,
  rangeOf: RangeOf,
): void {
  const typeArgument = (call.typeArguments ?? call.typeParameters)?.params?.[0];
  const props = typeArgument
    ? propsFromType(typeArgument, types, rangeOf)
    : propsFromRuntime(call.arguments?.[0], rangeOf);
  facts.props = props;
  if (id?.type === "Identifier") {
    facts.propsBinding = id.name;
    return;
  }
  if (id?.type !== "ObjectPattern") return;
  const aliases: Record<string, string> = {};
  for (const property of id.properties ?? []) {
    if (property.type === "RestElement") {
      if (property.argument?.name) facts.propsBinding = property.argument.name;
      continue;
    }
    const key = propertyKey(property);
    if (!key) {
      facts.props = undefined;
      continue;
    }
    const value =
      property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
    if (value?.type === "Identifier") aliases[value.name] = camelize(key);
    if (property.value?.type === "AssignmentPattern") {
      const prop = facts.props?.find((item) => item.name === camelize(key));
      if (prop) prop.default = true;
    }
  }
  facts.propAliases = aliases;
}

function propsFromRuntime(argument: AnyNode, rangeOf: RangeOf): ComponentPropFact[] | undefined {
  if (!argument) return [];
  if (argument.type === "ArrayExpression") {
    const props: ComponentPropFact[] = [];
    for (const element of argument.elements ?? []) {
      if (element?.type !== "Literal" || typeof element.value !== "string") return undefined;
      props.push({
        name: camelize(element.value),
        default: false,
        range: rangeOf(element.start, element.end),
      });
    }
    return props;
  }
  if (argument.type !== "ObjectExpression") return undefined;
  const props: ComponentPropFact[] = [];
  for (const property of argument.properties ?? []) {
    const key = propertyKey(property);
    if (!key) return undefined;
    props.push({
      name: camelize(key),
      default: hasProperty(property.value, "default"),
      range: rangeOf(property.start, property.end),
    });
  }
  return props;
}

function propsFromType(
  type: AnyNode,
  types: Map<string, AnyNode>,
  rangeOf: RangeOf,
  seen = new Set<string>(),
): ComponentPropFact[] | undefined {
  const members = typeMembers(type, types, seen);
  if (!members) return undefined;
  const props: ComponentPropFact[] = [];
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature")
      return undefined;
    const key = !member.computed ? propertyKey(member) : undefined;
    if (!key) return undefined;
    props.push({ name: camelize(key), default: false, range: rangeOf(member.start, member.end) });
  }
  return props;
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
  if (
    type?.type !== "TSTypeReference" ||
    type.typeName?.type !== "Identifier" ||
    type.typeArguments
  )
    return undefined;
  const name = type.typeName.name as string;
  const declaration = types.get(name);
  if (!declaration || seen.has(name)) return undefined;
  seen.add(name);
  if (declaration.type === "TSTypeAliasDeclaration")
    return declaration.typeParameters
      ? undefined
      : typeMembers(declaration.typeAnnotation, types, seen);
  if (declaration.typeParameters) return undefined;
  const members: AnyNode[] = [...(declaration.body?.body ?? [])];
  for (const heritage of declaration.extends ?? []) {
    const parentMembers = typeMembers(
      {
        type: "TSTypeReference",
        typeName: heritage.expression,
        typeArguments: heritage.typeArguments,
      },
      types,
      seen,
    );
    if (!parentMembers) return undefined;
    members.push(...parentMembers);
  }
  return members;
}

function readEmits(call: AnyNode, types: Map<string, AnyNode>): string[] | undefined {
  const typeArgument = (call.typeArguments ?? call.typeParameters)?.params?.[0];
  if (typeArgument) {
    const members = typeMembers(typeArgument, types, new Set());
    if (!members) return undefined;
    const events: string[] = [];
    for (const member of members) {
      if (member.type === "TSPropertySignature") {
        const key = !member.computed ? propertyKey(member) : undefined;
        if (!key) return undefined;
        events.push(key);
        continue;
      }
      if (member.type !== "TSCallSignatureDeclaration") return undefined;
      const literals = literalStrings(member.params?.[0]?.typeAnnotation?.typeAnnotation);
      if (!literals) return undefined;
      events.push(...literals);
    }
    return events;
  }
  const argument = call.arguments?.[0];
  if (!argument) return [];
  if (argument.type === "ArrayExpression") {
    const events: string[] = [];
    for (const element of argument.elements ?? []) {
      if (element?.type !== "Literal" || typeof element.value !== "string") return undefined;
      events.push(element.value);
    }
    return events;
  }
  if (argument.type !== "ObjectExpression") return undefined;
  const events: string[] = [];
  for (const property of argument.properties ?? []) {
    const key = propertyKey(property);
    if (!key) return undefined;
    events.push(key);
  }
  return events;
}

function literalStrings(type: AnyNode): string[] | undefined {
  if (type?.type === "TSLiteralType" && typeof type.literal?.value === "string")
    return [type.literal.value];
  if (type?.type !== "TSUnionType") return undefined;
  const values: string[] = [];
  for (const part of type.types ?? []) {
    const literal = literalStrings(part);
    if (!literal) return undefined;
    values.push(...literal);
  }
  return values;
}

function propertyKey(property: AnyNode): string | undefined {
  if (
    !property ||
    property.computed ||
    (property.type !== "Property" && !property.type?.startsWith("TS"))
  )
    return undefined;
  const key = property.key;
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function hasProperty(node: AnyNode, name: string): boolean {
  return (
    node?.type === "ObjectExpression" &&
    (node.properties ?? []).some((property: AnyNode) => propertyKey(property) === name)
  );
}

function isEquality(operator: string): boolean {
  return operator === "===" || operator === "==" || operator === "!==" || operator === "!=";
}

function memberPath(node: AnyNode): string | undefined {
  if (node?.type === "ChainExpression") return memberPath(node.expression);
  if (node?.type === "Identifier") return node.name;
  if (node?.type !== "MemberExpression" || node.computed || node.property?.type !== "Identifier")
    return undefined;
  const object = memberPath(node.object);
  return object && `${object}.${node.property.name}`;
}

interface TemplateWalk {
  facts: ComponentFacts;
  references: Set<string>;
  rangeOf: RangeOf;
  visitAttribute: (name: string, value: string | undefined, start: number, end: number) => void;
}

function walkComponentTemplate(
  facts: ComponentFacts,
  root: TemplateRootNode,
  references: Set<string>,
  rangeOf: RangeOf,
  visitAttribute: TemplateWalk["visitAttribute"],
): void {
  const walk: TemplateWalk = { facts, references, rangeOf, visitAttribute };
  for (const node of templateRoots(root)) {
    if (node.type === "comment") continue;
    const branches =
      node.type === "text"
        ? [{ kind: "text" as const, range: locRange(rangeOf, node.node) }]
        : node.branches.map((branch) => rootBranch(branch, rangeOf));
    facts.roots.push({ branches });
  }
  facts.rootNodes = facts.roots.length;
  for (const child of root.children) walkChild(walk, child, [], false, undefined, []);
}

function rootBranch(element: TemplateElementNode, rangeOf: RangeOf): ComponentRootBranch {
  const range = locRange(rangeOf, element);
  if (findTemplateDirective(element, "for")) return { kind: "fragment", range };
  if (element.tagType === 0) return { kind: "element", tag: element.tag, range };
  if (element.tagType === 1) return { kind: "component", tag: element.tag, range };
  return { kind: element.tagType === 2 ? "slot" : "fragment", range };
}

function locRange(rangeOf: RangeOf, node: TemplateChildNode): SourceRange {
  return rangeOf(node.loc.start.offset, node.loc.end.offset);
}

function walkChild(
  walk: TemplateWalk,
  node: TemplateChildNode,
  scope: string[],
  inFor: boolean,
  parent: ComponentUsageFact["parent"],
  wrappers: ComponentUsageFact["wrappers"],
): void {
  if (node.type === TemplateNodeType.TEXT) {
    if (node.content.trim()) walk.facts.ownMarkup = true;
    return;
  }
  if (node.type === TemplateNodeType.INTERPOLATION) {
    walk.facts.ownMarkup = true;
    readExpression(walk, node.content.content);
    return;
  }
  if (node.type !== TemplateNodeType.ELEMENT) return;
  walkElement(walk, node, scope, inFor, parent, wrappers);
}

function walkElement(
  walk: TemplateWalk,
  element: TemplateElementNode,
  scope: string[],
  inFor: boolean,
  parent: ComponentUsageFact["parent"],
  wrappers: ComponentUsageFact["wrappers"],
): void {
  let elementScope = scope;
  let childScope = scope;
  let elementInFor = inFor;
  for (const prop of element.props) {
    if (prop.type !== TemplateNodeType.DIRECTIVE) continue;
    if (prop.name === "for" && prop.forParseResult) {
      const aliases = templateDirectiveBindings(prop);

      elementScope = [...scope, ...aliases];
      childScope = elementScope;
      elementInFor = true;
    }
  }
  for (const prop of element.props) {
    if (prop.type === TemplateNodeType.DIRECTIVE && prop.name === "slot" && prop.exp)
      childScope = [...childScope, ...identifiers(prop.exp.content)];
  }
  const kind = elementKind(element);
  if (kind === "markup") walk.facts.ownMarkup = true;
  const dynamicIs =
    element.tagType === 1 && (element.tag === "component" || element.tag === "Component")
      ? element.props.find((prop) =>
          prop.type === TemplateNodeType.ATTRIBUTE
            ? prop.name === "is"
            : prop.name === "bind" && prop.arg?.isStatic && prop.arg.content === "is",
        )
      : undefined;
  let dynamicLiteral = false;
  let dynamicImport: string | undefined;
  if (dynamicIs?.type === TemplateNodeType.ATTRIBUTE) {
    if (dynamicIs.value)
      walk.facts.dynamicRenders.push({ wrappers, name: dynamicIs.value.content });
  } else if (dynamicIs) {
    const target = dynamicIs.exp && parseTemplateExpression(dynamicIs.exp);
    const identifier =
      target?.type === "Identifier" ? target.name : !dynamicIs.exp ? "is" : undefined;
    const binding = identifier && !elementScope.includes(identifier) ? identifier : undefined;
    const name =
      target?.type === "Literal" && typeof target.value === "string" ? target.value : undefined;
    dynamicLiteral = name !== undefined;
    if (walk.facts.imports.some((item) => item.local === binding)) dynamicImport = binding;
    walk.facts.dynamicRenders.push({ wrappers, binding, name });
  }
  const usage =
    kind === "component"
      ? createUsage(walk, element, elementScope, elementInFor, parent, wrappers)
      : undefined;
  for (const prop of element.props) {
    if (prop.type === TemplateNodeType.ATTRIBUTE) {
      walk.visitAttribute(
        prop.name,
        prop.value?.content,
        prop.loc.start.offset,
        prop.loc.end.offset,
      );
      usage?.attributes.push({
        name: prop.name,
        value: prop.value?.content,
        range: walk.rangeOf(prop.loc.start.offset, prop.loc.end.offset),
      });
      continue;
    }
    if (
      prop.exp &&
      prop.name !== "for" &&
      prop.name !== "slot" &&
      (prop !== dynamicIs || !dynamicLiteral)
    )
      readExpression(walk, prop.exp.content, prop === dynamicIs ? dynamicImport : undefined);
    if (prop.name === "for" && prop.forParseResult)
      readExpression(walk, prop.forParseResult.source.content);
    if (prop.arg && !prop.arg.isStatic) readExpression(walk, prop.arg.content);
    if (
      kind === "template" &&
      (prop.name === "if" || prop.name === "else-if" || prop.name === "else" || prop.name === "for")
    )
      walk.facts.ownMarkup = true;
    if (usage) readUsageDirective(walk, usage, prop);
  }
  if (usage) walk.facts.usages.push(usage);
  const childParent =
    element.tagType === 3
      ? parent
      : {
          tag: element.tag,
          element: element.tagType === 0,
          ...(element.ns !== 0 && { foreign: true as const }),
        };
  const slot = findTemplateDirective(element, "slot");
  const defaultSlot = !slot?.arg || (slot.arg.isStatic && slot.arg.content === "default");
  let childWrappers = wrappers;
  if (element.tagType === 1 || element.tagType === 2) {
    childWrappers = [
      ...wrappers,
      {
        tag: element.tag,
        defaultSlot,
        shadowed: tagCandidates(element.tag).some((tag) => elementScope.includes(tag)),
      },
    ];
  } else if (element.tagType === 3 && slot && !defaultSlot && !parent?.element) {
    const wrapper = wrappers.at(-1);
    if (wrapper && wrapper.tag === parent?.tag)
      childWrappers = [...wrappers.slice(0, -1), { ...wrapper, defaultSlot: false }];
  }
  for (const child of element.children)
    walkChild(walk, child, childScope, elementInFor, childParent, childWrappers);
}

function elementKind(element: TemplateElementNode): "component" | "markup" | "slot" | "template" {
  if (element.tagType === 2) return "slot";
  if (element.tagType === 3) return "template";
  if (element.tagType !== 1) return "markup";
  return BUILT_IN_COMPONENTS.has(element.tag.replaceAll("-", "").toLowerCase())
    ? "markup"
    : "component";
}

function createUsage(
  walk: TemplateWalk,
  element: TemplateElementNode,
  scope: string[],
  inFor: boolean,
  parent: ComponentUsageFact["parent"],
  wrappers: ComponentUsageFact["wrappers"],
): ComponentUsageFact {
  const start = element.loc.start.offset + 1;
  return {
    ...(parent && { parent }),
    tag: element.tag,
    range: walk.rangeOf(start, start + element.tag.length),
    attributes: [],
    bindings: [],
    spreads: [],
    listeners: [],
    directives: [],
    wrappers,
    scope,
    inFor,
  };
}

function readUsageDirective(
  walk: TemplateWalk,
  usage: ComponentUsageFact,
  prop: TemplateDirectiveNode,
): void {
  const range = walk.rangeOf(prop.loc.start.offset, prop.loc.end.offset);
  const expression = prop.exp?.content.trim() ?? "";
  const argument = prop.arg?.isStatic ? prop.arg.content : undefined;
  if (prop.name === "bind" || prop.name === "on") {
    if (prop.arg && argument === undefined) {
      usage.spreads.push({ directive: prop.name, expression: `[${prop.arg.content}]`, range });
      return;
    }
    if (argument === undefined) {
      usage.spreads.push({ directive: prop.name, expression, range });
      return;
    }
    const modifiers = prop.modifiers.map((modifier) => modifier.content);
    if (prop.name === "bind") {
      let vnodeKey = modifiers.includes("camel") ? camelize(argument) : argument;
      if (modifiers.includes("prop")) vnodeKey = `.${vnodeKey}`;
      if (modifiers.includes("attr")) vnodeKey = `^${vnodeKey}`;
      usage.bindings.push({ name: argument, vnodeKey, expression: expression || argument, range });
      return;
    }
    usage.listeners.push({
      event: argument,
      modifiers,
      vnodeKey: listenerKey(argument, modifiers),
      expression: expression || undefined,
      range,
    });
    return;
  }
  if (prop.name === "model") {
    if (prop.arg && argument === undefined) {
      usage.spreads.push({ directive: "bind", expression: `[${prop.arg.content}]`, range });
      return;
    }
    usage.bindings.push({
      name: argument ?? "modelValue",
      vnodeKey: argument ?? "modelValue",
      expression,
      model: true,
      modifiers: prop.modifiers.length > 0,
      range,
    });
    return;
  }
  usage.directives.push(prop.name);
}

function listenerKey(event: string, modifiers: string[]): string {
  const name = event.startsWith("vue:") ? `vnode-${event.slice(4)}` : event;
  let key = name ? `on${capitalize(camelize(name))}` : "";
  if (key.toLowerCase() === "onclick") {
    if (modifiers.includes("right")) key = "onContextmenu";
    else if (modifiers.includes("middle")) key = "onMouseup";
  }
  return (
    key +
    modifiers
      .filter((modifier) => ["once", "capture", "passive"].includes(modifier))
      .map(capitalize)
      .join("")
  );
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function readExpression(
  walk: TemplateWalk,
  content: string | undefined,
  trackedImport?: string,
): void {
  if (!content) return;
  for (const name of content.match(IDENTIFIER) ?? []) {
    if (name === "$attrs") walk.facts.readsAttrs = true;
    if (name !== trackedImport) walk.references.add(name);
  }
  if (!content.includes("==") && !content.includes("!=")) return;
  for (const match of content.matchAll(COMPARISON))
    walk.facts.comparisons.push({
      left: match[1]!.replaceAll("?.", "."),
      right: match[2]!.replaceAll("?.", "."),
      in: "template",
    });
}

function identifiers(content: string | undefined): string[] {
  if (!content) return [];
  return [...new Set(content.match(IDENTIFIER) ?? [])];
}

/** Vue's prop name normalization: `active-id` and `activeId` name the same prop. */
export function camelize(name: string): string {
  return name.replace(/-(\w)/g, (_, char: string) => char.toUpperCase());
}

export function pascalCase(tag: string): string {
  const camel = camelize(tag);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** Names a `<script setup>` binding can have to render as `tag`. */
export function tagCandidates(tag: string): string[] {
  return [tag, camelize(tag), pascalCase(tag)];
}
