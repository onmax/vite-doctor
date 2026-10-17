import { createRule, type RuleContext } from "../../../core/index.js";
import { namePattern, type AnyNode } from "../../../core/rule-authoring.js";
import { diagnostics } from "../diagnostics.js";
import { isClientOnlyPath, isRuntimeAppFile } from "./nuxt/shared.js";

const RULE_ID = "vueuse/ssr/require-init-on-mounted-storage";

const STORAGE_COMPOSABLES: Record<string, { options: number; storage?: number }> = {
  useLocalStorage: { options: 2 },
  useSessionStorage: { options: 2 },
  useStorage: { options: 3, storage: 2 },
};

const BROWSER_STORAGES = new Set([
  "localStorage",
  "sessionStorage",
  "window.localStorage",
  "window.sessionStorage",
]);

// Callbacks that run during setup and feed rendered state, so a storage read inside them
// still reaches the hydrating render.
const RENDER_CALLBACKS = new Set([
  "computed",
  "watchEffect",
  "watchSyncEffect",
  "reactiveComputed",
]);

const DEFERRED_CALLBACKS = new Set([
  "onMounted",
  "onBeforeMount",
  "onActivated",
  "nextTick",
  "onNuxtReady",
]);

const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
  "ConditionalExpression",
  "LogicalExpression",
]);

const TEMPLATE_EVENT_RE_G = /(?:@|v-on:)[\w:-]+(?:\.[\w.]+)?\s*=\s*(["'])[\s\S]*?\1/g;

export const requireInitOnMountedStorage = createRule({
  meta: {
    id: RULE_ID,
    title: "Initialize VueUse browser storage on mount in SSR apps",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vueuse.org/core/useStorage/#initonmounted",
    requires: { script: true, nuxt: true },
    prefilter: { names: Object.keys(STORAGE_COMPOSABLES) },
  },
  create(ctx) {
    if (!ctx.project.ssr) return;
    if (!isRuntimeAppFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    const imported = new Map<string, string>();
    const calls: AnyNode[] = [];
    const identifiers: AnyNode[] = [];
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "@vueuse/core" || node.importKind === "type") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
          const name = String(specifier.imported?.name ?? specifier.imported?.value);
          if (name in STORAGE_COMPOSABLES) imported.set(specifier.local.name, name);
        }
      },
      CallExpression(node: AnyNode) {
        if (node.callee?.type === "Identifier") calls.push(node);
      },
      Identifier(node: AnyNode) {
        identifiers.push(node);
      },
      "Program:exit"() {
        for (const call of calls) {
          const composable =
            imported.get(call.callee.name) ?? autoImportedComposable(ctx, call.callee.name);
          if (!composable || !readsBrowserStorageOnSetup(ctx, call, composable)) continue;
          if (isInsideCallback(call, DEFERRED_CALLBACKS)) continue;
          if (!reachesRender(ctx, call, identifiers)) continue;
          ctx.helpers.report(
            ctx,
            call,
            diagnostics.NUXT0085({
              why: `${composable}() reads browser storage while the component hydrates, but the server rendered the default value, so the stored value causes a hydration mismatch.`,
              fix: `Pass { initOnMounted: true } to ${composable}() so it reads storage after mount, or use useCookie() for state the server must render.`,
            }),
            { ruleId: RULE_ID, severity: ctx.severity, category: "hydration" },
          );
        }
      },
    };
  },
});

function autoImportedComposable(ctx: RuleContext, name: string): string | undefined {
  if (name !== "useLocalStorage" && name !== "useSessionStorage") return undefined;
  const nuxt = ctx.project.nuxt;
  const entry = nuxt?.autoImports.get(name);
  if (entry) return entry.from === "@vueuse/core" ? name : undefined;
  if (nuxt?.autoImportsAuthoritative || nuxt?.autoImportEnabled === false) return undefined;
  return hasVueUseNuxt(ctx) ? name : undefined;
}

function hasVueUseNuxt(ctx: RuleContext) {
  return (
    ctx.project.nuxt?.modules?.some((module) => module.name === "@vueuse/nuxt") ||
    ctx.project.workspacePackages?.some((pkg) => "@vueuse/nuxt" in pkg.packages) ||
    false
  );
}

function readsBrowserStorageOnSetup(ctx: RuleContext, call: AnyNode, composable: string) {
  const shape = STORAGE_COMPOSABLES[composable]!;
  if (shape.storage !== undefined) {
    const storage = call.arguments?.[shape.storage];
    // @vueuse/nuxt replaces the default storage of useStorage() with cookies, which the server reads.
    if (!storage || isUndefined(storage)) {
      if (hasVueUseNuxt(ctx)) return false;
    } else if (!BROWSER_STORAGES.has(ctx.helpers.getNodeName(storage) ?? "")) return false;
  }
  if (call.arguments?.some((argument: AnyNode) => argument.type === "SpreadElement")) return false;
  const options = unwrap(call.arguments?.[shape.options]);
  if (!options || isUndefined(options)) return true;
  if (options.type !== "ObjectExpression") return false;
  let initOnMounted: AnyNode;
  for (const property of options.properties ?? []) {
    if (property.type !== "Property") return false;
    if (propertyName(property) === "initOnMounted") initOnMounted = unwrap(property.value);
  }
  if (!initOnMounted) return true;
  return initOnMounted.type === "Literal" && initOnMounted.value === false;
}

function reachesRender(ctx: RuleContext, call: AnyNode, identifiers: AnyNode[]) {
  const binding = boundIdentifier(call);
  if (!binding) return true;
  const owner = ownerFunction(binding);
  if (owner?.type === "Program" && !ctx.file.relativePath.endsWith(".vue")) return true;
  if (ctx.file.relativePath.endsWith(".vue") && owner?.type === "Program") {
    const descriptor = ctx.file.sfc?.descriptor as { template?: { content: string } } | undefined;
    const template = (descriptor?.template?.content ?? "").replace(TEMPLATE_EVENT_RE_G, "");
    if (namePattern([binding.name]).test(template)) return true;
  }
  return identifiers.some(
    (identifier) =>
      identifier !== binding &&
      identifier.name === binding.name &&
      isReference(identifier) &&
      isWithin(identifier, owner) &&
      isRenderReference(identifier, owner),
  );
}

function boundIdentifier(call: AnyNode): AnyNode {
  let current = call;
  let parent = current.__doctorParent;
  while (parent && WRAPPERS.has(parent.type) && parent.test !== current) {
    current = parent;
    parent = current.__doctorParent;
  }
  if (parent?.type === "AwaitExpression") return null;
  return parent?.type === "VariableDeclarator" &&
    parent.init === current &&
    parent.id?.type === "Identifier"
    ? parent.id
    : null;
}

function isRenderReference(identifier: AnyNode, owner: AnyNode) {
  const parent = identifier.__doctorParent;
  if (
    parent?.type === "MemberExpression" &&
    parent.object === identifier &&
    parent.__doctorParent?.type === "AssignmentExpression" &&
    parent.__doctorParent.operator === "=" &&
    parent.__doctorParent.left === parent
  )
    return false;
  let child = identifier;
  for (let current = parent; current && current !== owner; current = current.__doctorParent) {
    if (current.type === "CallExpression" && calleeName(current) === "watch") {
      if (current.arguments?.[0] === child) return false;
    }
    if (isFunction(current) && !isRenderCallback(current)) return false;
    child = current;
  }
  return true;
}

function isRenderCallback(fn: AnyNode) {
  const parent = fn.__doctorParent;
  if (parent?.type === "CallExpression" && parent.arguments?.[0] === fn)
    return RENDER_CALLBACKS.has(calleeName(parent));
  if (parent?.type === "Property" && propertyName(parent) === "get" && parent.value === fn) {
    const object = parent.__doctorParent;
    const call = object?.__doctorParent;
    return (
      call?.type === "CallExpression" &&
      call.arguments?.[0] === object &&
      calleeName(call) === "computed"
    );
  }
  return false;
}

function isInsideCallback(node: AnyNode, names: Set<string>) {
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (!isFunction(current)) continue;
    const parent = current.__doctorParent;
    if (parent?.type === "CallExpression" && parent.arguments?.includes(current)) {
      if (names.has(calleeName(parent))) return true;
      if (calleeName(parent) === "watch" && parent.arguments[0] !== current) return true;
    }
  }
  return false;
}

function isReference(identifier: AnyNode) {
  const parent = identifier.__doctorParent;
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === identifier && !parent.computed)
    return false;
  if (
    parent.type === "Property" &&
    parent.key === identifier &&
    !parent.computed &&
    !parent.shorthand
  )
    return false;
  if (parent.type === "VariableDeclarator" && parent.id === identifier) return false;
  if (parent.type.startsWith("TS")) return false;
  return true;
}

function ownerFunction(node: AnyNode): AnyNode {
  let current = node.__doctorParent;
  while (current && !isFunction(current) && current.type !== "Program")
    current = current.__doctorParent;
  return current;
}

function isWithin(node: AnyNode, ancestor: AnyNode) {
  for (let current = node; current; current = current.__doctorParent)
    if (current === ancestor) return true;
  return false;
}

function isFunction(node: AnyNode) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function calleeName(call: AnyNode): string {
  return call.callee?.type === "Identifier" ? call.callee.name : "";
}

function propertyName(property: AnyNode): string | undefined {
  if (property.computed) return undefined;
  return property.key?.type === "Identifier" ? property.key.name : property.key?.value;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "ParenthesizedExpression")
  )
    current = current.expression;
  return current;
}

function isUndefined(node: AnyNode) {
  return node.type === "Identifier" && node.name === "undefined";
}
