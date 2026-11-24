import { createRule, type RuleContext } from "../../../core/index.js";
import { fileTextScope, perFile, type ScriptScope } from "../../../core/internal/script-scope.js";
import { diagnostics } from "../../../diagnostics.js";
import { isViteConfigFile, propertyName, staticString, type AnyNode } from "./shared.js";
import {
  clientDefineObjects,
  importBinding,
  objectProperties,
  propertyKey,
  resolveConst,
  staticConfig,
  unwrap,
  VITE_MODULES,
} from "./static-config.js";

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
    const config = staticConfig(scope);
    const defines = config && clientDefineObjects(scope, config);
    if (!defines) return [];
    const leaks = new Map<string | symbol, Leak & { kind: "object" | "string" }>();
    for (const [index, define] of defines.entries()) {
      if (index > 0 && isNullish(scope, define)) continue;
      if (wholeEnv(scope, define)) {
        leaks.set(Symbol(), { node: define, entry: "The Vite define object", kind: "object" });
      } else {
        const entries = readDefine(scope, define);
        if (!entries) {
          leaks.clear();
          continue;
        }
        for (const [key, value] of entries) {
          if (key === unknownKeys) {
            leaks.clear();
          } else if (typeof key === "symbol") {
            leaks.set(key, { node: value, entry: "A spread in Vite define", kind: "object" });
          } else {
            const kind = leakingValueKind(scope, value);
            const previous = leaks.get(key);
            if (kind) leaks.set(key, { node: value, entry: `Vite define "${key}"`, kind });
            else if (previous && !retainsDefineValue(scope, value, previous.kind))
              leaks.delete(key);
          }
        }
      }
    }
    return [...leaks.values()];
  });
}

export interface Leak {
  node: AnyNode;
  entry: string;
}

function report(ctx: RuleContext, leak: Leak) {
  ctx.report(
    diagnostics.VITE0031({
      why: `${leak.entry} receives every variable loadEnv read with an empty prefix, or all of process.env, secrets included. Vite inlines define values into client code and, in dev, injects global define entries into the browser.`,
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

const unknownKeys = Symbol("unknown keys");

function readDefine(scope: ScriptScope, input: AnyNode): Map<string | symbol, AnyNode> | null {
  const define = resolveConst(scope, input);
  if (define?.type !== "ObjectExpression") return null;
  const entries = new Map<string | symbol, AnyNode>();
  const addUnknown = () => {
    entries.clear();
    entries.set(unknownKeys, undefined);
  };
  for (const entry of define.properties) {
    if (entry.type === "SpreadElement") {
      if (wholeEnv(scope, entry.argument)) {
        addUnknown();
        entries.set(Symbol(), entry);
      } else {
        const spread = readDefine(scope, entry.argument);
        if (!spread) addUnknown();
        else
          for (const [key, value] of spread) {
            if (key === unknownKeys) addUnknown();
            else entries.set(key, value);
          }
      }
      continue;
    }
    const key = propertyKey(entry);
    if (key === null) addUnknown();
    else entries.set(key, entry.kind === "init" ? entry.value : entry);
  }
  return entries;
}

function retainsDefineValue(scope: ScriptScope, override: AnyNode, previous: "object" | "string") {
  const node = resolveConst(scope, override);
  if (isNullish(scope, node) || node?.type === "ArrayExpression") return true;
  if (previous !== "object" || node?.type !== "ObjectExpression") return false;
  const properties = objectProperties(scope, node);
  return properties !== null && !properties.has("toJSON");
}

function leakingValueKind(scope: ScriptScope, input: AnyNode): "object" | "string" | undefined {
  const node = resolveConst(scope, input);
  if (wholeEnv(scope, node)) return "object";
  if (
    node?.type === "CallExpression" &&
    memberName(node.callee, "JSON", "stringify") &&
    isGlobal(scope, unwrap(node.callee).object) &&
    !node.arguments.some((argument: AnyNode) => argument.type === "SpreadElement") &&
    nonFilteringReplacer(scope, node.arguments[1]) &&
    wholeEnv(scope, node.arguments[0])
  )
    return "string";
  if (
    node?.type === "ObjectExpression" &&
    node === unwrap(input) &&
    node.properties.some(
      (entry: AnyNode) => entry.type === "SpreadElement" && wholeEnv(scope, entry.argument),
    )
  )
    return "object";
}

function nonFilteringReplacer(scope: ScriptScope, input: AnyNode): boolean {
  if (!input) return true;
  const node = resolveConst(scope, input);
  return (
    (node?.type === "Literal" && (node.value === null || typeof node.value !== "object")) ||
    isNullish(scope, node)
  );
}

function isNullish(scope: ScriptScope, input: AnyNode): boolean {
  const node = resolveConst(scope, input);
  return (
    (node?.type === "Literal" && node.value === null) ||
    (node?.type === "UnaryExpression" && node.operator === "void") ||
    (node?.type === "Identifier" && node.name === "undefined" && isGlobal(scope, node))
  );
}

/** Whether the value is every variable loadEnv read with an empty prefix, or process.env. */
function wholeEnv(scope: ScriptScope, input: AnyNode): boolean {
  const node = resolveConst(scope, input, true);
  if (!node) return false;
  if (node.type === "CallExpression") return isLoadEnv(scope, node.callee) && loadsAll(node);
  if (node.type === "MemberExpression" && memberName(node, undefined, "env"))
    return isProcess(scope, unwrap(node.object));
  return false;
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
      !binding.typeOnly &&
      VITE_MODULES.has(binding.source) &&
      binding.imported === "loadEnv"
    );
  }
  if (callee?.type !== "MemberExpression" || !memberName(callee, undefined, "loadEnv"))
    return false;
  const object = unwrap(callee.object);
  const binding = object?.type === "Identifier" ? importBinding(scope, object) : undefined;
  return (
    binding?.type === "ImportNamespaceSpecifier" &&
    !binding.typeOnly &&
    VITE_MODULES.has(binding.source)
  );
}

function isProcess(scope: ScriptScope, node: AnyNode): boolean {
  if (node?.type !== "Identifier") return false;
  if (node.name === "process" && isGlobal(scope, node)) return true;
  const binding = importBinding(scope, node);
  return (
    PROCESS_MODULES.has(binding?.source ?? "") &&
    !binding!.typeOnly &&
    (binding!.type === "ImportDefaultSpecifier" ||
      binding!.type === "ImportNamespaceSpecifier" ||
      binding!.imported === "default")
  );
}

function isGlobal(scope: ScriptScope, node: AnyNode): boolean {
  const reference = scope.references.get(node);
  return !!reference && !reference.resolved;
}

function memberName(input: AnyNode, object: string | undefined, property: string): boolean {
  const node = unwrap(input);
  if (node?.type !== "MemberExpression") return false;
  const key = node.computed ? staticString(node.property) : propertyName(node.property);
  if (key !== property) return false;
  return object === undefined || unwrap(node.object)?.name === object;
}
