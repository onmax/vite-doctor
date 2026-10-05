import { relative, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule } from "./shared.js";
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
const EXEMPT_NAME =
  /^_*(use|on|tryOn|provide|inject|define|create|ref|computed|watch)[A-Z0-9_$]|^_*[A-Z]/;
const EXEMPT_NAMES = new Set(["setup", "render", "install"]);
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

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
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const imports = importSources(node);
        const isNuxt = Boolean(ctx.project.nuxt);
        for (const exported of exportedFunctions(node)) {
          if (isExemptName(exported.name)) continue;
          const signal = setupContextSignal(exported.fn, imports, isNuxt);
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

function isExemptName(name: string) {
  return EXEMPT_NAMES.has(name) || EXEMPT_NAME.test(name);
}

// Nuxt utils/ directories are owned by nuxt/structure/no-composable-in-utils, which
// reports the same function with a move-and-rename remediation.
function isNuxtUtilsFile(ctx: RuleContext) {
  const nuxt = ctx.project.nuxt;
  if (!nuxt) return false;
  const roots = new Set<string>([nuxt.appDir]);
  for (const layer of nuxt.layers ?? []) if (layer.srcDir) roots.add(layer.srcDir);
  for (const root of nuxt.appRoots ?? []) {
    roots.add(root);
    roots.add(resolve(root, "app"));
  }
  return [...roots].some((root) => {
    const path = relative(resolve(ctx.project.root, root), ctx.file.path);
    return path.startsWith("utils/");
  });
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

function importSources(program: AnyNode): Map<string, string> {
  const sources = new Map<string, string>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const specifier of statement.specifiers ?? [])
      if (specifier.local?.name) sources.set(specifier.local.name, statement.source.value);
  }
  return sources;
}

function setupContextSignal(
  fn: AnyNode,
  imports: Map<string, string>,
  isNuxt: boolean,
): SetupSignal | null {
  const calls: string[] = [];
  const tests: AnyNode[] = [];
  const guardBindings = new Set<string>();
  const memberObjects: AnyNode[] = [];
  walkOwnBody(fn.body, (node) => {
    const name = node.type === "CallExpression" ? calleeName(node) : null;
    if (name) calls.push(name);
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") tests.push(node.test);
    if (node.type === "LogicalExpression") tests.push(node.left);
    if (node.type === "UnaryExpression" && node.operator === "!") tests.push(node.argument);
    if (node.type === "MemberExpression" && !node.optional) memberObjects.push(node.object);
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      isGuardCall(unwrapExpression(node.init))
    )
      guardBindings.add(node.id.name);
  });

  if (tests.some((test) => isGuardTest(test, guardBindings))) return null;

  // getCurrentInstance() returns null outside setup; it only binds the caller to setup
  // when the instance is dereferenced without a guard.
  const dereferencesInstance = memberObjects.some((object) => {
    const target = unwrapExpression(object);
    if (target?.type === "Identifier") return guardBindings.has(target.name);
    return target?.type === "CallExpression" && calleeName(target) === "getCurrentInstance";
  });

  for (const name of calls) {
    const source = imports.get(name);
    if (name === "getCurrentInstance") {
      if (dereferencesInstance && isVueSource(source)) return { name };
      continue;
    }
    if (LIFECYCLE_HOOKS.has(name) || INJECTION_APIS.has(name)) {
      if (isVueSource(source)) return { name };
      continue;
    }
    if (!/^use[A-Z0-9]/.test(name)) continue;
    if (APP_CONTEXT_ACCESSORS.has(name) || /^use\w*Store$/.test(name)) continue;
    if (isNuxt && NUXT_APP_CONTEXT_ACCESSORS.has(name)) continue;
    if (source && NON_COMPOSABLE_SOURCES.test(source)) continue;
    return { name };
  }
  return null;
}

function isVueSource(source: string | undefined) {
  return source === undefined || VUE_API_SOURCES.test(source);
}

function calleeName(call: AnyNode): string | null {
  const callee = unwrapExpression(call.callee);
  return callee?.type === "Identifier" ? callee.name : null;
}

function isGuardCall(node: AnyNode) {
  return node?.type === "CallExpression" && CONTEXT_GUARDS.has(calleeName(node) ?? "");
}

function isGuardTest(test: AnyNode, guardBindings: Set<string>) {
  let guarded = false;
  walkOwnBody(test, (node) => {
    if (isGuardCall(node)) guarded = true;
    if (node.type === "Identifier" && guardBindings.has(node.name)) guarded = true;
  });
  return guarded;
}

function walkOwnBody(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkOwnBody(child, visit);
    return;
  }
  if (typeof node.type === "string") {
    if (isTypeOnlyNode(node)) return;
    visit(node);
    if (isFunctionNode(node) || node.type === "ClassBody") return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "typeAnnotation" || key === "returnType") continue;
    if (key === "typeArguments" || key === "typeParameters") continue;
    if (value && typeof value === "object") walkOwnBody(value, visit);
  }
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
