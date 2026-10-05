import { relative, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import type { AnyNode } from "./shared.js";

export interface ExportedFunction {
  name: string;
  nameNode: AnyNode;
  fn: AnyNode;
  isDefault: boolean;
}

const LIFECYCLE_HOOKS = new Set([
  "onBeforeMount",
  "onMounted",
  "onBeforeUpdate",
  "onUpdated",
  "onBeforeUnmount",
  "onUnmounted",
  "onActivated",
  "onDeactivated",
  "onErrorCaptured",
  "onRenderTracked",
  "onRenderTriggered",
  "onServerPrefetch",
  "onBeforeRouteLeave",
  "onBeforeRouteUpdate",
]);

const CONTEXT_GUARDS = new Set([
  "getCurrentInstance",
  "getCurrentScope",
  "hasInjectionContext",
  "tryUseNuxtApp",
]);

// Nuxt resolves these through useNuxtApp(), so plugins, middleware and Nuxt's own
// non-composable utilities such as navigateTo() can call them outside component setup.
const APP_CONTEXT_ACCESSORS = new Set([
  "useNuxtApp",
  "useRuntimeConfig",
  "useAppConfig",
  "useRequestEvent",
  "useRequestURL",
  "useRequestHeaders",
  "useRequestHeader",
  "useRequestFetch",
  "useError",
  "useRouter",
  "useState",
  "useNuxtData",
  "useCookie",
]);

const VUE_API_SOURCES =
  /^(vue|vue-demi|vue-router|@vue\/(runtime-core|runtime-dom|composition-api)|#imports|#app(\/.*)?|nuxt\/app)$/;
const FRAMEWORK_SOURCES =
  /^(#|nuxt(\/|$)|vue(-|\/|$)|@vue\/|@vueuse\/|@nuxt\/|@nuxtjs\/|pinia|@pinia\/|@unhead\/|unhead)/;
const NON_COMPOSABLE_SOURCES = /^(@nuxt\/kit|nuxt\/kit|h3|nitropack|nitro|unstorage)(\/|$)/;
const PROJECT_SOURCES = /^(\.|~|@\/|@@\/|~~\/)/;

const PLAIN_GLOBALS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Number",
  "Object",
  "Promise",
  "RangeError",
  "RegExp",
  "String",
  "Symbol",
  "TypeError",
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "clearInterval",
  "clearTimeout",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "fetch",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "queueMicrotask",
  "setInterval",
  "setTimeout",
  "structuredClone",
]);

const TYPE_EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

export function nuxtSourceDirectory(ctx: RuleContext): "composables" | "utils" | null {
  const nuxt = ctx.project.nuxt;
  if (!nuxt) return null;
  const roots = new Set<string>([nuxt.appDir]);
  for (const layer of nuxt.layers ?? []) if (layer.srcDir) roots.add(layer.srcDir);
  for (const root of nuxt.appRoots ?? []) {
    roots.add(root);
    roots.add(resolve(root, "app"));
  }
  for (const root of roots) {
    const path = relative(resolve(ctx.project.root, root), ctx.file.path);
    if (path.startsWith("utils/")) return "utils";
    if (path.startsWith("composables/")) return "composables";
  }
  return null;
}

export function isAnalyzableScript(ctx: RuleContext) {
  return (
    !ctx.file.isVueSfc &&
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(ctx.file.path) &&
    !/\.d\.[cm]?ts$/.test(ctx.file.path)
  );
}

export function exportedFunctions(program: AnyNode): ExportedFunction[] {
  const locals = new Map<string, AnyNode>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id && declaration.body)
      locals.set(declaration.id.name, declaration);
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        const init = unwrapExpression(declarator.init);
        if (declarator.id?.type === "Identifier" && isFunctionNode(init))
          locals.set(declarator.id.name, init);
      }
    }
  }

  const exported: ExportedFunction[] = [];
  for (const statement of program.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = unwrapExpression(statement.declaration);
      const fn = isFunctionNode(declaration)
        ? declaration
        : declaration?.type === "Identifier"
          ? locals.get(declaration.name)
          : undefined;
      if (fn?.body)
        exported.push({
          name: fn.id?.name ?? "default",
          nameNode: fn.id ?? statement,
          fn,
          isDefault: true,
        });
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id && declaration.body) {
      exported.push({
        name: declaration.id.name,
        nameNode: declaration.id,
        fn: declaration,
        isDefault: false,
      });
    } else if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        const init = unwrapExpression(declarator.init);
        if (declarator.id?.type === "Identifier" && isFunctionNode(init))
          exported.push({
            name: declarator.id.name,
            nameNode: declarator.id,
            fn: init,
            isDefault: false,
          });
      }
    } else if (!declaration && !statement.source) {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.exportKind === "type") continue;
        const local = specifier.local?.name;
        const name = specifier.exported?.name ?? specifier.exported?.value;
        const fn = local ? locals.get(local) : undefined;
        if (!fn || !name) continue;
        exported.push({
          name,
          nameNode: localNameNode(fn) ?? specifier.exported,
          fn,
          isDefault: name === "default",
        });
      }
    }
  }
  return exported;
}

export function importSources(program: AnyNode): Map<string, string> {
  const sources = new Map<string, string>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.importKind === "type") continue;
      if (specifier.local?.name) sources.set(specifier.local.name, statement.source.value);
    }
  }
  return sources;
}

/**
 * Returns the API that binds the function to component setup, considering only calls in
 * the function's own body; nested callbacks run later and are not part of the contract.
 */
export function setupContextSignal(
  fn: AnyNode,
  imports: Map<string, string>,
  program: AnyNode,
): string | null {
  const lexical = lexicalBindings(program);
  const frameworkCall = (call: AnyNode) => {
    const name = calleeName(call);
    if (!name) return false;
    const binding = lexical.resolve(call, name);
    if (binding && !binding.type.startsWith("Import")) return false;
    const source = imports.get(name);
    return source === undefined || VUE_API_SOURCES.test(source);
  };
  const guardName = (expression: AnyNode): string | null => {
    const value = unwrapExpression(expression);
    if (value?.type === "CallExpression" && frameworkCall(value)) {
      const name = calleeName(value);
      return name && CONTEXT_GUARDS.has(name) ? name : null;
    }
    if (value?.type === "Identifier") {
      const binding = lexical.resolve(value, value.name);
      if (
        binding?.type === "VariableDeclarator" &&
        lexical.parents.get(binding)?.kind === "const"
      ) {
        const init = unwrapExpression(binding.init);
        if (init?.type === "CallExpression" && frameworkCall(init)) {
          const name = calleeName(init);
          return name && CONTEXT_GUARDS.has(name) ? name : null;
        }
      }
    }
    return null;
  };
  const provesContext = (expression: AnyNode, truthy: boolean): boolean => {
    const value = unwrapExpression(expression);
    if (!value) return false;
    if (value.type === "UnaryExpression" && value.operator === "!")
      return provesContext(value.argument, !truthy);
    if (value.type === "LogicalExpression" && ["&&", "||"].includes(value.operator)) {
      const left = provesContext(value.left, truthy);
      const right = provesContext(value.right, truthy);
      return (value.operator === "&&") === truthy ? left || right : left && right;
    }
    return truthy && guardName(value) !== null;
  };
  const protectedCall = (node: AnyNode) => {
    for (
      let child = node, parent = lexical.parents.get(child);
      parent && child !== fn;
      child = parent, parent = lexical.parents.get(child)
    ) {
      if (
        (parent.type === "IfStatement" || parent.type === "ConditionalExpression") &&
        ((child === parent.consequent && provesContext(parent.test, true)) ||
          (child === parent.alternate && provesContext(parent.test, false)))
      )
        return true;
      if (
        parent.type === "LogicalExpression" &&
        child === parent.right &&
        ((parent.operator === "&&" && provesContext(parent.left, true)) ||
          (parent.operator === "||" && provesContext(parent.left, false)))
      )
        return true;
      if (parent.type === "BlockStatement") {
        for (const previous of parent.body.slice(0, parent.body.indexOf(child))) {
          if (previous.type !== "IfStatement") continue;
          if (alwaysExits(previous.consequent) && provesContext(previous.test, false)) return true;
          if (alwaysExits(previous.alternate) && provesContext(previous.test, true)) return true;
        }
      }
    }
    return false;
  };
  let signal: string | null = null;
  walk(
    fn.body,
    { nested: false },
    (node) => {
      if (signal || protectedCall(node)) return;
      if (
        node.type === "MemberExpression" &&
        !node.optional &&
        guardName(node.object) === "getCurrentInstance"
      ) {
        signal = "getCurrentInstance";
        return;
      }
      if (node.type !== "CallExpression") return;
      const name = calleeName(node);
      if (!name) return;
      const binding = lexical.resolve(node, name);
      if (binding && !binding.type.startsWith("Import")) return;
      if (LIFECYCLE_HOOKS.has(name) || name === "inject" || name === "provide") {
        if (frameworkCall(node)) signal = name;
        return;
      }
      if (!/^use[A-Z0-9]/.test(name)) return;
      if (APP_CONTEXT_ACCESSORS.has(name) || /^use\w*Store$/.test(name)) return;
      const source = imports.get(name);
      if (source && NON_COMPOSABLE_SOURCES.test(source)) return;
      signal = name;
    },
    fn,
    "body",
  );
  return signal;
}

function alwaysExits(node: AnyNode): boolean {
  if (!node) return false;
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return true;
  if (node.type === "BlockStatement") return node.body.some(alwaysExits);
  if (node.type === "IfStatement")
    return alwaysExits(node.consequent) && alwaysExits(node.alternate);
  return false;
}

interface ModuleScope {
  imports: Map<string, string>;
  bindings: Map<string, AnyNode>;
  appAutoImports: Set<string>;
  results: Map<AnyNode, boolean>;
}

export function createModuleScope(ctx: RuleContext, program: AnyNode): ModuleScope {
  const bindings = new Map<string, AnyNode>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (
      (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
      declaration.id
    )
      bindings.set(declaration.id.name, declaration);
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? [])
        for (const name of patternNames(declarator.id)) bindings.set(name, declarator.init ?? null);
    }
  }
  const appAutoImports = new Set<string>();
  for (const entry of ctx.project.nuxt?.autoImportEntries ?? [])
    if (entry.kind === "app" || entry.kind === "layer") appAutoImports.add(entry.as ?? entry.name);
  return { imports: importSources(program), bindings, appAutoImports, results: new Map() };
}

/**
 * True when the function, including nested callbacks and module-level helpers it reaches,
 * may touch Vue or Nuxt APIs. Unknown globals count as API usage so only provably plain
 * helpers are reported.
 */
export function mayUseFrameworkApi(node: AnyNode, scope: ModuleScope): boolean {
  if (!node) return false;
  const known = scope.results.get(node);
  if (known !== undefined) return known;
  scope.results.set(node, false);
  const found = scanFrameworkApi(node, scope);
  scope.results.set(node, found);
  return found;
}

function scanFrameworkApi(node: AnyNode, scope: ModuleScope): boolean {
  const locals = lexicalBindings(node);
  let found = false;
  walk(node, { nested: true }, (current, parent, key) => {
    if (found) return;
    if (current.type !== "Identifier" || !isReference(parent, key)) return;
    const name = current.name;
    if (locals.resolve(current, name)) return;
    const called = parent?.type === "CallExpression" && key === "callee";
    if (scope.bindings.has(name)) {
      const binding = scope.bindings.get(name);
      if (binding?.type === "ClassDeclaration") return;
      if (mayUseFrameworkApi(binding, scope)) found = true;
      return;
    }
    const source = scope.imports.get(name);
    if (source !== undefined) {
      if (/^use[A-Z0-9]/.test(name) || FRAMEWORK_SOURCES.test(source)) found = true;
      else if (!called && PROJECT_SOURCES.test(source) && !/^[A-Z0-9_]+$/.test(name)) found = true;
      return;
    }
    if (!called) return;
    if (/^use[A-Z0-9]/.test(name)) found = true;
    else if (!PLAIN_GLOBALS.has(name) && !scope.appAutoImports.has(name)) found = true;
  });
  return found;
}

interface LexicalScope {
  parent?: LexicalScope;
  bindings: Map<string, AnyNode>;
  functionScope: boolean;
}

function lexicalBindings(root: AnyNode) {
  const scopes = new Map<AnyNode, LexicalScope>();
  const parents = new Map<AnyNode, AnyNode>();
  const outer: LexicalScope = { bindings: new Map(), functionScope: true };
  walk(root, { nested: true }, (node, parent) => {
    if (parent) parents.set(node, parent);
    const enclosing = scopes.get(parent) ?? outer;
    const functionScope = isFunctionNode(node) || node.type === "Program";
    const createsScope =
      functionScope ||
      [
        "BlockStatement",
        "CatchClause",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "SwitchStatement",
        "ClassBody",
      ].includes(node.type);
    const scope = createsScope
      ? { parent: enclosing, bindings: new Map<string, AnyNode>(), functionScope }
      : enclosing;
    scopes.set(node, scope);
    const bind = (pattern: AnyNode, target: LexicalScope, declaration: AnyNode) => {
      for (const name of patternNames(pattern)) target.bindings.set(name, declaration);
    };
    if (isFunctionNode(node)) {
      if (node.id) bind(node.id, node.type === "FunctionDeclaration" ? enclosing : scope, node);
      for (const param of node.params ?? []) bind(param, scope, param);
    }
    if (node.type === "VariableDeclarator") {
      let target = scope;
      if (parent?.kind === "var")
        while (!target.functionScope && target.parent) target = target.parent;
      bind(node.id, target, node);
    }
    if (node.type === "CatchClause") bind(node.param, scope, node);
    if (node.type === "ClassDeclaration") bind(node.id, enclosing, node);
    if (node.type.startsWith("Import") && node.local) bind(node.local, scope, node);
  });
  return {
    parents,
    resolve(node: AnyNode, name: string): AnyNode {
      for (let scope = scopes.get(node); scope; scope = scope.parent)
        if (scope.bindings.has(name)) return scope.bindings.get(name);
      return undefined;
    },
  };
}

function patternNames(pattern: AnyNode): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return patternNames(pattern.left);
  if (pattern.type === "RestElement") return patternNames(pattern.argument);
  if (pattern.type === "TSParameterProperty") return patternNames(pattern.parameter);
  if (pattern.type === "ObjectPattern")
    return (pattern.properties ?? []).flatMap((property: AnyNode) =>
      patternNames(property.value ?? property.argument),
    );
  if (pattern.type === "ArrayPattern")
    return (pattern.elements ?? []).flatMap((element: AnyNode) => patternNames(element));
  return [];
}

function isReference(parent: AnyNode, key: string | undefined) {
  if (!parent) return true;
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return false;
  if (
    (parent.type === "Property" || parent.type === "PropertyDefinition") &&
    key === "key" &&
    !parent.computed
  )
    return false;
  if (parent.type === "MethodDefinition" && key === "key" && !parent.computed) return false;
  if (key === "id" || key === "params" || key === "label") return false;
  if (parent.type === "VariableDeclarator" && key === "id") return false;
  return true;
}

export function calleeName(call: AnyNode): string | null {
  const callee = unwrapExpression(call.callee);
  return callee?.type === "Identifier" ? callee.name : null;
}

function walk(
  node: AnyNode,
  options: { nested: boolean },
  visit: (node: AnyNode, parent: AnyNode, key: string | undefined) => void,
  parent?: AnyNode,
  key?: string,
) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, options, visit, parent, key);
    return;
  }
  if (typeof node.type === "string") {
    if (node.type.startsWith("TS") && !TYPE_EXPRESSION_WRAPPERS.has(node.type)) return;
    visit(node, parent, key);
    if (!options.nested && parent && (isFunctionNode(node) || node.type === "ClassBody")) return;
  }
  for (const [childKey, value] of Object.entries(node)) {
    if (childKey === "__doctorParent" || childKey === "typeAnnotation") continue;
    if (childKey === "returnType" || childKey === "typeArguments" || childKey === "typeParameters")
      continue;
    if (value && typeof value === "object")
      walk(value, options, visit, typeof node.type === "string" ? node : parent, childKey);
  }
}

function localNameNode(fn: AnyNode): AnyNode {
  if (fn.id) return fn.id;
  const parent = fn.__doctorParent;
  return parent?.type === "VariableDeclarator" ? parent.id : null;
}

function isFunctionNode(node: AnyNode) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function unwrapExpression(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    (TYPE_EXPRESSION_WRAPPERS.has(current.type) ||
      current.type === "ParenthesizedExpression" ||
      current.type === "ChainExpression")
  )
    current = current.expression;
  return current;
}
