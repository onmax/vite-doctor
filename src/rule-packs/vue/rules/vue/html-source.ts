import { dirname, isAbsolute, join, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import {
  analyzeScript,
  scopeDialect,
  type ScopeVariable,
} from "../../../../core/internal/script-scope.js";
import type { AnyNode } from "./shared.js";
import {
  indexedScript,
  indexScriptScope,
  memberName,
  propertyName,
  unwrapTs,
  vueApiCall,
  type IndexedScript,
} from "./vue-api.js";

/**
 * Where the HTML bound to a `v-html` comes from. `via` names a renderer, such as a Markdown
 * parser, that keeps raw HTML from its input.
 */
export type HtmlSource =
  | { trust: "trusted" }
  | { trust: "untrusted"; source: string; via?: string }
  | { trust: "unknown"; source: string; via?: string };

/** A template-local name: a `v-for` alias traced through its list, or a slot prop (`list: null`). */
export interface TemplateLocal {
  list: AnyNode;
  locals: TemplateLocals;
}
export type TemplateLocals = ReadonlyMap<string, TemplateLocal>;

interface Unit {
  file: string;
  script: IndexedScript;
}

interface Where {
  unit: Unit | null;
  params?: ReadonlyMap<ScopeVariable, () => HtmlSource>;
  /** Set while tracing a template expression, whose names resolve by name, not by scope. */
  template?: TemplateLocals;
}

type Effect = "trusted" | "untrusted" | "markdown";

const TRUSTED: HtmlSource = { trust: "trusted" };
const untrusted = (source: string): HtmlSource => ({ trust: "untrusted", source });
const unknown = (source: string): HtmlSource => ({ trust: "unknown", source });

const RANK = { trusted: 0, unknown: 1, untrusted: 2 } as const;
function worst(left: HtmlSource, right: HtmlSource): HtmlSource {
  return RANK[right.trust] > RANK[left.trust] ? right : left;
}

/** Calls whose result a visitor, a request, or the browser's storage controls. */
const UNTRUSTED_CALLS = new Set([
  "useRoute",
  "useRequestURL",
  "useRequestHeaders",
  "useRequestHeader",
  "useRequestEvent",
  "useCookie",
  "useFetch",
  "useLazyFetch",
  "$fetch",
  "fetch",
  "useLocalStorage",
  "useSessionStorage",
  "useStorage",
  "useUrlSearchParams",
  "useRouteQuery",
  "useRouteParams",
  "useRouteHash",
  "useCookies",
]);
const ASYNC_DATA = new Set(["useAsyncData", "useLazyAsyncData"]);

/**
 * Imported functions whose output is safe HTML (an escaping highlighter, a QR code drawn from
 * shapes, a sanitizer) or a Markdown renderer, which passes raw HTML in its input through.
 */
const PACKAGE_CALLS: Array<{ source: RegExp; name: string; effect: Effect; label?: string }> = [
  { source: /^(?:shiki|@shikijs\/)/, name: "codeToHtml", effect: "trusted" },
  { source: /^uqr$/, name: "renderSVG", effect: "trusted" },
  { source: /^(?:isomorphic-)?dompurify$/, name: "sanitize", effect: "trusted" },
  { source: /^sanitize-html$/, name: "default", effect: "trusted" },
  { source: /^xss$/, name: "default", effect: "trusted" },
  { source: /^xss$/, name: "filterXSS", effect: "trusted" },
  { source: /^escape-html$/, name: "default", effect: "trusted" },
  { source: /^marked$/, name: "marked", effect: "markdown", label: "marked" },
  { source: /^marked$/, name: "parse", effect: "markdown", label: "marked" },
  { source: /^marked$/, name: "parseInline", effect: "markdown", label: "marked" },
];
const DOMPURIFY = /^(?:isomorphic-)?dompurify$/;
const MARKED_METHODS = new Set(["parse", "parseInline"]);
const MARKDOWN_IT_METHODS = new Set(["render", "renderInline"]);

const STRING_METHODS = new Set([
  "at",
  "charAt",
  "concat",
  "join",
  "match",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "slice",
  "split",
  "substr",
  "substring",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
  "valueOf",
]);
/** String and array methods whose result can hold their arguments, not only the receiver. */
const ARGUMENT_METHODS = new Set(["concat", "join", "padEnd", "padStart", "replace", "replaceAll"]);
const ARRAY_PASSTHROUGH = new Set([
  "filter",
  "find",
  "findLast",
  "flat",
  "reverse",
  "slice",
  "sort",
  "toReversed",
  "toSorted",
]);
const ARRAY_CALLBACKS = new Set([
  "every",
  "filter",
  "find",
  "findLast",
  "flatMap",
  "forEach",
  "map",
  "some",
]);
const PASS_GLOBALS = new Set(["String", "decodeURI", "decodeURIComponent", "unescape"]);
const SAFE_GLOBALS = new Set([
  "Boolean",
  "Number",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "parseFloat",
  "parseInt",
]);
const REF_CALLS = new Set(["ref", "shallowRef", "computed"]);
const REACTIVE_CALLS = new Set([
  "reactive",
  "readonly",
  "shallowReactive",
  "shallowReadonly",
  "toRefs",
]);
const UNWRAP_CALLS = new Set(["unref", "toValue", "toRaw"]);
const WATCH = new Set(["watch"]);
const FORM_TARGETS = new Set(["target", "currentTarget"]);
const WINDOW_SOURCES = new Set(["localStorage", "sessionStorage", "location", "name"]);
const DOCUMENT_SOURCES = new Set([
  "cookie",
  "referrer",
  "URL",
  "documentURI",
  "baseURI",
  "location",
]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
const SCRIPT_EXTENSIONS = [".ts", ".js", ".mts", ".mjs", ".tsx", ".jsx"];
const MAX_STEPS = 4000;

/**
 * Traces a `v-html` value through the SFC's template and script, and into the local modules and
 * Nuxt auto-imports its functions come from, to the source of its HTML.
 */
export class HtmlSourceTracer {
  private readonly sfc: Unit | null;
  private readonly units = new Map<string, Unit | null>();
  private readonly active = new Set<unknown>();
  private readonly props: ReadonlySet<string>;
  private steps = 0;

  constructor(
    private readonly ctx: RuleContext,
    /** Names a `v-model` in the template writes, so the person using the page controls them. */
    private readonly modelTargets: ReadonlySet<string>,
  ) {
    const script = indexedScript(ctx);
    this.sfc = script ? { file: ctx.file.path, script } : null;
    this.props = script ? declaredProps(script) : new Set();
  }

  templateExpression(node: AnyNode, locals: TemplateLocals): HtmlSource {
    this.steps = 0;
    return this.classify(node, [], { unit: this.sfc, template: locals });
  }

  private classify(node: AnyNode, path: string[], where: Where): HtmlSource {
    if (++this.steps > MAX_STEPS) return unknown("a value Doctor stopped tracing after many steps");
    node = unwrap(node);
    if (!node) return TRUSTED;
    switch (node.type) {
      case "Literal":
      case "UnaryExpression":
      case "UpdateExpression":
        return TRUSTED;
      case "TemplateLiteral":
        return this.all(node.expressions, [], where);
      case "Identifier":
        return this.identifier(node, path, where);
      case "MemberExpression":
        return this.member(node, path, where);
      case "CallExpression":
        return this.call(node, path, where);
      case "NewExpression":
        return this.construct(node, where);
      case "AwaitExpression":
        return this.classify(node.argument, path, where);
      case "ConditionalExpression":
        return worst(
          this.classify(node.consequent, path, where),
          this.classify(node.alternate, path, where),
        );
      case "LogicalExpression":
        return worst(this.classify(node.left, path, where), this.classify(node.right, path, where));
      case "BinaryExpression":
        return node.operator === "+" ? this.all([node.left, node.right], [], where) : TRUSTED;
      case "AssignmentExpression":
        return this.classify(node.right, path, where);
      case "SequenceExpression":
        return this.classify(node.expressions.at(-1), path, where);
      case "ObjectExpression":
        return this.object(node, path, where);
      case "ArrayExpression":
        return this.all(
          node.elements.map((element: AnyNode) =>
            element?.type === "SpreadElement" ? element.argument : element,
          ),
          [],
          where,
        );
      case "ThisExpression":
        return unknown("`this`");
      default:
        return unknown(`\`${this.text(node, where)}\``);
    }
  }

  private all(nodes: AnyNode[], path: string[], where: Where): HtmlSource {
    let result = TRUSTED;
    for (const node of nodes) {
      result = worst(result, this.classify(node, path, where));
      if (result.trust === "untrusted") break;
    }
    return result;
  }

  private object(node: AnyNode, path: string[], where: Where): HtmlSource {
    const [key, ...rest] = path;
    const values: AnyNode[] = [];
    for (const property of node.properties) {
      if (property.type === "SpreadElement") values.push(property.argument);
      else if (key === undefined || key === "*" || propertyName(property.key) === key)
        values.push(property.value);
      else if (property.computed) values.push(property.value);
    }
    return this.all(values, key === undefined ? [] : rest, where);
  }

  private identifier(node: AnyNode, path: string[], where: Where): HtmlSource {
    const name: string = node.name;
    if (name === "undefined") return TRUSTED;
    if (where.template) {
      const local = where.template.get(name);
      if (local)
        return local.list
          ? this.classify(local.list, [], { unit: this.sfc, template: local.locals })
          : unknown(`the slot prop \`${name}\``);
      if (name === "$route") return untrusted("`$route`");
      if (name === "$props" || name === "$attrs")
        return unknown(path[0] ? `the prop \`${path[0]}\`` : `\`${name}\``);
      const variable = this.sfc && moduleVariable(this.sfc, name);
      if (variable) return this.variable(variable, path, { unit: this.sfc });
      if (this.props.has(name)) return unknown(`the prop \`${name}\``);
      return this.global(name, path);
    }
    const variable = where.unit?.script.references.get(node)?.resolved;
    return variable ? this.variable(variable, path, where) : this.global(name, path);
  }

  private member(node: AnyNode, path: string[], where: Where): HtmlSource {
    const object = unwrap(node.object);
    if (memberName(node) === "value" && FORM_TARGETS.has(memberName(object) ?? ""))
      return untrusted(`a form field's value (\`${this.text(node, where)}\`)`);
    return this.classify(object, [memberKey(node), ...path], where);
  }

  private global(name: string, path: string[]): HtmlSource {
    if (name === "localStorage" || name === "sessionStorage" || name === "location")
      return untrusted(`\`${name}\``);
    if (name === "window" || name === "globalThis" || name === "self") {
      if (WINDOW_SOURCES.has(path[0] ?? "")) return untrusted(`\`window.${path[0]}\``);
      if (path[0] === "document") return this.global("document", path.slice(1));
    }
    if (name === "document" && DOCUMENT_SOURCES.has(path[0] ?? ""))
      return untrusted(`\`document.${path[0]}\``);
    return unknown(`\`${name}\`, which this component's script does not declare`);
  }

  private variable(variable: ScopeVariable, path: string[], where: Where): HtmlSource {
    if (where.params?.has(variable)) return where.params.get(variable)!();
    if (this.modelTargets.has(variable.name) && where.unit === this.sfc && isModuleLevel(variable))
      return untrusted(`a \`v-model\` input in this template (\`${variable.name}\`)`);
    if (this.active.has(variable)) return TRUSTED;
    this.active.add(variable);
    try {
      const definition = variable.defs[0] as AnyNode;
      switch (definition?.type) {
        case "ImportBinding":
          return this.importedValue(definition, path, where.unit!);
        case "Parameter":
          return this.parameter(variable, definition.node, where);
        case "Variable":
          return this.declared(variable, definition.node, path, where);
        default:
          return unknown(`\`${variable.name}\``);
      }
    } finally {
      this.active.delete(variable);
    }
  }

  private declared(
    variable: ScopeVariable,
    declarator: AnyNode,
    path: string[],
    where: Where,
  ): HtmlSource {
    const init = unwrap(declarator.init);
    if (isDefineProps(init))
      return declarator.id.type === "Identifier"
        ? unknown(path[0] ? `the prop \`${path[0]}\`` : "the component's props")
        : unknown(`the prop \`${variable.name}\``);
    const script = where.unit!.script;
    const container =
      init?.type === "CallExpression" ? vueApiCall(script, init.callee, REF_CALLS) : undefined;
    const inner = container && path[0] === "value" ? path.slice(1) : path;
    let result: HtmlSource;
    if (container === "computed") {
      const getter = unwrap(init.arguments[0]);
      const get =
        getter?.type === "ObjectExpression"
          ? getter.properties.find((property: AnyNode) => propertyName(property.key) === "get")
              ?.value
          : getter;
      result = get ? this.returns(get, inner, where) : unknown("a computed() without a getter");
    } else if (container) {
      result = init.arguments[0] ? this.classify(init.arguments[0], inner, where) : TRUSTED;
    } else if (init) {
      result = this.classify(init, declarator.id.type === "Identifier" ? path : [], where);
    } else {
      const loop = script.parent(script.parent(declarator));
      result =
        loop?.type === "ForOfStatement" || loop?.type === "ForInStatement"
          ? this.classify(loop.right, [], where)
          : TRUSTED;
    }
    for (const reference of variable.references) {
      if (result.trust === "untrusted") break;
      if (reference.init) continue;
      if (reference.isWrite() && reference.writeExpr) {
        result = worst(result, this.classify(reference.writeExpr, inner, where));
        continue;
      }
      if (!container) continue;
      const member = script.parent(reference.identifier);
      const assignment = script.parent(member);
      if (
        member?.type === "MemberExpression" &&
        member.object === reference.identifier &&
        memberName(member) === "value" &&
        assignment?.type === "AssignmentExpression" &&
        assignment.left === member
      )
        result = worst(result, this.classify(assignment.right, inner, where));
    }
    return result;
  }

  /**
   * A parameter takes its value from the call that passes it; for callbacks, from the promise,
   * array, or watch source they receive values from.
   */
  private parameter(variable: ScopeVariable, fn: AnyNode, where: Where): HtmlSource {
    const script = where.unit!.script;
    const identifier = variable.identifiers[0] as AnyNode;
    const index = fn.params.findIndex((param: AnyNode) => contains(param, identifier));
    const call = script.parent(fn);
    if (index === 0 && call?.type === "CallExpression" && call.arguments.includes(fn)) {
      const callee = unwrap(call.callee);
      const method = memberName(callee);
      if (method === "then" && call.arguments[0] === fn)
        return this.classify(callee.object, [], where);
      if (method && ARRAY_CALLBACKS.has(method)) return this.classify(callee.object, [], where);
      if (call.arguments[1] === fn && vueApiCall(script, callee, WATCH))
        return this.watchSource(call.arguments[0], where);
    }
    return unknown(`the parameter \`${variable.name}\``);
  }

  private watchSource(source: AnyNode, where: Where): HtmlSource {
    source = unwrap(source);
    if (source?.type !== "ArrayExpression")
      return FUNCTION_TYPES.has(source?.type)
        ? this.returns(source, [], where)
        : this.classify(source, ["value"], where);
    let result = TRUSTED;
    for (const element of source.elements) result = worst(result, this.watchSource(element, where));
    return result;
  }

  private returns(fn: AnyNode, path: string[], where: Where): HtmlSource {
    fn = unwrap(fn);
    if (!FUNCTION_TYPES.has(fn?.type)) return fn ? this.classify(fn, path, where) : TRUSTED;
    if (fn.body.type !== "BlockStatement") return this.classify(fn.body, path, where);
    const keys = where.unit!.script.visitorKeys;
    const results: AnyNode[] = [];
    const visit = (node: AnyNode) => {
      if (!node?.type) return;
      if (node.type === "ReturnStatement") {
        if (node.argument) results.push(node.argument);
        return;
      }
      if (FUNCTION_TYPES.has(node.type)) return;
      for (const key of keys[node.type] ?? []) {
        const value = node[key];
        if (Array.isArray(value)) for (const child of value) visit(child);
        else visit(value);
      }
    };
    for (const statement of fn.body.body) visit(statement);
    return this.all(results, path, where);
  }

  private call(node: AnyNode, path: string[], where: Where): HtmlSource {
    const callee = unwrap(node.callee);
    const args: AnyNode[] = node.arguments;
    if (callee.type === "Identifier") return this.callName(callee, args, path, where);
    if (callee.type !== "MemberExpression")
      return unknown(`the result of \`${this.text(node, where)}\``);
    const method = memberName(callee) ?? "";
    const object = unwrap(callee.object);
    // Shiki escapes the code it highlights, whichever highlighter instance renders it.
    if (method === "codeToHtml") return TRUSTED;
    const imported = object.type === "Identifier" ? this.importOf(object, where) : undefined;
    if (method === "sanitize") {
      if (imported && DOMPURIFY.test(imported.source)) return TRUSTED;
      if (!imported && object.type === "Identifier" && object.name === "DOMPurify") return TRUSTED;
    }
    if (imported?.source === "marked" && MARKED_METHODS.has(method))
      return this.rendered(args[0], "marked", where);
    if (MARKDOWN_IT_METHODS.has(method) && this.isMarkdownIt(object, where))
      return this.rendered(args[0], "markdown-it", where);
    if (method === "then" && FUNCTION_TYPES.has(unwrap(args[0])?.type))
      return this.returns(args[0], path, where);
    if (STRING_METHODS.has(method)) {
      const receiver = this.classify(object, [], where);
      return ARGUMENT_METHODS.has(method) ? worst(receiver, this.all(args, [], where)) : receiver;
    }
    if (ARRAY_PASSTHROUGH.has(method)) return this.classify(object, [], where);
    if ((method === "map" || method === "flatMap") && FUNCTION_TYPES.has(unwrap(args[0])?.type))
      return this.returns(args[0], [], where);
    if (object.type === "Identifier" && object.name === "JSON" && !this.resolves(object, where))
      return method === "stringify" ? this.classify(args[0], [], where) : unknown("`JSON.parse()`");
    const receiver = this.classify(object, [], where);
    if (receiver.trust === "untrusted") return receiver;
    return unknown(`the result of \`${this.text(callee, where)}()\``);
  }

  private callName(callee: AnyNode, args: AnyNode[], path: string[], where: Where): HtmlSource {
    const name: string = callee.name;
    let variable: ScopeVariable | undefined;
    if (where.template) {
      if (where.template.has(name)) return unknown(`the result of \`${name}()\``);
      variable = (this.sfc && moduleVariable(this.sfc, name)) || undefined;
    } else {
      variable = where.unit?.script.references.get(callee)?.resolved ?? undefined;
      const unit = where.unit;
      if (unit && vueApiCall(unit.script, callee, UNWRAP_CALLS))
        return this.classify(args[0], [], where);
      if (unit && vueApiCall(unit.script, callee, REACTIVE_CALLS))
        return this.classify(args[0], path, where);
    }
    if (!variable) return this.callGlobal(name, args, path, where);
    return this.callVariable(variable, args, path, where, where.unit!);
  }

  private callVariable(
    variable: ScopeVariable,
    args: AnyNode[],
    path: string[],
    caller: Where,
    unit: Unit,
  ): HtmlSource {
    const definition = variable.defs[0] as AnyNode;
    if (definition?.type === "ImportBinding") {
      const { source, imported } = importBinding(definition);
      return this.callImport(source, imported, args, path, caller, unit.file);
    }
    if (definition?.type === "FunctionName")
      return this.callFunction(definition.node, args, path, caller, unit);
    if (definition?.type === "Variable" && FUNCTION_TYPES.has(unwrap(definition.node.init)?.type))
      return this.callFunction(unwrap(definition.node.init), args, path, caller, unit);
    return unknown(`the result of \`${variable.name}()\``);
  }

  private callFunction(
    fn: AnyNode,
    args: AnyNode[],
    path: string[],
    caller: Where,
    unit: Unit,
  ): HtmlSource {
    if (this.active.has(fn)) return TRUSTED;
    this.active.add(fn);
    try {
      const params = new Map<ScopeVariable, () => HtmlSource>();
      const declared = unit.script.scopeManager.getDeclaredVariables(fn);
      fn.params.forEach((param: AnyNode, index: number) => {
        const id = param.type === "AssignmentPattern" ? param.left : param;
        if (id.type !== "Identifier") return;
        const variable = declared.find((candidate) => candidate.identifiers.includes(id));
        if (!variable) return;
        const arg = args[index];
        params.set(variable, () =>
          arg
            ? arg.type === "SpreadElement"
              ? unknown(`a spread argument of \`${this.text(arg.argument, caller)}\``)
              : this.classify(arg, [], caller)
            : param.type === "AssignmentPattern"
              ? this.classify(param.right, [], { unit })
              : TRUSTED,
        );
      });
      return this.returns(fn, path, { unit, params });
    } finally {
      this.active.delete(fn);
    }
  }

  private callImport(
    source: string,
    imported: string,
    args: AnyNode[],
    path: string[],
    caller: Where,
    from: string,
  ): HtmlSource {
    const known = PACKAGE_CALLS.find((call) => call.name === imported && call.source.test(source));
    if (known?.effect === "trusted") return TRUSTED;
    if (known?.effect === "markdown") return this.rendered(args[0], known.label!, caller);
    if (UNTRUSTED_CALLS.has(imported) && !isLocalSpecifier(source))
      return untrusted(`\`${imported}()\``);
    if (ASYNC_DATA.has(imported) && !isLocalSpecifier(source)) return this.asyncData(args, caller);
    const file = this.resolveModule(from, source);
    const unit = file && this.unit(file);
    if (unit) {
      const target = this.exported(unit, imported);
      if (target && "variable" in target)
        return this.callVariable(target.variable, args, path, caller, unit);
      if (target && "source" in target)
        return this.callImport(target.source, target.imported, args, path, caller, unit.file);
      if (target) return this.callFunction(target.node, args, path, caller, unit);
    }
    return unknown(`the result of \`${imported}()\` from \`${source}\``);
  }

  private callGlobal(name: string, args: AnyNode[], path: string[], where: Where): HtmlSource {
    if (UNTRUSTED_CALLS.has(name)) return untrusted(`\`${name}()\``);
    if (ASYNC_DATA.has(name)) return this.asyncData(args, where);
    if (PASS_GLOBALS.has(name)) return this.classify(args[0], [], where);
    if (SAFE_GLOBALS.has(name)) return TRUSTED;
    const target = this.autoImport(name);
    if (target)
      return this.callImport(target.source, target.imported, args, path, where, target.from);
    return unknown(`the result of \`${name}()\`, which Doctor could not resolve`);
  }

  private asyncData(args: AnyNode[], where: Where): HtmlSource {
    const handler = args.find((arg) => FUNCTION_TYPES.has(unwrap(arg)?.type));
    return handler ? this.returns(handler, [], where) : unknown("an `useAsyncData()` handler");
  }

  private rendered(input: AnyNode, renderer: string, where: Where): HtmlSource {
    const result = input ? this.classify(input, [], where) : TRUSTED;
    return result.trust === "trusted" ? result : { ...result, via: result.via ?? renderer };
  }

  private construct(node: AnyNode, where: Where): HtmlSource {
    const callee = unwrap(node.callee);
    if (
      callee.type === "Identifier" &&
      (callee.name === "URL" || callee.name === "URLSearchParams")
    )
      return this.all(node.arguments, [], where);
    return unknown(`\`${this.text(node, where)}\``);
  }

  private importedValue(definition: AnyNode, path: string[], unit: Unit): HtmlSource {
    const { source, imported } = importBinding(definition);
    if (UNTRUSTED_CALLS.has(imported) && !isLocalSpecifier(source))
      return unknown(`\`${imported}\` from \`${source}\``);
    const file = this.resolveModule(unit.file, source);
    const target = file ? this.unit(file) : null;
    const exported = target && this.exported(target, imported);
    if (exported && "variable" in exported)
      return this.variable(exported.variable, path, { unit: target });
    if (exported && "node" in exported && !FUNCTION_TYPES.has(exported.node.type))
      return this.classify(exported.node, path, { unit: target });
    return unknown(`\`${imported}\` from \`${source}\``);
  }

  /** The module an identifier was imported from, when the identifier is an import binding. */
  private importOf(node: AnyNode, where: Where) {
    const variable = where.template
      ? this.sfc && moduleVariable(this.sfc, node.name)
      : where.unit?.script.references.get(node)?.resolved;
    const definition = variable?.defs[0] as AnyNode;
    return definition?.type === "ImportBinding" ? importBinding(definition) : undefined;
  }

  private resolves(node: AnyNode, where: Where): boolean {
    return where.template
      ? !!this.sfc && !!moduleVariable(this.sfc, node.name)
      : !!where.unit?.script.references.get(node)?.resolved;
  }

  /** Whether `node` is a markdown-it instance: `new MarkdownIt()` or `markdownit()` from `markdown-it`. */
  private isMarkdownIt(node: AnyNode, where: Where): boolean {
    if (node.type !== "Identifier") return false;
    const variable = where.template
      ? this.sfc && moduleVariable(this.sfc, node.name)
      : where.unit?.script.references.get(node)?.resolved;
    const definition = variable?.defs[0] as AnyNode;
    if (definition?.type !== "Variable") return false;
    const init = unwrap(definition.node.init);
    if (init?.type !== "NewExpression" && init?.type !== "CallExpression") return false;
    const factory = unwrap(init.callee);
    if (factory?.type !== "Identifier") return false;
    const unit = where.template ? this.sfc : where.unit;
    const origin = unit?.script.references.get(factory)?.resolved?.defs[0] as AnyNode;
    return origin?.type === "ImportBinding" && importBinding(origin).source === "markdown-it";
  }

  private autoImport(name: string): { source: string; imported: string; from: string } | null {
    const nuxt = this.ctx.project.nuxt;
    if (!nuxt?.autoImportEnabled) return null;
    const entry = nuxt.autoImports.get(name);
    if (entry && !entry.type)
      return { source: entry.from, imported: entry.name, from: this.ctx.file.path };
    // Without a Nuxt manifest Doctor knows only the core auto-imports. Nuxt also scans the top
    // level of `utils/` and `composables/` in the app, so read those for the exported name.
    for (const srcDir of nuxtSourceDirs(this.ctx)) {
      for (const dir of ["utils", "composables"]) {
        for (const file of this.scannedModules(join(srcDir, dir))) {
          const unit = this.unit(file);
          if (unit && this.exported(unit, name))
            return { source: file, imported: name, from: this.ctx.file.path };
        }
      }
    }
    return null;
  }

  private scannedModules(dir: string): string[] {
    const files: string[] = [];
    for (const entry of this.ctx.fs.readDir(dir) ?? []) {
      const path = join(dir, entry.name);
      if (entry.isFile() && SCRIPT_EXTENSIONS.some((extension) => entry.name.endsWith(extension)))
        files.push(path);
      else if (entry.isDirectory()) {
        const index = this.resolveModule(join(path, "index.ts"), "./index");
        if (index) files.push(index);
      }
    }
    return files;
  }

  private resolveModule(from: string, source: string): string | null {
    let base: string | undefined;
    if (source.startsWith(".")) base = resolve(dirname(from), source);
    else if (isAbsolute(source)) base = source;
    else if (this.ctx.project.nuxt && /^[~@]\//.test(source))
      base = resolve(this.ctx.project.nuxt.appDir, source.slice(2));
    else if (this.ctx.project.nuxt && /^(?:~~|@@)\//.test(source))
      base = resolve(this.ctx.project.root, source.slice(3));
    if (!base || base.endsWith(".vue")) return null;
    const stem = base.replace(/\.[cm]?js$/, "");
    const candidates = [
      base,
      ...SCRIPT_EXTENSIONS.map((extension) => stem + extension),
      ...SCRIPT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
    ];
    return candidates.find((candidate) => this.ctx.fs.stat(candidate)?.isFile()) ?? null;
  }

  private unit(file: string): Unit | null {
    if (this.units.has(file)) return this.units.get(file)!;
    const text = this.ctx.fs.readText(file);
    const scope = text === undefined ? null : analyzeScript(text, scopeDialect(file));
    const unit = scope ? { file, script: indexScriptScope(scope) } : null;
    this.units.set(file, unit);
    return unit;
  }

  /** What a module exports as `name`: a local binding, a default export, or a re-export. */
  private exported(
    unit: Unit,
    name: string,
  ): { variable: ScopeVariable } | { node: AnyNode } | { source: string; imported: string } | null {
    for (const statement of unit.script.ast.body as AnyNode[]) {
      if (statement.type === "ExportDefaultDeclaration" && name === "default") {
        const declaration = statement.declaration;
        if (declaration.id && moduleVariable(unit, declaration.id.name))
          return { variable: moduleVariable(unit, declaration.id.name)! };
        if (declaration.type === "Identifier" && moduleVariable(unit, declaration.name))
          return { variable: moduleVariable(unit, declaration.name)! };
        return { node: declaration };
      }
      if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
      const declaration = statement.declaration;
      if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === name)
        return { variable: moduleVariable(unit, name)! };
      if (declaration?.type === "VariableDeclaration")
        for (const declarator of declaration.declarations)
          if (declarator.id.type === "Identifier" && declarator.id.name === name)
            return { variable: moduleVariable(unit, name)! };
      for (const specifier of statement.specifiers ?? []) {
        if (propertyName(specifier.exported) !== name) continue;
        const local = propertyName(specifier.local)!;
        if (statement.source) return { source: statement.source.value, imported: local };
        const variable = moduleVariable(unit, local);
        return variable ? { variable } : null;
      }
    }
    return null;
  }

  private text(node: AnyNode, where: Where): string {
    const source = where.template || where.unit === this.sfc ? this.ctx.file.text : undefined;
    const [start, end] = node.range ?? [node.start, node.end];
    const text = source?.slice(start, end) ?? node.name ?? node.type;
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }
}

/** Names a `<script setup>` declares as props, by type literal, runtime object, or array. */
function declaredProps(script: IndexedScript): Set<string> {
  const names = new Set<string>();
  for (const call of script.nodes("CallExpression")) {
    const callee = unwrap(call.callee);
    if (callee?.type !== "Identifier") continue;
    if (callee.name === "defineModel") {
      const first = unwrap(call.arguments[0]);
      names.add(
        first?.type === "Literal" && typeof first.value === "string" ? first.value : "modelValue",
      );
      continue;
    }
    if (callee.name !== "defineProps") continue;
    const type = (call.typeArguments ?? call.typeParameters)?.params?.[0];
    for (const member of type?.type === "TSTypeLiteral" ? type.members : [])
      if (member.type === "TSPropertySignature" && propertyName(member.key))
        names.add(propertyName(member.key)!);
    const runtime = unwrap(call.arguments[0]);
    if (runtime?.type === "ObjectExpression")
      for (const property of runtime.properties)
        if (property.type === "Property" && propertyName(property.key))
          names.add(propertyName(property.key)!);
    if (runtime?.type === "ArrayExpression")
      for (const element of runtime.elements)
        if (element?.type === "Literal" && typeof element.value === "string")
          names.add(element.value);
  }
  return names;
}

function nuxtSourceDirs(ctx: RuleContext): string[] {
  const nuxt = ctx.project.nuxt!;
  const roots = [
    nuxt.appDir,
    ...nuxt.layers.map((layer) => layer.srcDir ?? layer.root),
    ...nuxt.appRoots.flatMap((root) => [join(root, "app"), root]),
  ];
  return [...new Set(roots)].filter(
    (dir) => ctx.file.path.startsWith(`${dir}/`) && ctx.fs.stat(dir)?.isDirectory(),
  );
}

function isDefineProps(node: AnyNode): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = unwrap(node.callee);
  if (callee?.type !== "Identifier") return false;
  if (callee.name === "withDefaults") return isDefineProps(unwrap(node.arguments[0]));
  return callee.name === "defineProps";
}

function importBinding(definition: AnyNode): { source: string; imported: string } {
  const specifier = definition.node;
  // `import x = require("...")` has no import declaration source.
  const source: string = definition.parent?.source?.value ?? "";
  if (specifier.type === "ImportDefaultSpecifier") return { source, imported: "default" };
  if (specifier.type === "ImportNamespaceSpecifier") return { source, imported: "*" };
  return { source, imported: propertyName(specifier.imported) ?? specifier.local.name };
}

function moduleVariable(unit: Unit, name: string): ScopeVariable | undefined {
  const module = unit.script.scopeManager.scopes.find((scope) => scope.type === "module");
  return module?.set.get(name);
}

function isModuleLevel(variable: ScopeVariable): boolean {
  return variable.scope.type === "module";
}

function isLocalSpecifier(source: string): boolean {
  return /^(?:\.|\/|[~@]{1,2}\/)/.test(source);
}

function memberKey(node: AnyNode): string {
  const name = memberName(node);
  if (name !== undefined) return name;
  if (node.computed && node.property.type === "Literal") return String(node.property.value);
  return "*";
}

function contains(outer: AnyNode, inner: AnyNode): boolean {
  const [start, end] = outer.range ?? [outer.start, outer.end];
  const [innerStart, innerEnd] = inner.range ?? [inner.start, inner.end];
  return start <= innerStart && innerEnd <= end;
}

function unwrap(node: AnyNode): AnyNode {
  node = unwrapTs(node);
  while (node?.type === "ParenthesizedExpression" || node?.type === "ChainExpression") {
    node = unwrapTs(node.expression);
  }
  return node;
}
