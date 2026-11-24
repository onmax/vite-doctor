import type { RuleContext } from "../../../../core/index.js";
import {
  type AnyNode,
  createRule,
  isClientOnlyPath,
  isRuntimeAppFile,
  report,
  walkScriptLocal,
} from "./shared.js";
import {
  FUNCTION_TYPES,
  calleeName,
  holdsRequestValue,
  moduleNames,
  unwrapExpression as unwrap,
} from "../../../../core/internal/request-values.js";
import {
  blockRange,
  inRange,
  isRequestTimeWrite,
  moduleScriptRange,
  resolvesToModuleState,
  setupBinding,
  type SourceRange as Range,
} from "./module-scope-state.js";

const RULE_ID = "nuxt/ssr/no-module-scope-request-state";
const REQUEST_CALLS = new Set([
  "$fetch",
  "fetch",
  "useFetch",
  "useLazyFetch",
  "useAsyncData",
  "useLazyAsyncData",
  "useRequestFetch",
  "useRequestEvent",
  "useRequestHeaders",
  "useRequestHeader",
  "useRequestURL",
  "useCookie",
  "useNuxtApp",
  "useRoute",
  "useRouter",
  "useState",
  "useUserSession",
]);
const PROMISE_COMBINATORS = new Set([
  "Promise.all",
  "Promise.allSettled",
  "Promise.any",
  "Promise.race",
]);
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

interface ModuleBinding {
  name: string;
  kind: "variable" | "collection";
  declarator: AnyNode;
}

export const noModuleScopeRequestState = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep request state out of module scope",
    category: "ssr",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/getting-started/state-management#best-practices",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/\b(?:let|var)\b|new\s+(?:Map|Set)\b/.test(ctx.file.text)) return;
    if (isClientOnlyPath(ctx.file.relativePath) || !isRuntimeAppFile(ctx)) return;
    return {
      Program(program: AnyNode) {
        const bindings = moduleBindings(ctx, program);
        if (!bindings.size) return;
        const setup = blockRange(ctx, "scriptSetup");
        const reported = new Set<string>();
        walkScriptLocal(program, (node) => {
          if (node.type !== "Identifier") return;
          const binding = bindings.get(node.name);
          if (!binding || reported.has(binding.name)) return;
          const value = writtenValue(node, binding);
          if (!value || !isRequestTimeWrite(ctx, node, setup)) return;
          if (!resolvesToModuleState(node, program, setup)) return;
          if (!isRequestScopedValue(value, setup)) return;
          reported.add(binding.name);
          const line = ctx.range(node)?.line;
          report(
            ctx,
            binding.declarator.id,
            RULE_ID,
            "warn",
            "ssr",
            `${binding.name} lives at module scope and request-time code${line ? ` on line ${line}` : ""} stores request data in it. On the server every SSR request shares this module, so concurrent requests read and overwrite each other's value.`,
            "Keep private data in request-local variables or server-only request context. Key non-serializable, non-sensitive state by the Nuxt app with a WeakMap<NuxtApp, ...>. Use useState() or Pinia only for serializable values safe to send to the browser in the hydration payload.",
          );
        });
      },
    };
  },
});

function moduleBindings(ctx: RuleContext, program: AnyNode) {
  const bindings = new Map<string, ModuleBinding>();
  const moduleScript = moduleScriptRange(ctx);
  if (!moduleScript) return bindings;
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (statement.start < moduleScript.start || statement.end > moduleScript.end) continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      const kind = isCollectionConstruction(declarator.init)
        ? "collection"
        : declaration.kind === "const"
          ? null
          : "variable";
      if (kind) bindings.set(declarator.id.name, { name: declarator.id.name, kind, declarator });
    }
  }
  return bindings;
}

function isCollectionConstruction(init: AnyNode) {
  const node = unwrap(init);
  return (
    node?.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    (node.callee.name === "Map" || node.callee.name === "Set")
  );
}

function writtenValue(node: AnyNode, binding: ModuleBinding): AnyNode {
  const parent = node.__doctorParent;
  if (parent?.type === "AssignmentExpression" && parent.left === node) return parent.right;
  if (binding.kind === "variable") return null;
  if (parent?.type !== "MemberExpression" || parent.object !== node || parent.computed) return null;
  const call = parent.__doctorParent;
  if (call?.type !== "CallExpression" || call.callee !== parent) return null;
  const method = parent.property?.name;
  if (method === "set") return call.arguments?.[1] ?? null;
  if (method === "add") return call.arguments?.[0] ?? null;
  return null;
}

// Values that only exist for one request: awaited or fetched data, in-flight promises, the
// current store (`this` in a Pinia action), and Nuxt request composables.
function isRequestScopedValue(value: AnyNode, setup: Range | null): boolean {
  return holdsRequestValue(value, {
    isSource: (node) =>
      node.type === "ThisExpression" ||
      node.type === "AwaitExpression" ||
      (node.type === "CallExpression" && isRequestScopedCall(node)) ||
      (node.type === "NewExpression" && node.callee?.name === "Promise"),
    programBinding: (program, name, reference) =>
      inRange(reference, setup) ? setupBinding(program, name, setup) : null,
  });
}

function isRequestScopedCall(node: AnyNode) {
  const callee = unwrap(node.callee);
  if (FUNCTION_TYPES.has(callee?.type) && callee.async) return true;
  const name = calleeName(callee);
  if (!name) return false;
  if (REQUEST_CALLS.has(name) || PROMISE_COMBINATORS.has(name)) return true;
  if (/^use[A-Z]\w*Store$/.test(name)) return true;
  if (name.startsWith("$") && !moduleNames(node).has(name)) return true;
  if (name.includes(".$")) return true;
  const method = name.split(".").at(-1)!;
  return name.includes(".") && PROMISE_METHODS.has(method);
}
