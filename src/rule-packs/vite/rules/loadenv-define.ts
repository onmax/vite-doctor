import { createRule, type RuleContext } from "../../../core/index.js";
import { fileTextScope, perFile, type ScriptScope } from "../../../core/internal/script-scope.js";
import { walkScriptLocal } from "../../../core/rule-authoring.js";
import { diagnostics } from "../../../diagnostics.js";
import { isViteConfigFile, propertyName, staticString, type AnyNode } from "./shared.js";

// Vite+ and Vitest re-export Vite's loadEnv.
const LOAD_ENV_MODULES = new Set(["vite", "vite-plus", "vitest/config"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);

export const noLoadEnvAllInDefine = createRule({
  meta: {
    id: "vite/define/no-loadenv-all-in-define",
    title: "Do not pass every loaded env variable to define",
    description:
      "Reports Vite define entries that receive the whole result of loadEnv with an empty prefix, or the whole process.env.",
    category: "security",
    severity: "error",
    confidence: "heuristic-high",
    docsUrl: "https://vite.dev/config/#using-environment-variables-in-config",
    requires: { script: true },
    prefilter: { names: ["define"] },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      Program() {
        for (const leak of wholeEnvDefineLeaks(ctx)) report(ctx, leak);
      },
    };
  },
});

/** Define entries in the current Vite config that receive every loaded env variable. */
export function wholeEnvDefineLeaks(ctx: RuleContext): Leak[] {
  return perFile(ctx, "vite:whole-env-define-leaks", () => {
    const scope = fileTextScope(ctx);
    if (!scope) return [];
    const leaks: Leak[] = [];
    walkScriptLocal(scope.ast, (node: AnyNode) => {
      if (node.type === "Property" && !node.computed && propertyName(node.key) === "define")
        leaks.push(...defineLeaks(scope, node.value));
    });
    return leaks;
  });
}

export interface Leak {
  node: AnyNode;
  entry: string;
}

function report(ctx: RuleContext, leak: Leak) {
  ctx.report(
    diagnostics.VITE0031({
      why: `${leak.entry} receives every variable loadEnv read with an empty prefix, or all of process.env, secrets included. Vite inlines define values into client code and, in dev, sends every define entry to the browser.`,
      fix: "Define only the public values the client needs, such as __API_URL__: JSON.stringify(env.API_URL), or load env with the default VITE_ prefix and read it through import.meta.env.",
    }),
    {
      ruleId: "vite/define/no-loadenv-all-in-define",
      severity: ctx.severity,
      category: "security",
      file: ctx.file.path,
      range: ctx.range(leak.node),
    },
  );
}

function defineLeaks(scope: ScriptScope, define: AnyNode): Leak[] {
  if (wholeEnv(scope, define)) return [{ node: define, entry: "The Vite define object" }];
  define = unwrap(define);
  if (define?.type !== "ObjectExpression") return [];
  const leaks: Leak[] = [];
  for (const entry of define.properties) {
    if (entry.type === "SpreadElement") {
      if (wholeEnv(scope, entry.argument))
        leaks.push({ node: entry, entry: "A spread in Vite define" });
      continue;
    }
    const key = entry.computed ? staticString(entry.key) : propertyName(entry.key);
    if (key !== null && leaksValue(scope, entry.value))
      leaks.push({ node: entry.value, entry: `Vite define "${key}"` });
  }
  return leaks;
}

function leaksValue(scope: ScriptScope, input: AnyNode): boolean {
  const node = unwrap(input);
  if (wholeEnv(scope, node)) return true;
  if (
    node?.type === "CallExpression" &&
    memberName(node.callee, "JSON", "stringify") &&
    isGlobal(scope, unwrap(node.callee).object)
  )
    return wholeEnv(scope, node.arguments[0]);
  return (
    node?.type === "ObjectExpression" &&
    node.properties.some(
      (entry: AnyNode) => entry.type === "SpreadElement" && wholeEnv(scope, entry.argument),
    )
  );
}

/** Whether the value is every variable loadEnv read with an empty prefix, or process.env. */
function wholeEnv(scope: ScriptScope, input: AnyNode, seen = new Set<AnyNode>()): boolean {
  const node = unwrap(input);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "CallExpression") return isLoadEnv(scope, node.callee) && loadsAll(node);
  if (node.type === "MemberExpression" && memberName(node, undefined, "env"))
    return isProcess(scope, unwrap(node.object));
  if (node.type !== "Identifier") return false;
  const variable = scope.references.get(node)?.resolved;
  const definition = variable?.defs.length === 1 ? (variable.defs[0] as AnyNode) : undefined;
  if (definition?.type !== "Variable" || definition.node.id.type !== "Identifier") return false;
  if (variable!.references.some((reference) => reference.isWrite() && !reference.init))
    return false;
  return wholeEnv(scope, definition.node.init, seen);
}

function loadsAll(call: AnyNode): boolean {
  const prefixes = unwrap(call.arguments[2]);
  if (!prefixes) return false;
  if (staticString(prefixes) === "") return true;
  return (
    prefixes.type === "ArrayExpression" &&
    prefixes.elements.some((element: AnyNode) => staticString(element) === "")
  );
}

function isLoadEnv(scope: ScriptScope, input: AnyNode): boolean {
  const callee = unwrap(input);
  if (callee?.type === "Identifier") {
    const binding = importBinding(scope, callee);
    return (
      binding?.type === "ImportSpecifier" &&
      LOAD_ENV_MODULES.has(binding.source) &&
      binding.imported === "loadEnv"
    );
  }
  if (callee?.type !== "MemberExpression" || !memberName(callee, undefined, "loadEnv"))
    return false;
  const object = unwrap(callee.object);
  const binding = object?.type === "Identifier" ? importBinding(scope, object) : undefined;
  return binding?.type === "ImportNamespaceSpecifier" && LOAD_ENV_MODULES.has(binding.source);
}

function isProcess(scope: ScriptScope, node: AnyNode): boolean {
  if (node?.type !== "Identifier") return false;
  if (node.name === "process" && isGlobal(scope, node)) return true;
  const binding = importBinding(scope, node);
  return (
    PROCESS_MODULES.has(binding?.source ?? "") &&
    (binding!.type === "ImportDefaultSpecifier" ||
      binding!.type === "ImportNamespaceSpecifier" ||
      binding!.imported === "default")
  );
}

function isGlobal(scope: ScriptScope, node: AnyNode): boolean {
  const reference = scope.references.get(node);
  return !!reference && !reference.resolved;
}

function importBinding(scope: ScriptScope, node: AnyNode) {
  const definition = scope.references.get(node)?.resolved?.defs[0] as AnyNode;
  if (definition?.type !== "ImportBinding") return;
  const specifier = definition.node;
  const declaration = definition.parent;
  if (declaration?.importKind === "type" || specifier.importKind === "type") return;
  return {
    type: specifier.type as string,
    source: String(declaration.source.value),
    imported:
      specifier.type === "ImportSpecifier"
        ? (propertyName(specifier.imported) ?? undefined)
        : undefined,
  };
}

function memberName(input: AnyNode, object: string | undefined, property: string): boolean {
  const node = unwrap(input);
  if (node?.type !== "MemberExpression") return false;
  const key = node.computed ? staticString(node.property) : propertyName(node.property);
  if (key !== property) return false;
  return object === undefined || unwrap(node.object)?.name === object;
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}
