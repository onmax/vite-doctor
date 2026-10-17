import { createRule, type RuleContext } from "../../../core/index.js";
import { walkScriptLocal, type AnyNode } from "../../../core/rule-authoring.js";
import { diagnostics } from "../diagnostics.js";
import { isClientOnlyPath, isRenderedTemplateName, isRuntimeAppFile } from "./nuxt/shared.js";

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
// still reaches the hydrating render. Effects only feed it when they assign state.
const RENDER_CALLBACKS = new Set(["computed", "reactiveComputed"]);
const EFFECT_CALLBACKS = new Set(["watchEffect", "watchSyncEffect"]);

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
    const shadowed: Array<{ name: string; scope: AnyNode }> = [];
    const calls: AnyNode[] = [];
    const identifiers: AnyNode[] = [];
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "@vueuse/core" || node.importKind === "type") {
          for (const specifier of node.specifiers ?? [])
            if (specifier.local?.name)
              shadowed.push({ name: specifier.local.name, scope: ownerFunction(node) });
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
          const name = String(specifier.imported?.name ?? specifier.imported?.value);
          if (name in STORAGE_COMPOSABLES) imported.set(specifier.local.name, name);
        }
      },
      CallExpression(node: AnyNode) {
        if (node.callee?.type === "Identifier") calls.push(node);
      },
      FunctionDeclaration(node: AnyNode) {
        if (node.id?.name) shadowed.push({ name: node.id.name, scope: ownerFunction(node) });
      },
      VariableDeclarator(node: AnyNode) {
        if (node.id?.type === "Identifier")
          shadowed.push({ name: node.id.name, scope: ownerFunction(node) });
      },
      Identifier(node: AnyNode) {
        identifiers.push(node);
      },
      "Program:exit"() {
        for (const call of calls) {
          const name = call.callee.name;
          const composable =
            imported.get(name) ??
            (isShadowedAtCall(name, call, shadowed)
              ? undefined
              : autoImportedComposable(ctx, name));
          if (!composable || !readsBrowserStorageOnSetup(ctx, call, composable)) continue;
          if (isInsideCallback(call, DEFERRED_CALLBACKS)) continue;
          if (isInsideDeferredFunction(call, calls)) continue;
          if (!reachesRender(ctx, call, identifiers)) continue;
          const storage = explicitBrowserStorage(ctx, call, composable);
          ctx.helpers.report(
            ctx,
            call,
            diagnostics.NUXT0085(
              storage
                ? {
                    why: `${composable}() receives ${storage}, which does not exist on the server, so server rendering throws before initOnMounted can defer the read.`,
                    fix: `Use ${storage === "sessionStorage" || storage === "window.sessionStorage" ? "useSessionStorage" : "useLocalStorage"}(key, value, { initOnMounted: true }), which only touches browser storage on the client, or use useCookie() for state the server must render.`,
                  }
                : {
                    why: `${composable}() reads browser storage while the component hydrates, but the server rendered the default value, so the stored value causes a hydration mismatch.`,
                    fix: `Pass { initOnMounted: true } to ${composable}() so it reads storage after mount, or use useCookie() for state the server must render.`,
                  },
            ),
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
  if (ctx.project.nuxt?.modules?.some((module) => module.name === "@vueuse/nuxt")) return true;
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  let owner: { root: string; packages: Record<string, string> } | undefined;
  for (const item of ctx.project.workspacePackages ?? []) {
    const inside = item.root === "." || path.startsWith(`${item.root}/`);
    if (inside && (!owner || item.root.length > owner.root.length)) owner = item;
  }
  return Boolean(owner && "@vueuse/nuxt" in owner.packages);
}

function readsBrowserStorageOnSetup(ctx: RuleContext, call: AnyNode, composable: string) {
  const shape = STORAGE_COMPOSABLES[composable]!;
  if (shape.storage !== undefined) {
    const storage = call.arguments?.[shape.storage];
    // With ssrHandlers enabled, @vueuse/nuxt backs the default storage of useStorage() with
    // cookies. Doctor cannot see that module option, so it skips the default storage there.
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

function reachesRender(
  ctx: RuleContext,
  call: AnyNode,
  identifiers: AnyNode[],
  depth = 0,
): boolean {
  const binding = boundIdentifier(call);
  if (!binding) return !isDiscarded(call);
  if (depth > 4) return false;
  const owner = ownerFunction(binding);
  if (owner?.type === "Program" && !ctx.file.relativePath.endsWith(".vue")) return true;
  if (owner?.type === "Program" && isRenderedTemplateName(ctx, binding.name)) return true;
  return identifiers.some(
    (identifier) =>
      identifier !== binding &&
      identifier.name === binding.name &&
      isReference(identifier) &&
      isWithin(identifier, owner) &&
      isRenderReference(ctx, identifier, owner, identifiers, depth),
  );
}

function explicitBrowserStorage(ctx: RuleContext, call: AnyNode, composable: string) {
  const index = STORAGE_COMPOSABLES[composable]!.storage;
  if (index === undefined) return undefined;
  const name = ctx.helpers.getNodeName(call.arguments?.[index]) ?? "";
  return BROWSER_STORAGES.has(name) ? name : undefined;
}

// A function such as `const init = () => useLocalStorage(...)` that the file only hands to
// onMounted() or another deferred callback runs after hydration.
function isInsideDeferredFunction(
  node: AnyNode,
  calls: AnyNode[],
  seen = new Set<string>(),
): boolean {
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (!isFunction(current)) continue;
    const name =
      current.type === "FunctionDeclaration"
        ? current.id?.name
        : current.__doctorParent?.type === "VariableDeclarator" &&
            current.__doctorParent.init === current
          ? current.__doctorParent.id?.name
          : undefined;
    if (!name) return false;
    if (seen.has(name)) return false;
    seen.add(name);
    const uses = calls.filter(
      (call) =>
        (call.callee?.type === "Identifier" && call.callee.name === name) ||
        call.arguments?.some(
          (argument: AnyNode) => argument.type === "Identifier" && argument.name === name,
        ),
    );
    if (!uses.length) return false;
    return uses.every((call) => {
      if (
        DEFERRED_CALLBACKS.has(calleeName(call)) &&
        call.arguments?.some(
          (argument: AnyNode) => argument.type === "Identifier" && argument.name === name,
        )
      )
        return true;
      if (isInsideCallback(call, DEFERRED_CALLBACKS)) return true;
      const caller = ownerFunction(call);
      if (!caller || caller.type === "Program") return false;
      return isInsideDeferredFunction(caller, calls, seen);
    });
  }
  return false;
}

function isDiscarded(call: AnyNode) {
  let current = call;
  while (WRAPPERS.has(current.__doctorParent?.type)) current = current.__doctorParent;
  return current.__doctorParent?.type === "ExpressionStatement";
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

function isRenderReference(
  ctx: RuleContext,
  identifier: AnyNode,
  owner: AnyNode,
  identifiers: AnyNode[],
  depth: number,
) {
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
    if (current.type === "CallExpression" && isConsoleCall(current)) return false;
    if (isFunction(current)) {
      const computed = computedCall(current);
      // A computed() is lazy, so its storage read only matters when the computed is rendered.
      if (computed) return reachesRender(ctx, computed, identifiers, depth + 1);
      if (!isRenderCallback(current, ctx, identifiers)) return false;
    }
    child = current;
  }
  return true;
}

function isConsoleCall(call: AnyNode) {
  const callee = unwrap(call.callee);
  return (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "console"
  );
}

function computedCall(fn: AnyNode): AnyNode {
  const parent = fn.__doctorParent;
  if (parent?.type === "CallExpression" && parent.arguments?.[0] === fn)
    return RENDER_CALLBACKS.has(calleeName(parent)) ? parent : undefined;
  if (parent?.type === "Property" && propertyName(parent) === "get" && parent.value === fn) {
    const object = parent.__doctorParent;
    const call = object?.__doctorParent;
    if (
      call?.type === "CallExpression" &&
      call.arguments?.[0] === object &&
      calleeName(call) === "computed"
    )
      return call;
  }
  return undefined;
}

function isRenderCallback(fn: AnyNode, ctx?: RuleContext, identifiers?: AnyNode[]) {
  const parent = fn.__doctorParent;
  return (
    parent?.type === "CallExpression" &&
    parent.arguments?.[0] === fn &&
    EFFECT_CALLBACKS.has(calleeName(parent)) &&
    assignsState(fn, ctx, identifiers)
  );
}

// Writes to `state.value` or `store.field` can feed the render; writes to plain locals cannot.
function assignsState(fn: AnyNode, ctx?: RuleContext, identifiers: AnyNode[] = []) {
  let assigns = false;
  walkScriptLocal(fn.body, (node) => {
    const target =
      node.type === "AssignmentExpression"
        ? node.left
        : node.type === "UpdateExpression"
          ? node.argument
          : undefined;
    const unwrapped = unwrap(target);
    if (unwrapped?.type === "MemberExpression") assigns = true;
    if (unwrapped?.type === "Identifier" && ctx && isRenderedTemplateName(ctx, unwrapped.name)) {
      const declaration = identifiers.find(
        (identifier) =>
          identifier.name === unwrapped.name &&
          identifier.__doctorParent?.type === "VariableDeclarator" &&
          identifier.__doctorParent.id === identifier,
      );
      if (declaration && !isWithin(declaration, fn)) assigns = true;
    }
  });
  return assigns;
}

function isShadowedAtCall(
  name: string,
  call: AnyNode,
  declarations: Array<{ name: string; scope: AnyNode }>,
) {
  return declarations.some(({ name: declared, scope }) => {
    if (declared !== name) return false;
    if (scope.type === "Program") return true;
    return isWithin(call, scope);
  });
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
