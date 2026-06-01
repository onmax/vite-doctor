import { AnyNode, bindingNames, createRule, report, walkScriptLocal } from "./shared.js";
import type { RuleContext } from "../../../../core/index.js";

const RULE_ID = "vue/lifecycle/prefer-use-event-listener";
const WATCH_CALLBACK_CALLEES = new Set(["watch"]);
const WATCH_EFFECT_CALLBACK_CALLEES = new Set([
  "watchEffect",
  "watchPostEffect",
  "watchSyncEffect",
]);
const LIFECYCLE_CLEANUP_CALLEES = new Set(["onBeforeUnmount", "onScopeDispose", "onUnmounted"]);

export const preferUseEventListener = createRule({
  meta: {
    id: RULE_ID,
    title: "Prefer VueUse event listener cleanup",
    category: "lifecycle",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vueuse.org/core/useeventlistener/",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!projectHasVueUse(ctx)) return;
    if (ctx.project.framework === "nuxt" && !isNuxtVueRuntimePath(ctx.file.relativePath)) return;

    return {
      ScriptNode(node: AnyNode) {
        if (!isAddEventListenerCall(node, ctx.helpers.getCalleeName(node))) return;
        const owner = manualListenerOwner(node, ctx.file.text);
        if (!owner) return;
        if (nodeSource(owner, ctx.file.text).includes("useEventListener")) return;

        report(
          ctx,
          node,
          RULE_ID,
          "warn",
          "lifecycle",
          "This Vue scope manually pairs addEventListener() with cleanup even though VueUse is available.",
          "Use useEventListener() so listener disposal is bound to the Vue scope; keep the returned stop handle in watcher cleanup when the listener lifetime is per watcher run.",
        );
      },
    };
  },
});

function projectHasVueUse(ctx: RuleContext) {
  const pkg = ctx.getJson<any>("package.json");
  const deps = {
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
    ...pkg?.optionalDependencies,
    ...pkg?.peerDependencies,
  };
  if (deps["@vueuse/core"] || deps["@vueuse/nuxt"]) return true;
  return (ctx.project.nuxt?.modules ?? []).some((module) =>
    ["@vueuse/core", "@vueuse/nuxt"].includes(module.name),
  );
}

function manualListenerOwner(addCall: AnyNode, source: string) {
  for (let current = addCall.__doctorParent; current; current = current.__doctorParent) {
    if (!isFunctionLike(current) && current.type !== "Program") continue;

    if (isFunctionLike(current)) {
      const watcherCleanupNames = watcherCleanupCallees(current);
      if (watcherCleanupNames && hasListenerCleanup(current, watcherCleanupNames, source))
        return current;
    }

    if (hasListenerCleanup(current, LIFECYCLE_CLEANUP_CALLEES, source)) return current;
  }

  return null;
}

function watcherCleanupCallees(functionNode: AnyNode): Set<string> | null {
  const call = functionNode.__doctorParent;
  if (call?.type !== "CallExpression") return null;
  const name = calleeName(call);
  const args = call.arguments ?? [];

  if (name && WATCH_CALLBACK_CALLEES.has(name) && args[1] === functionNode) {
    return new Set(["onWatcherCleanup", ...bindingNames(functionNode.params?.[2])]);
  }

  if (name && WATCH_EFFECT_CALLBACK_CALLEES.has(name) && args[0] === functionNode) {
    return new Set(["onWatcherCleanup", ...bindingNames(functionNode.params?.[0])]);
  }

  return null;
}

function hasListenerCleanup(scope: AnyNode, cleanupCallees: Set<string>, source: string) {
  if (!cleanupCallees.size) return false;
  let found = false;
  walkScriptLocal(scope, (node) => {
    if (found || node.type !== "CallExpression") return;
    const name = calleeName(node);
    if (!name || !matchesCallee(name, cleanupCallees)) return;
    const cleanupSource = nodeSource(node.arguments?.[0] ?? node, source);
    found =
      cleanupSource.includes("removeEventListener") ||
      nodeSource(scope, source).includes("removeEventListener");
  });
  return found;
}

function isAddEventListenerCall(node: AnyNode, name: string | null) {
  return (
    node.type === "CallExpression" && !!name && matchesCallee(name, new Set(["addEventListener"]))
  );
}

function matchesCallee(name: string, callees: Set<string>) {
  for (const callee of callees) {
    if (name === callee || name.endsWith(`.${callee}`)) return true;
  }
  return false;
}

function calleeName(node: AnyNode): string | null {
  return nodeName(node?.callee);
}

function nodeName(node: AnyNode): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  if (node.type === "StaticMemberExpression" || node.type === "MemberExpression") {
    const object = nodeName(node.object);
    const property = nodeName(node.property);
    return object && property ? `${object}.${property}` : (object ?? property);
  }
  return null;
}

function nodeSource(node: AnyNode, source: string) {
  const start = node?.start ?? node?.range?.[0];
  const end = node?.end ?? node?.range?.[1];
  return typeof start === "number" && typeof end === "number" ? source.slice(start, end) : "";
}

function isFunctionLike(node: AnyNode) {
  return ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(
    node?.type,
  );
}

function isNuxtVueRuntimePath(path: string) {
  if (
    path.includes(".client.") ||
    /\.(md|mdc|markdown)$/.test(path) ||
    /^(content|server|app\/server|shared\/types|generated|app\/generated)\//.test(path)
  )
    return false;
  return /^(app\/)?(components|composables|layouts|middleware|pages|plugins|utils)\//.test(path);
}
