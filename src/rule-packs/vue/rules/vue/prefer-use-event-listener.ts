import { relative } from "pathe";
import { AnyNode, bindingNames, createRule, report } from "./shared.js";
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
    if (ctx.project.framework === "nuxt" && !isNuxtVueRuntimePath(ctx)) return;

    return {
      ScriptNode(node: AnyNode) {
        if (!isAddEventListenerCall(node, ctx.helpers.getCalleeName(node))) return;
        const owner = manualListenerOwner(node, ctx.file.text);
        if (!owner) return;

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
  walkScope(scope, (node) => {
    if (found || node.type !== "CallExpression") return;
    const name = calleeName(node);
    if (!name || !matchesCallee(name, cleanupCallees)) return;
    found = hasListenerCleanupArgument(scope, node.arguments?.[0], source);
  });
  return found;
}

function hasListenerCleanupArgument(scope: AnyNode, argument: AnyNode, source: string) {
  if (nodeSource(argument, source).includes("removeEventListener")) return true;
  const referencedCleanup = referencedFunction(scope, argument);
  return referencedCleanup ? hasRemoveEventListenerCall(referencedCleanup) : false;
}

function referencedFunction(scope: AnyNode, argument: AnyNode) {
  const name = argument?.type === "Identifier" ? argument.name : null;
  if (!name) return null;

  let found: AnyNode = null;
  walkScope(scope, (node) => {
    if (found) return;
    if (node.type === "FunctionDeclaration" && node.id?.name === name) {
      found = node;
      return;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.id.name === name
    ) {
      found = isFunctionLike(node.init) ? node.init : null;
    }
  });
  return found;
}

function hasRemoveEventListenerCall(scope: AnyNode) {
  let found = false;
  walkScope(scope, (node) => {
    if (found || node.type !== "CallExpression") return;
    const name = calleeName(node);
    found = !!name && matchesCallee(name, new Set(["removeEventListener"]));
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

function walkScope(node: AnyNode, visit: (node: AnyNode) => void, root = node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkScope(child, visit, root);
    return;
  }
  if (typeof node.type === "string") visit(node);
  if (node !== root && isFunctionLike(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkScope(child, visit, root);
    } else if (value && typeof value === "object") {
      walkScope(value, visit, root);
    }
  }
}

function isNuxtVueRuntimePath(ctx: RuleContext) {
  for (const candidate of nuxtRuntimePathCandidates(ctx)) {
    if (isNuxtVueRuntimeCandidate(candidate)) return true;
  }
  return false;
}

function nuxtRuntimePathCandidates(ctx: RuleContext) {
  const path = toPosixPath(ctx.file.relativePath);
  const candidates = new Set([path]);
  for (const root of nuxtRuntimeRoots(ctx)) {
    const relativeRoot = relativeProjectPath(ctx, root);
    if (!relativeRoot || relativeRoot === ".") continue;
    if (path === relativeRoot) candidates.add("");
    else if (path.startsWith(`${relativeRoot}/`)) {
      candidates.add(path.slice(relativeRoot.length + 1));
    }
  }
  return candidates;
}

function nuxtRuntimeRoots(ctx: RuleContext) {
  const nuxt = ctx.project.nuxt;
  return [nuxt?.appDir, ...(nuxt?.appRoots ?? []), ...(nuxt?.manifest?.appScanRoots ?? [])].filter(
    (root): root is string => Boolean(root),
  );
}

function relativeProjectPath(ctx: RuleContext, root: string) {
  const projectRoot = toPosixPath(ctx.project.root);
  let normalized = toPosixPath(root);
  if (normalized === projectRoot) return ".";
  const projectPrefix = `${projectRoot}/`;
  if (normalized.startsWith(projectPrefix)) normalized = normalized.slice(projectPrefix.length);
  else normalized = toPosixPath(relative(ctx.project.root, normalized));
  return normalized.replace(/^~\//, "app/").replace(/^@\//, "app/").replace(/^\.\//, "");
}

function isNuxtVueRuntimeCandidate(path: string) {
  if (
    /\.(md|mdc|markdown)$/.test(path) ||
    /^(content|server|app\/server|shared\/types|generated|app\/generated)\//.test(path)
  )
    return false;
  if (path === "app.vue" || path === "app/app.vue") return true;
  return /^(app\/)?(components|composables|layouts|middleware|pages|plugins|utils)\//.test(path);
}

function toPosixPath(path: string) {
  return path.replace(/\\/g, "/");
}
