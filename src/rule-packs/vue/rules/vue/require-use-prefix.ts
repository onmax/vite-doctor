import { dirname, relative, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import {
  analyzeScript,
  fileScriptScope,
  type ScopeVariable,
  type ScriptScope,
} from "./script-scope.js";
import { AnyNode, createRule, namePattern, walkScriptLocal } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/composables/require-use-prefix";

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

const INJECTION_APIS = new Set(["inject", "provide"]);

const CONTEXT_GUARDS = new Set([
  "getCurrentInstance",
  "getCurrentScope",
  "hasInjectionContext",
  "tryUseNuxtApp",
]);

// These read app-level context that Nuxt also provides in plugins and middleware;
// Nuxt's own non-composable utilities such as navigateTo() call them.
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
]);

const NUXT_APP_CONTEXT_ACCESSORS = new Set(["useRouter", "useState", "useNuxtData", "useCookie"]);

const VUE_API_SOURCES =
  /^(vue|vue-demi|vue-router|@vue\/(runtime-core|runtime-dom|composition-api)|#imports|#app(\/.*)?|nuxt\/app)$/;
const NON_COMPOSABLE_SOURCES = /^(@nuxt\/kit|nuxt\/kit|h3|nitropack|nitro|unstorage)(\/|$)/;
const VUE_COMPOSABLE_SOURCES = /^(?:@vueuse\/|@pinia\/|pinia(?:\/|$)|vue-demi(?:\/|$))/;
// Unbound calls to these names come from auto-imports (unplugin-auto-import, Nuxt).
const VUE_RUNTIME_APIS = new Set([
  ...LIFECYCLE_HOOKS,
  ...INJECTION_APIS,
  "ref",
  "shallowRef",
  "computed",
  "reactive",
  "shallowReactive",
  "watch",
  "watchEffect",
  "onScopeDispose",
  "getCurrentInstance",
  "getCurrentScope",
  "toRef",
  "toRefs",
  "toValue",
]);
const EXEMPT_NAME =
  /^_*(use|on|tryOn|provide|inject|define|create|ref|computed|watch)[A-Z0-9_$]|^_*[A-Z]/;
const EXEMPT_NAMES = new Set(["setup", "render", "install"]);
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GET_CURRENT_INSTANCE = namePattern(["getCurrentInstance"]);

interface ExportedFunction {
  name: string;
  nameNode: AnyNode;
  fn: AnyNode;
}

interface SetupSignal {
  name: string;
}

export const requireUsePrefix = createRule({
  meta: {
    id: RULE_ID,
    title: "Name setup-bound composables with use",
    category: "composables",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/reusability/composables.html#conventions-and-best-practices",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (
      ctx.file.isVueSfc ||
      !SCRIPT_FILE.test(ctx.file.path) ||
      /\.d\.[cm]?ts$/.test(ctx.file.path)
    )
      return;
    if (/(^|\/)server\//.test(ctx.file.relativePath)) return;
    if (isNuxtUtilsFile(ctx)) return;

    return {
      Program(node: AnyNode) {
        const candidates = exportedFunctions(node).filter(
          (exported) => !isExemptName(exported.name),
        );
        if (candidates.length === 0 || !maySignalSetupContext(ctx, node, candidates)) return;
        const scope = fileScriptScope(ctx);
        if (!scope) return;
        const bindings = scopeBindings(scope);
        const isNuxt = Boolean(ctx.project.nuxt);
        const composable = composableEvidence(ctx, {
          file: ctx.file.path,
          program: scope.ast,
          bindings,
        });
        for (const exported of candidates) {
          const signal = setupContextSignal(exported.fn, bindings, isNuxt, composable);
          if (!signal) continue;
          const suggestion = `use${exported.name.replace(/^_+/, "").replace(/^./, (c) => c.toUpperCase())}`;
          ctx.report(
            diagnostics.VUE0026({
              why: `${exported.name}() calls ${signal.name}(), which only works during component setup or inside another composable, but its name does not start with "use".`,
              fix: `Rename ${exported.name} to a use-prefixed name such as ${suggestion} and update its callers so it is only called from setup or another composable.`,
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "composables",
              file: ctx.file.path,
              range: ctx.range(exported.nameNode),
            },
          );
        }
      },
    };
  },
});

// Every signal is a call whose callee is spelled, or imported, as a setup-bound API name, so
// files without one skip scope analysis. Like the scan, this reads only syntax, but it also
// enters nested functions, which keeps it a superset.
function maySignalSetupContext(
  ctx: RuleContext,
  program: AnyNode,
  candidates: ExportedFunction[],
): boolean {
  const imported = new Map<string, string[]>();
  const namespaces = new Set<string>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers ?? []) {
      const local = specifier.local?.name;
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local);
      else if (specifier.type === "ImportSpecifier")
        imported.set(local, [
          ...(imported.get(local) ?? []),
          specifier.imported?.name ?? specifier.imported?.value,
        ]);
    }
  }
  const calleeNames = (call: AnyNode): unknown[] => {
    const callee = unwrapExpression(call.callee);
    if (callee?.type === "Identifier") return [callee.name, ...(imported.get(callee.name) ?? [])];
    const object = callee?.type === "MemberExpression" ? unwrapExpression(callee.object) : null;
    if (object?.type !== "Identifier" || !namespaces.has(object.name)) return [];
    return [callee.property?.name, callee.property?.value];
  };
  const calls = (root: AnyNode, matches: (name: unknown) => boolean) => {
    let found = false;
    walkScriptLocal(root, (node) => {
      if (!found && node.type === "CallExpression") found = calleeNames(node).some(matches);
    });
    return found;
  };
  if (
    GET_CURRENT_INSTANCE.test(ctx.file.text) &&
    calls(program, (name) => name === "getCurrentInstance")
  )
    return true;
  const signalName = (name: unknown) =>
    typeof name === "string" &&
    (LIFECYCLE_HOOKS.has(name) || INJECTION_APIS.has(name) || /^use[A-Z0-9]/.test(name));
  return candidates.some((exported) => calls(exported.fn.body, signalName));
}

function isExemptName(name: string) {
  return EXEMPT_NAMES.has(name) || EXEMPT_NAME.test(name);
}

// Nuxt utils/ directories are owned by nuxt/structure/no-composable-in-utils, which
// reports the same function with a move-and-rename remediation.
function isNuxtUtilsFile(ctx: RuleContext) {
  return nuxtAppPaths(ctx, ctx.file.path).some((path) => path.startsWith("utils/"));
}

function nuxtAppPaths(ctx: RuleContext, file: string): string[] {
  const nuxt = ctx.project.nuxt;
  if (!nuxt) return [];
  const roots = new Set<string>([nuxt.appDir]);
  for (const layer of nuxt.layers ?? []) if (layer.srcDir) roots.add(layer.srcDir);
  for (const root of nuxt.appRoots ?? []) {
    roots.add(root);
    roots.add(resolve(root, "app"));
  }
  return [...roots]
    .map((root) => relative(resolve(ctx.project.root, root), file))
    .filter((path) => !path.startsWith(".."));
}

interface ModuleAnalysis {
  file: string;
  program: AnyNode;
  bindings: Bindings;
}

// A use* name is only a convention; the callee has to be a Vue composable for the caller to
// inherit setup-only semantics. Local definitions and local modules are traced for Vue calls,
// so a server-side API that happens to be named useX() is not one. Bare packages are not read.
function composableEvidence(ctx: RuleContext, current: ModuleAnalysis) {
  const nuxt = ctx.project.nuxt;
  const modules = new Map<string, ModuleAnalysis | null>();
  // Cycles resolve to false while their first visit is still in progress.
  const results = new Map<unknown, boolean>();
  const memo = (key: unknown, compute: () => boolean): boolean => {
    if (!results.has(key)) {
      results.set(key, false);
      results.set(key, compute());
    }
    return results.get(key)!;
  };

  function isComposable(api: ApiIdentity): boolean {
    if (api.fn) return usesVue(api.fn, current);
    if (!api.source)
      return !(
        nuxt?.autoImportEnabled &&
        nuxt.autoImportsAuthoritative &&
        !nuxt.autoImports.has(api.name)
      );
    const file = resolveLocalModule(ctx, dirname(current.file), api.source);
    return file === undefined || exportsComposable(file, api.exportName ?? api.name);
  }

  function usesVue(node: AnyNode, module: ModuleAnalysis): boolean {
    return memo(node, () => {
      let found = false;
      walkScriptLocal(node, (child) => {
        if (!found && child.type === "CallExpression") found = callUsesVue(child, module);
      });
      return found;
    });
  }

  function callUsesVue(call: AnyNode, module: ModuleAnalysis): boolean {
    const api = callIdentity(call, module.bindings);
    if (!api) {
      const callee = unwrapExpression(call.callee);
      const fn = callee?.type === "Identifier" && localFunction(callee, module.bindings);
      return Boolean(fn) && usesVue(fn, module);
    }
    if (api.fn) return usesVue(api.fn, module);
    if (!api.source)
      return (
        VUE_RUNTIME_APIS.has(api.name) ||
        Boolean(nuxt?.autoImportsAuthoritative && nuxt.autoImports.has(api.name))
      );
    return sourceUsesVue(api.source, api.exportName ?? api.name, module);
  }

  function sourceUsesVue(source: string, name: string, module: ModuleAnalysis): boolean {
    if (NON_COMPOSABLE_SOURCES.test(source)) return false;
    if (VUE_API_SOURCES.test(source) || VUE_COMPOSABLE_SOURCES.test(source)) return true;
    const file = resolveLocalModule(ctx, dirname(module.file), source);
    return file !== undefined && exportsComposable(file, name);
  }

  function exportsComposable(file: string, name: string): boolean {
    return memo(`${file}\0${name}`, () => moduleExportsComposable(file, name));
  }

  function moduleExportsComposable(file: string, name: string): boolean {
    // Nuxt's composables directory is auto-imported. Other app directories (plugins,
    // utils, pages, and so on) are not composable evidence by location alone.
    if (nuxtAppPaths(ctx, file).some((path) => path.startsWith("composables/"))) return true;
    const module = analyzeModule(file);
    if (!module) return false;
    const definition = exportedDefinition(module.program, name);
    if (definition) return usesVue(definition, module);
    for (const statement of module.program.body ?? []) {
      if (!statement.source || statement.exportKind === "type") continue;
      if (statement.type === "ExportAllDeclaration" && !statement.exported) {
        if (sourceUsesVue(statement.source.value, name, module)) return true;
      } else if (statement.type === "ExportNamedDeclaration") {
        const specifier = (statement.specifiers ?? []).find(
          (candidate: AnyNode) =>
            candidate.exportKind !== "type" && moduleExportName(candidate.exported) === name,
        );
        if (specifier)
          return sourceUsesVue(statement.source.value, moduleExportName(specifier.local), module);
      }
    }
    return false;
  }

  function analyzeModule(file: string): ModuleAnalysis | null {
    if (!modules.has(file)) {
      const text = ctx.fs.readText(file);
      const scope = text === undefined ? null : analyzeScript(text, /\.[jt]sx$/.test(file));
      modules.set(
        file,
        scope ? { file, program: scope.ast, bindings: scopeBindings(scope) } : null,
      );
    }
    return modules.get(file)!;
  }

  return isComposable;
}

function exportedDefinition(program: AnyNode, name: string): AnyNode {
  const declarations = new Map<string, AnyNode>();
  let definition: AnyNode;
  for (const statement of program.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      if (name === "default") definition = statement.declaration;
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id)
      declarations.set(declaration.id.name, declaration);
    if (declaration?.type === "VariableDeclaration")
      for (const declarator of declaration.declarations ?? [])
        for (const declared of patternNames(declarator.id))
          if (declarator.init) declarations.set(declared, declarator.init);
    if (statement.type === "ExportNamedDeclaration" && !statement.source) {
      if (declaredNames(statement.declaration).includes(name))
        definition = { type: "Identifier", name };
      for (const specifier of statement.specifiers ?? [])
        if (moduleExportName(specifier.exported) === name)
          definition = { type: "Identifier", name: moduleExportName(specifier.local) };
    }
  }
  // `export default useWorkspace` and `export const { useWorkspace } = composables` name a
  // local binding, so follow it to the code that defines it.
  const followed = new Set<string>();
  while (definition?.type === "Identifier" && !followed.has(definition.name)) {
    followed.add(definition.name);
    definition = declarations.get(definition.name);
  }
  return definition;
}

function declaredNames(declaration: AnyNode): string[] {
  if (declaration?.type === "FunctionDeclaration")
    return declaration.id ? [declaration.id.name] : [];
  if (declaration?.type !== "VariableDeclaration") return [];
  return (declaration.declarations ?? []).flatMap((declarator: AnyNode) =>
    patternNames(declarator.id),
  );
}

// `export const [provideCounter, useCounter] = createInjectionState(...)` exports both names.
function patternNames(pattern: AnyNode): string[] {
  if (pattern?.type === "Identifier") return [pattern.name];
  if (pattern?.type === "ArrayPattern") return (pattern.elements ?? []).flatMap(patternNames);
  if (pattern?.type === "ObjectPattern")
    return (pattern.properties ?? []).flatMap((property: AnyNode) =>
      patternNames(property.type === "RestElement" ? property.argument : property.value),
    );
  if (pattern?.type === "AssignmentPattern") return patternNames(pattern.left);
  if (pattern?.type === "RestElement") return patternNames(pattern.argument);
  return [];
}

function moduleExportName(node: AnyNode): string {
  return node?.type === "Identifier" ? node.name : node?.value;
}

function localFunction(identifier: AnyNode, bindings: Bindings): AnyNode {
  const variable = bindings.get(offset(identifier));
  for (const definition of variable?.defs ?? []) {
    if (definition.type === "FunctionName") return definition.node;
    const init = definition.type === "Variable" ? unwrapExpression(definition.node.init) : null;
    if (isFunctionNode(init)) return init;
  }
  return undefined;
}

function resolveLocalModule(ctx: RuleContext, from: string, source: string): string | undefined {
  const nuxt = ctx.project.nuxt;
  const base = source.startsWith(".")
    ? resolve(from, source)
    : nuxt && /^(~~|@@)\//.test(source)
      ? resolve(ctx.project.root, source.slice(3))
      : nuxt && /^[~@]\//.test(source)
        ? resolve(ctx.project.root, nuxt.appDir, source.slice(2))
        : undefined;
  if (!base) return;
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].map((extension) => `${stem}${extension}`),
    ...["/index.ts", "/index.js"].map((index) => `${base}${index}`),
  ];
  return candidates.find(
    (candidate) => SCRIPT_FILE.test(candidate) && ctx.fs.stat(candidate)?.isFile(),
  );
}

function exportedFunctions(program: AnyNode): ExportedFunction[] {
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
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id && declaration.body) {
      exported.push({ name: declaration.id.name, nameNode: declaration.id, fn: declaration });
    } else if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? []) {
        const init = unwrapExpression(declarator.init);
        if (declarator.id?.type === "Identifier" && isFunctionNode(init))
          exported.push({ name: declarator.id.name, nameNode: declarator.id, fn: init });
      }
    } else if (!declaration && !statement.source) {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.exportKind === "type") continue;
        const local = specifier.local?.name;
        const name = specifier.exported?.name ?? specifier.exported?.value;
        const fn = local ? locals.get(local) : undefined;
        if (fn && name && name !== "default")
          exported.push({ name, nameNode: localNameNode(fn) ?? specifier.exported, fn });
      }
    }
  }
  return exported;
}

function localNameNode(fn: AnyNode): AnyNode {
  if (fn.id) return fn.id;
  const parent = fn.__doctorParent;
  return parent?.type === "VariableDeclarator" ? parent.id : null;
}

type Bindings = Map<number, ScopeVariable | null>;

function offset(node: AnyNode): number {
  return node.range?.[0] ?? node.start;
}

function scopeBindings(scope: ScriptScope): Bindings {
  const bindings: Bindings = new Map();
  for (const { references } of scope.scopeManager.scopes)
    for (const reference of references)
      bindings.set(offset(reference.identifier), reference.resolved);
  return bindings;
}

interface ApiIdentity {
  name: string;
  source?: string;
  /** The name the source module exports, when it differs from `name` (default imports). */
  exportName?: string;
  /** The local function definition of a use* call. */
  fn?: AnyNode;
}

function callIdentity(call: AnyNode, bindings: Bindings): ApiIdentity | null {
  const callee = unwrapExpression(call.callee);
  const member = callee?.type === "MemberExpression";
  const identifier = member ? unwrapExpression(callee.object) : callee;
  if (identifier?.type !== "Identifier") return null;
  const variable = bindings.get(offset(identifier));
  if (!variable) return member ? null : { name: identifier.name };
  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding" || definition.parent.type !== "ImportDeclaration")
      continue;
    const specifier = definition.node;
    if (specifier.type === "ImportNamespaceSpecifier") {
      if (!member) return null;
      const name = callee.computed ? callee.property.value : callee.property.name;
      return typeof name === "string" ? { name, source: definition.parent.source.value } : null;
    }
    if (member) return null;
    const name =
      specifier.type === "ImportSpecifier"
        ? specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value
        : identifier.name;
    return {
      name,
      source: definition.parent.source.value,
      ...(specifier.type === "ImportDefaultSpecifier" && { exportName: "default" }),
    };
  }
  // Locally declared composables still carry the use convention; parameters and
  // local lookalikes of Vue's built-in APIs do not identify a framework API.
  if (member || !/^use[A-Z0-9]/.test(identifier.name)) return null;
  const fn = localFunction(identifier, bindings);
  return fn ? { name: identifier.name, fn } : null;
}

function guardName(node: AnyNode, bindings: Bindings): string | null {
  const target = unwrapExpression(node);
  if (target?.type === "Identifier") {
    const variable = bindings.get(offset(target));
    if (
      !variable ||
      variable.references.some((reference) => reference.isWrite() && !reference.init)
    )
      return null;
    const definition = variable.defs[0];
    if (definition?.type !== "Variable" || definition.parent.kind !== "const") return null;
    const init = unwrapExpression(definition.node.init);
    if (init?.type !== "CallExpression") return null;
    return guardName(init, bindings);
  }
  if (target?.type !== "CallExpression") return null;
  const api = callIdentity(target, bindings);
  return api && CONTEXT_GUARDS.has(api.name) && isVueSource(api.source) ? api.name : null;
}

function guaranteesContext(test: AnyNode, truth: boolean, bindings: Bindings): boolean {
  const node = unwrapExpression(test);
  if (!node) return false;
  if (node.type === "UnaryExpression" && node.operator === "!")
    return guaranteesContext(node.argument, !truth, bindings);
  if (node.type === "LogicalExpression" && ["&&", "||"].includes(node.operator)) {
    const left = guaranteesContext(node.left, truth, bindings);
    const right = guaranteesContext(node.right, truth, bindings);
    return (node.operator === "&&") === truth ? left || right : left && right;
  }
  if (node.type === "BinaryExpression" && ["==", "!=", "===", "!=="].includes(node.operator)) {
    const literal = node.left.type === "Literal" ? node.left : node.right;
    const value = literal === node.left ? node.right : node.left;
    const name = guardName(value, bindings);
    if (!name || literal.type !== "Literal") return false;
    const equal = node.operator === "==" || node.operator === "===";
    if (
      literal.value === null &&
      name !== "hasInjectionContext" &&
      (node.operator.length === 2 || name === "getCurrentInstance")
    )
      return truth !== equal;
    if (typeof literal.value === "boolean" && name === "hasInjectionContext")
      return truth === (equal === literal.value);
  }
  return truth && guardName(node, bindings) !== null;
}

function setupContextSignal(
  fn: AnyNode,
  bindings: Bindings,
  isNuxt: boolean,
  composable: (api: ApiIdentity) => boolean,
): SetupSignal | null {
  let signal: SetupSignal | null = null;
  // null means the path exits; only facts shared by all surviving paths carry on.
  function scan(node: AnyNode, guarded: boolean): boolean | null {
    if (!node || typeof node !== "object") return guarded;
    if (Array.isArray(node)) {
      let state: boolean | null = guarded;
      for (const child of node) {
        if (state === null) break;
        state = scan(child, state);
      }
      return state;
    }
    if (isTypeOnlyNode(node) || isFunctionNode(node) || node.type === "ClassBody") return guarded;
    if (node.type === "BlockStatement") return scan(node.body, guarded);
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      scan(node.test, guarded);
      const positive = scan(
        node.consequent,
        guarded || guaranteesContext(node.test, true, bindings),
      );
      const negative = scan(
        node.alternate,
        guarded || guaranteesContext(node.test, false, bindings),
      );
      return positive === null ? negative : negative === null ? positive : positive && negative;
    }
    if (node.type === "WhileStatement" || node.type === "ForStatement") {
      scan(node.init, guarded);
      scan(node.test, guarded);
      const inLoop = guarded || guaranteesContext(node.test, true, bindings);
      scan(node.body, inLoop);
      scan(node.update, inLoop);
      return guarded;
    }
    if (node.type === "LogicalExpression") {
      scan(node.left, guarded);
      scan(
        node.right,
        guarded ||
          (node.operator !== "??" &&
            guaranteesContext(node.left, node.operator === "&&", bindings)),
      );
      return guarded;
    }
    if (!guarded && !signal) {
      if (
        node.type === "MemberExpression" &&
        !node.optional &&
        guardName(node.object, bindings) === "getCurrentInstance"
      )
        signal = { name: "getCurrentInstance" };
      if (node.type === "CallExpression") {
        const api = callIdentity(node, bindings);
        if (api) {
          const { name, source } = api;
          if ((LIFECYCLE_HOOKS.has(name) || INJECTION_APIS.has(name)) && isVueSource(source))
            signal = { name };
          if (
            /^use[A-Z0-9]/.test(name) &&
            !APP_CONTEXT_ACCESSORS.has(name) &&
            !/^use\w*Store$/.test(name) &&
            !(
              isNuxt &&
              NUXT_APP_CONTEXT_ACCESSORS.has(name) &&
              isVueSource(source) &&
              source !== "vue-router"
            ) &&
            !(source && NON_COMPOSABLE_SOURCES.test(source)) &&
            composable(api)
          )
            signal = { name };
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        [
          "__doctorParent",
          "typeAnnotation",
          "returnType",
          "typeArguments",
          "typeParameters",
        ].includes(key)
      )
        continue;
      if (value && typeof value === "object") scan(value, guarded);
    }
    return ["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(
      node.type,
    )
      ? null
      : guarded;
  }
  scan(fn.body, false);
  return signal;
}

function isVueSource(source: string | undefined) {
  return source === undefined || VUE_API_SOURCES.test(source);
}

function isTypeOnlyNode(node: AnyNode) {
  return (
    typeof node.type === "string" &&
    node.type.startsWith("TS") &&
    ![
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "TSInstantiationExpression",
    ].includes(node.type)
  );
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
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(current.type)
  )
    current = current.expression;
  return current;
}
