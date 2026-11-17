import { dirname, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { parseScript } from "../../../../core/internal/script.js";
import type { AnyNode } from "./shared.js";

/**
 * A value that differs between the server render and the first client render: a browser global
 * the server cannot read, or the clock, randomness, locale or time zone of the process that
 * renders. `via` names the helper calls that lead to it.
 */
export interface SsrValue {
  label: string;
  node: AnyNode;
  via: string[];
  /** Set while the value comes from a parameter default, which a call can override. */
  param?: { fn: AnyNode; index: number };
  /**
   * The browser read cannot throw on the server: it is guarded by `typeof window`, an
   * `import.meta.client` check or a `try` block, or reads through `globalThis`. Only such reads
   * render differently instead of failing the server render.
   */
  guarded?: boolean;
}

export type SsrValueKind = "browser" | "render";

// Globals whose value exists only in a browser, or differs per browser, such as its viewport.
const BROWSER_READS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "matchMedia",
  "innerWidth",
  "innerHeight",
  "screen",
  "devicePixelRatio",
]);
const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
const DATE_LOCALE_METHODS = new Set(["toLocaleDateString", "toLocaleTimeString"]);
const LOCALE_FORMATS = new Set(["NumberFormat", "RelativeTimeFormat", "PluralRules", "ListFormat"]);
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "ChainExpression",
]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const MAX_DEPTH = 5;

interface ScriptModule {
  file: string;
  program: AnyNode;
}

/**
 * Finds SSR-varying values that an expression evaluates synchronously: directly, through local
 * variables, and through functions declared in the same file or imported from a relative path.
 * Function bodies count only for the calls that run them, and default parameters only when the
 * call leaves that argument out.
 */
export function createSsrValueTracer(ctx: RuleContext, kind: SsrValueKind) {
  const summaries = new Map<AnyNode, SsrValue[]>();
  const modules = new Map<string, ScriptModule | null>();
  const current: ScriptModule = { file: ctx.file.path, program: undefined };

  function direct(node: AnyNode, module: ScriptModule): string | undefined {
    if (kind === "browser") return browserRead(node, module);
    return renderVariance(node, module);
  }

  function browserRead(node: AnyNode, module: ScriptModule): string | undefined {
    if (node.type === "Identifier") {
      if (!BROWSER_READS.has(node.name) || !isReference(node)) return undefined;
      if (isTypeofOperand(node) || resolveName(node, node.name, module)) return undefined;
      return node.name;
    }
    if (node.type === "MemberExpression" && !node.computed) {
      const object = unwrap(node.object);
      if (
        object?.type === "Identifier" &&
        object.name === "globalThis" &&
        BROWSER_READS.has(node.property?.name) &&
        !isTypeofOperand(node)
      )
        return `globalThis.${node.property.name}`;
    }
    return undefined;
  }

  function renderVariance(node: AnyNode, module: ScriptModule): string | undefined {
    if (node.type === "NewExpression") {
      const callee = unwrap(node.callee);
      if (isGlobal(callee, "Date", module) && !node.arguments?.length) return "new Date()";
    }
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return undefined;
    const callee = unwrap(node.callee);
    if (callee?.type !== "MemberExpression" || callee.computed) return undefined;
    const object = unwrap(callee.object);
    const method = callee.property?.name;
    if (node.type === "CallExpression" && method === "now" && isGlobal(object, "Date", module))
      return "Date.now()";
    if (node.type === "CallExpression" && method === "random" && isGlobal(object, "Math", module))
      return "Math.random()";
    if (
      node.type === "CallExpression" &&
      method === "now" &&
      isGlobal(object, "performance", module)
    )
      return "performance.now()";
    if (isGlobal(object, "Intl", module)) {
      const [locale, options] = node.arguments ?? [];
      if (method === "DateTimeFormat") {
        if (missingLocale(locale)) return "Intl.DateTimeFormat without a locale";
        if (missingTimeZone(options)) return "Intl.DateTimeFormat without a timeZone";
      }
      if (LOCALE_FORMATS.has(method) && missingLocale(locale))
        return `Intl.${method} without a locale`;
      return undefined;
    }
    if (node.type !== "CallExpression" || !LOCALE_METHODS.has(method)) return undefined;
    const [locale, options] = node.arguments ?? [];
    if (missingLocale(locale)) return `${method}() without a locale`;
    const isDate =
      DATE_LOCALE_METHODS.has(method) ||
      (object?.type === "NewExpression" && isGlobal(unwrap(object.callee), "Date", module));
    if (isDate && missingTimeZone(options)) return `${method}() without a timeZone`;
    return undefined;
  }

  function isGlobal(node: AnyNode, name: string, module: ScriptModule): boolean {
    return node?.type === "Identifier" && node.name === name && !resolveName(node, name, module);
  }

  /**
   * SSR-varying values that the value of `node` depends on. Nested functions run later, if at all,
   * except callbacks of method calls such as `items.find(...)`, whose result can be the value.
   */
  function expression(
    node: AnyNode,
    module: ScriptModule,
    seen = new Set<AnyNode>(),
    depth = 0,
  ): SsrValue[] {
    const found: SsrValue[] = [];
    // A function value runs later, if at all.
    if (FUNCTION_TYPES.has(unwrap(node)?.type)) return found;
    walk(node, (child) => {
      if (child !== node && FUNCTION_TYPES.has(child.type)) {
        if (isMethodCallback(child))
          for (const value of returnedValues(child, module, seen, depth))
            found.push({ ...value, node: child });
        return false;
      }
      const label = direct(child, module);
      if (label)
        found.push({
          label,
          node: child,
          via: [],
          ...(kind === "browser" && survivesServer(child) ? { guarded: true } : {}),
        });
      if (child.type === "CallExpression" || child.type === "NewExpression") {
        for (const value of callValues(child, module, seen, depth))
          found.push({ ...value, node: child });
      }
      if (child.type === "Identifier" && isReference(child)) {
        for (const value of bindingValues(child, module, seen, depth))
          found.push({ ...value, node: child });
      }
      return true;
    });
    return found;
  }

  /** Values a variable or a defaulted parameter holds where `identifier` reads it. */
  function bindingValues(
    identifier: AnyNode,
    module: ScriptModule,
    seen: Set<AnyNode>,
    depth: number,
  ): SsrValue[] {
    const binding = resolveName(identifier, identifier.name, module);
    if (!binding || seen.has(binding.node)) return [];
    if (binding.kind === "param") {
      seen.add(binding.node);
      const defaults = defaultValues(binding.node);
      return defaults.flatMap((value) =>
        expression(value, module, seen, depth).map((found) => ({
          ...found,
          param: { fn: binding.fn, index: binding.index },
        })),
      );
    }
    if (binding.kind !== "variable") return [];
    seen.add(binding.node);
    const init = unwrap(binding.node.init);
    // Reactive state reports where it is created, not again in state derived from it.
    if (kind === "browser" && isStateCall(init)) return [];
    const sources = [
      ...(init && !FUNCTION_TYPES.has(init.type) ? [init] : []),
      ...reassignments(binding.node, identifier.name),
    ];
    return sources.flatMap((source) => expression(source, module, seen, depth));
  }

  function callValues(
    call: AnyNode,
    module: ScriptModule,
    seen: Set<AnyNode>,
    depth: number,
  ): SsrValue[] {
    const callee = unwrap(call.callee);
    if (callee?.type !== "Identifier" || depth >= MAX_DEPTH) return [];
    const target = resolveFunction(callee, module);
    if (!target) return [];
    const values = summary(target.fn, target.module, depth + 1);
    const argumentCount = call.arguments?.length ?? 0;
    return (
      values
        .filter(
          (value) =>
            !value.param || value.param.fn !== target.fn || value.param.index >= argumentCount,
        )
        // A helper that renders the value into its own vnodes reports it there, once.
        .filter((value) => kind !== "render" || !isVnodeContent(value.node, target.fn))
        .map(({ param: _param, ...value }) => ({
          ...value,
          via: [`${callee.name}()`, ...value.via],
        }))
    );
  }

  /** What a function returns, so a call's value depends on it. */
  function summary(fn: AnyNode, module: ScriptModule, depth: number): SsrValue[] {
    const cached = summaries.get(fn);
    if (cached) return cached;
    summaries.set(fn, []);
    const values = returnedValues(fn, module, new Set(), depth);
    summaries.set(fn, values);
    return values;
  }

  function returnedValues(
    fn: AnyNode,
    module: ScriptModule,
    seen: Set<AnyNode>,
    depth: number,
  ): SsrValue[] {
    if (fn.async || fn.generator) return [];
    if (fn.body?.type !== "BlockStatement") return expression(fn.body, module, seen, depth);
    const returned: AnyNode[] = [];
    walk(fn.body, (child) => {
      if (FUNCTION_TYPES.has(child.type) || child.type === "ClassBody") return false;
      if (child.type === "ReturnStatement" && child.argument) returned.push(child.argument);
      return true;
    });
    return returned.flatMap((value) => expression(value, module, seen, depth));
  }

  function resolveFunction(
    callee: AnyNode,
    module: ScriptModule,
  ): { fn: AnyNode; module: ScriptModule } | undefined {
    const binding = resolveName(callee, callee.name, module);
    if (binding?.kind === "function") return { fn: binding.node, module };
    if (binding?.kind === "variable") {
      const init = unwrap(binding.node.init);
      return FUNCTION_TYPES.has(init?.type) ? { fn: init, module } : undefined;
    }
    if (binding?.kind === "import") return importedFunction(module, binding.source, binding.name);
    return undefined;
  }

  function importedFunction(
    from: ScriptModule,
    source: string,
    name: string,
    depth = 0,
  ): { fn: AnyNode; module: ScriptModule } | undefined {
    if (!source.startsWith(".") || depth > MAX_DEPTH) return undefined;
    const module = loadModule(resolve(dirname(from.file), source));
    if (!module) return undefined;
    for (const statement of module.program.body ?? []) {
      if (statement.type === "ExportNamedDeclaration") {
        const declaration = statement.declaration;
        if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === name)
          return { fn: declaration, module };
        if (declaration?.type === "VariableDeclaration")
          for (const declarator of declaration.declarations ?? [])
            if (declarator.id?.name === name && FUNCTION_TYPES.has(unwrap(declarator.init)?.type))
              return { fn: unwrap(declarator.init), module };
        for (const specifier of statement.specifiers ?? []) {
          if (exportedName(specifier) !== name) continue;
          const local = specifier.local?.name ?? specifier.local?.value;
          if (statement.source?.value)
            return importedFunction(module, statement.source.value, local, depth + 1);
          const binding = topLevelBinding(module.program, local);
          if (binding?.kind === "function") return { fn: binding.node, module };
          if (binding?.kind === "variable" && FUNCTION_TYPES.has(unwrap(binding.node.init)?.type))
            return { fn: unwrap(binding.node.init), module };
          if (binding?.kind === "import")
            return importedFunction(module, binding.source, binding.name, depth + 1);
        }
      }
      if (statement.type === "ExportAllDeclaration" && !statement.exported) {
        const found = importedFunction(module, statement.source.value, name, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  function loadModule(base: string): ScriptModule | null {
    const candidates = [
      base,
      ...SOURCE_EXTENSIONS.map((extension) => base.replace(/\.[cm]?js$/, "") + extension),
      ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
    ];
    for (const file of candidates) {
      if (modules.has(file)) return modules.get(file)!;
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      const text = ctx.fs.readText(file);
      if (text === undefined) continue;
      const program = parseScript(file, text);
      if (program) linkParents(program);
      const module = program ? { file, program } : null;
      modules.set(file, module);
      return module;
    }
    return null;
  }

  function moduleOf(node: AnyNode): ScriptModule {
    if (current.program) return current;
    let root = node;
    while (parentOf(root)) root = parentOf(root);
    current.program = root;
    return current;
  }

  return {
    /** SSR-varying values an expression in the current file reads when it is evaluated. */
    expression(node: AnyNode): SsrValue[] {
      return expression(node, moduleOf(node));
    },
    /** SSR-varying values a function in the current file returns, such as a computed() getter. */
    returned(fn: AnyNode): SsrValue[] {
      return returnedValues(fn, moduleOf(fn), new Set(), 0);
    },
    /** The label of `node` itself when it is an SSR-varying value of this tracer's kind. */
    direct(node: AnyNode): string | undefined {
      return direct(node, moduleOf(node));
    },
    /** Values a call reaches through the function it calls. */
    call(node: AnyNode): SsrValue[] {
      return callValues(node, moduleOf(node), new Set(), 0).map((value) => ({ ...value, node }));
    },
  };
}

type Binding =
  | { kind: "function"; node: AnyNode }
  | { kind: "variable"; node: AnyNode }
  | { kind: "param"; node: AnyNode; fn: AnyNode; index: number }
  | { kind: "import"; node?: undefined; source: string; name: string }
  | { kind: "other"; node?: undefined };

/**
 * The declaration `name` refers to at `node`. Files Doctor analyzes carry parent links, so their
 * scopes are walked outward; imported modules are only resolved at their top level.
 */
function resolveName(node: AnyNode, name: string, module: ScriptModule): Binding | undefined {
  if (!parentOf(node)) return topLevelBinding(module.program, name);
  for (let scope = parentOf(node); scope; scope = parentOf(scope)) {
    if (FUNCTION_TYPES.has(scope.type)) {
      if (scope.id?.name === name && scope.type !== "FunctionDeclaration")
        return { kind: "function", node: scope };
      const index = (scope.params ?? []).findIndex((param: AnyNode) => bindsName(param, name));
      if (index !== -1) return { kind: "param", node: scope.params[index], fn: scope, index };
    }
    if (scope.type === "CatchClause" && bindsName(scope.param, name)) return { kind: "other" };
    if (
      (scope.type === "ForOfStatement" ||
        scope.type === "ForInStatement" ||
        scope.type === "ForStatement") &&
      bindsName(scope.left ?? scope.init, name)
    )
      return { kind: "other" };
    const body =
      scope.type === "Program" || scope.type === "BlockStatement" || scope.type === "StaticBlock"
        ? scope.body
        : undefined;
    if (body) {
      const binding = statementsBinding(body, name);
      if (binding) return binding;
    }
  }
  return undefined;
}

function topLevelBinding(program: AnyNode, name: string): Binding | undefined {
  return statementsBinding(program?.body ?? [], name);
}

function statementsBinding(statements: AnyNode[], name: string): Binding | undefined {
  for (const raw of statements) {
    const statement =
      raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration"
        ? (raw.declaration ?? raw)
        : raw;
    if (
      (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
      statement.id?.name === name
    )
      return statement.type === "FunctionDeclaration"
        ? { kind: "function", node: statement }
        : { kind: "other" };
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations ?? []) {
        if (bindsName(declarator.id, name)) return { kind: "variable", node: declarator };
      }
    }
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.local?.name !== name) continue;
        if (statement.importKind === "type" || specifier.importKind === "type")
          return { kind: "other" };
        return specifier.type === "ImportSpecifier"
          ? {
              kind: "import",
              source: statement.source.value,
              name: specifier.imported?.name ?? specifier.imported?.value,
            }
          : { kind: "other" };
      }
    }
    if (statement.type === "TSEnumDeclaration" && statement.id?.name === name)
      return { kind: "other" };
  }
  return undefined;
}

function bindsName(pattern: AnyNode, name: string): boolean {
  if (!pattern) return false;
  if (pattern.type === "VariableDeclaration")
    return (pattern.declarations ?? []).some((item: AnyNode) => bindsName(item.id, name));
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "AssignmentPattern") return bindsName(pattern.left, name);
  if (pattern.type === "RestElement") return bindsName(pattern.argument, name);
  if (pattern.type === "TSParameterProperty") return bindsName(pattern.parameter, name);
  if (pattern.type === "ObjectPattern")
    return (pattern.properties ?? []).some((property: AnyNode) =>
      bindsName(property.value ?? property.argument, name),
    );
  if (pattern.type === "ArrayPattern")
    return (pattern.elements ?? []).some((element: AnyNode) => bindsName(element, name));
  return false;
}

function exportedName(specifier: AnyNode): string | undefined {
  return specifier.exported?.name ?? specifier.exported?.value;
}

/** The default values a parameter declares, including defaults inside its destructuring. */
function defaultValues(param: AnyNode): AnyNode[] {
  const values: AnyNode[] = [];
  walk(param, (child) => {
    if (child.type === "AssignmentPattern" && child.right) values.push(child.right);
    return !FUNCTION_TYPES.has(child.type);
  });
  return values;
}

/** Right-hand sides assigned to a `let` or `var` binding in the function that declares it. */
function reassignments(declarator: AnyNode, name: string): AnyNode[] {
  if (parentOf(declarator)?.kind === "const") return [];
  let scope = parentOf(declarator);
  while (scope && !FUNCTION_TYPES.has(scope.type) && scope.type !== "Program")
    scope = parentOf(scope);
  const values: AnyNode[] = [];
  walk(FUNCTION_TYPES.has(scope?.type) ? scope.body : scope, (child) => {
    if (FUNCTION_TYPES.has(child.type)) return false;
    if (
      child.type === "AssignmentExpression" &&
      unwrap(child.left)?.type === "Identifier" &&
      unwrap(child.left).name === name
    )
      values.push(child.right);
    return true;
  });
  return values;
}

const STATE_APIS = new Set(["ref", "shallowRef", "reactive", "shallowReactive", "computed"]);

function isStateCall(node: AnyNode): boolean {
  const callee = unwrap(node?.callee);
  return (
    node?.type === "CallExpression" && callee?.type === "Identifier" && STATE_APIS.has(callee.name)
  );
}

/** Whether a browser read cannot throw on the server, because a guard or `try` keeps it there. */
function survivesServer(node: AnyNode): boolean {
  if (node.type === "MemberExpression") return true;
  let child = node;
  for (let parent = parentOf(node); parent; child = parent, parent = parentOf(parent)) {
    if (
      (parent.type === "ConditionalExpression" || parent.type === "IfStatement") &&
      parent.test !== child &&
      hasEnvironmentGuard(parent.test)
    )
      return true;
    if (
      parent.type === "LogicalExpression" &&
      parent.right === child &&
      hasEnvironmentGuard(parent.left)
    )
      return true;
    if (parent.type === "TryStatement" && parent.block === child) return true;
    const body =
      parent.type === "BlockStatement" || parent.type === "Program" ? parent.body : undefined;
    if (body) {
      for (const statement of body) {
        if (statement === child) break;
        if (
          statement.type === "IfStatement" &&
          hasEnvironmentGuard(statement.test) &&
          exits(statement.consequent)
        )
          return true;
      }
    }
    if (FUNCTION_TYPES.has(parent.type) && !isMethodCallback(parent)) return false;
  }
  return false;
}

/** Whether an expression tests the runtime: `typeof window`, `import.meta.client`, `isClient`. */
function hasEnvironmentGuard(test: AnyNode): boolean {
  let found = false;
  walk(test, (node) => {
    if (found || FUNCTION_TYPES.has(node.type)) return false;
    if (node.type === "UnaryExpression" && node.operator === "typeof") {
      const argument = unwrap(node.argument);
      const name =
        argument?.type === "Identifier"
          ? argument.name
          : argument?.type === "MemberExpression" && unwrap(argument.object)?.name === "globalThis"
            ? argument.property?.name
            : undefined;
      if (BROWSER_READS.has(name)) found = true;
    }
    if (node.type === "MemberExpression" && !node.computed) {
      const object = unwrap(node.object);
      const property = node.property?.name;
      if (
        (property === "client" || property === "server" || property === "browser") &&
        (object?.type === "MetaProperty" ||
          (object?.type === "Identifier" && object.name === "process"))
      )
        found = true;
    }
    if (node.type === "Identifier" && /^(isClient|isBrowser|isServer|inBrowser)$/.test(node.name))
      found = true;
    return true;
  });
  return found;
}

/** Whether a statement always leaves the block, such as `return` or `throw`. */
function exits(statement: AnyNode): boolean {
  if (statement?.type === "ReturnStatement" || statement?.type === "ThrowStatement") return true;
  if (statement?.type === "BlockStatement") return statement.body.some(exits);
  return false;
}

/** Whether `node` is part of an `h()` call or JSX inside `fn`. */
export function isVnodeContent(node: AnyNode, fn?: AnyNode): boolean {
  let child = node;
  for (
    let parent = parentOf(node);
    parent && child !== fn;
    child = parent, parent = parentOf(parent)
  ) {
    if (parent.type === "JSXElement" || parent.type === "JSXFragment") return true;
    const callee = parent.type === "CallExpression" ? unwrap(parent.callee) : undefined;
    if (
      callee?.type === "Identifier" &&
      (callee.name === "h" || callee.name === "createVNode") &&
      parent.callee !== child
    )
      return true;
  }
  return false;
}

/** A callback passed to a method call, such as `items.find(...)`, that runs before it returns. */
function isMethodCallback(fn: AnyNode): boolean {
  const call = parentOf(fn);
  return (
    call?.type === "CallExpression" &&
    call.callee !== fn &&
    unwrap(call.callee)?.type === "MemberExpression"
  );
}

function missingLocale(node: AnyNode): boolean {
  const value = unwrap(node);
  return !value || (value.type === "Identifier" && value.name === "undefined");
}

/** Whether date options leave out `timeZone`. Options Doctor cannot read count as setting it. */
function missingTimeZone(node: AnyNode): boolean {
  const value = unwrap(node);
  if (!value || (value.type === "Identifier" && value.name === "undefined")) return true;
  if (value.type !== "ObjectExpression") return false;
  return !(value.properties ?? []).some(
    (property: AnyNode) =>
      property.type === "SpreadElement" ||
      (property.key?.name ?? property.key?.value) === "timeZone",
  );
}

/** Whether an identifier reads a variable, rather than naming a property, key, or type. */
function isReference(node: AnyNode): boolean {
  const parent = parentOf(node);
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    parent.key === node &&
    !parent.computed &&
    !parent.shorthand
  )
    return false;
  if (parent.type?.startsWith("TS") && !WRAPPERS.has(parent.type)) return false;
  if (
    parent.type === "ImportSpecifier" ||
    parent.type === "ExportSpecifier" ||
    parent.type === "LabeledStatement"
  )
    return false;
  return true;
}

function isTypeofOperand(node: AnyNode): boolean {
  let child = node;
  let parent = parentOf(node);
  while (WRAPPERS.has(parent?.type)) {
    child = parent;
    parent = parentOf(parent);
  }
  return (
    parent?.type === "UnaryExpression" && parent.operator === "typeof" && parent.argument === child
  );
}

export function unwrap(node: AnyNode): AnyNode {
  while (WRAPPERS.has(node?.type)) node = node.expression;
  return node;
}

// Doctor links parents only in the file a Rule analyzes; imported modules get their own links.
const importedParents = new WeakMap<object, AnyNode>();

function parentOf(node: AnyNode): AnyNode {
  return node?.__doctorParent ?? importedParents.get(node);
}

function linkParents(program: AnyNode) {
  const stack: AnyNode[] = [program];
  while (stack.length) {
    const node = stack.pop();
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child || typeof child !== "object" || typeof child.type !== "string") continue;
        importedParents.set(child, node);
        stack.push(child);
      }
    }
  }
}

/** Visits `node` and its descendants. Returning `false` skips a node's children. */
function walk(node: AnyNode, visit: (node: AnyNode) => boolean) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  if (!visit(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "__doctorParent" ||
      key === "parent" ||
      key === "typeAnnotation" ||
      key === "returnType" ||
      key === "typeParameters" ||
      key === "typeArguments"
    )
      continue;
    if (value && typeof value === "object") walk(value, visit);
  }
}
