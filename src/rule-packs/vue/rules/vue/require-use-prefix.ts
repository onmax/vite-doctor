import { relative, resolve } from "pathe";
import { parseForESLint } from "@typescript-eslint/parser";
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
        const bindings = resolveBindings(ctx);
        if (!bindings) return;
        const isNuxt = Boolean(ctx.project.nuxt);
        for (const exported of exportedFunctions(node)) {
          if (isExemptName(exported.name)) continue;
          const signal = setupContextSignal(exported.fn, bindings, isNuxt);
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

type Variable = ReturnType<
  typeof parseForESLint
>["scopeManager"]["scopes"][number]["variables"][number];
type Bindings = Map<number, Variable | null>;

function offset(node: AnyNode): number {
  return node.range?.[0] ?? node.start;
}

function resolveBindings(ctx: RuleContext): Bindings | null {
  try {
    const { scopeManager } = parseForESLint(ctx.file.text, {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx: /\.[jt]sx$/.test(ctx.file.path) },
    });
    const bindings: Bindings = new Map();
    for (const scope of scopeManager.scopes)
      for (const reference of scope.references)
        bindings.set(offset(reference.identifier), reference.resolved);
    return bindings;
  } catch {
    return null;
  }
}

interface ApiIdentity {
  name: string;
  source?: string;
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
    return { name, source: definition.parent.source.value };
  }
  // Locally declared composables still carry the use convention; parameters and
  // local lookalikes of Vue's built-in APIs do not identify a framework API.
  if (
    !member &&
    /^use[A-Z0-9]/.test(identifier.name) &&
    variable.defs.some(
      (definition) =>
        definition.type === "FunctionName" ||
        (definition.type === "Variable" && isFunctionNode(unwrapExpression(definition.node.init))),
    )
  )
    return { name: identifier.name };
  return null;
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

function setupContextSignal(fn: AnyNode, bindings: Bindings, isNuxt: boolean): SetupSignal | null {
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
            !(source && NON_COMPOSABLE_SOURCES.test(source))
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
