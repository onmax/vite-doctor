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
export function setupContextSignal(fn: AnyNode, imports: Map<string, string>): string | null {
  const calls: string[] = [];
  const tests: AnyNode[] = [];
  const guardBindings = new Set<string>();
  const memberObjects: AnyNode[] = [];
  walk(
    fn.body,
    { nested: false },
    (node) => {
      const name = node.type === "CallExpression" ? calleeName(node) : null;
      if (name) calls.push(name);
      if (node.type === "IfStatement" || node.type === "ConditionalExpression")
        tests.push(node.test);
      if (node.type === "LogicalExpression") tests.push(node.left);
      if (node.type === "UnaryExpression" && node.operator === "!") tests.push(node.argument);
      if (node.type === "MemberExpression" && !node.optional) memberObjects.push(node.object);
      if (
        node.type === "VariableDeclarator" &&
        node.id?.type === "Identifier" &&
        isGuardCall(unwrapExpression(node.init))
      )
        guardBindings.add(node.id.name);
    },
    fn,
    "body",
  );

  if (tests.some((test) => isGuardTest(test, guardBindings))) return null;

  const dereferencesInstance = memberObjects.some((object) => {
    const target = unwrapExpression(object);
    if (target?.type === "Identifier") return guardBindings.has(target.name);
    return target?.type === "CallExpression" && calleeName(target) === "getCurrentInstance";
  });

  for (const name of calls) {
    const source = imports.get(name);
    const fromVue = source === undefined || VUE_API_SOURCES.test(source);
    if (name === "getCurrentInstance") {
      if (dereferencesInstance && fromVue) return name;
      continue;
    }
    if (LIFECYCLE_HOOKS.has(name) || name === "inject" || name === "provide") {
      if (fromVue) return name;
      continue;
    }
    if (!/^use[A-Z0-9]/.test(name)) continue;
    if (APP_CONTEXT_ACCESSORS.has(name) || /^use\w*Store$/.test(name)) continue;
    if (source && NON_COMPOSABLE_SOURCES.test(source)) continue;
    return name;
  }
  return null;
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
  const locals = declaredNames(node);
  let found = false;
  walk(node, { nested: true }, (current, parent, key) => {
    if (found) return;
    if (current.type !== "Identifier" || !isReference(parent, key)) return;
    const name = current.name;
    if (locals.has(name)) return;
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

function declaredNames(root: AnyNode): Set<string> {
  const names = new Set<string>();
  walk(root, { nested: true }, (node) => {
    if (isFunctionNode(node)) {
      if (node !== root && node.id?.name) names.add(node.id.name);
      for (const param of node.params ?? [])
        for (const name of patternNames(param)) names.add(name);
    }
    if (node.type === "VariableDeclarator")
      for (const name of patternNames(node.id)) names.add(name);
    if (node.type === "CatchClause") for (const name of patternNames(node.param)) names.add(name);
    if (node.type === "ClassDeclaration" && node.id) names.add(node.id.name);
  });
  return names;
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

function isGuardCall(node: AnyNode) {
  return node?.type === "CallExpression" && CONTEXT_GUARDS.has(calleeName(node) ?? "");
}

function isGuardTest(test: AnyNode, guardBindings: Set<string>) {
  let guarded = false;
  walk(test, { nested: false }, (node) => {
    if (isGuardCall(node)) guarded = true;
    if (node.type === "Identifier" && guardBindings.has(node.name)) guarded = true;
  });
  return guarded;
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
