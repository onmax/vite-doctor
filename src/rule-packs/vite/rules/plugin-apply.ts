import { createRule, type RuleContext } from "../../../core/index.js";
import { fileScriptScope, type ScriptScope } from "../../../core/internal/script-scope.js";
import { walkScriptLocal } from "../../../core/rule-authoring.js";
import { diagnostics } from "../../../diagnostics.js";
import { isViteConfigFile, staticString, type AnyNode } from "./shared.js";
import {
  importBinding,
  propertyKey,
  resolveConst,
  simpleReturn,
  staticConfig,
  VITE_MODULES,
} from "./static-config.js";

// Vite calls these only from the dev or preview server, and both resolve config with the serve
// command, which drops plugins whose apply is "build".
const serveOnlyHooks: Record<string, string> = {
  configureServer: "the dev server",
  configurePreviewServer: "the preview server",
  handleHotUpdate: "dev server HMR",
  hotUpdate: "dev server HMR",
};

export const noUnreachableHook = createRule({
  meta: {
    id: "vite/plugin/no-unreachable-hook",
    title: "Do not add serve-only hooks to build-only plugins",
    description:
      'Reports configureServer, configurePreviewServer, handleHotUpdate, and hotUpdate hooks on Vite plugin objects with apply: "build".',
    category: "plugins",
    severity: "warn",
    confidence: "heuristic-high",
    docsUrl: "https://vite.dev/guide/api-plugin.html#conditional-application",
    requires: { script: true },
    prefilter: { names: ["apply"] },
  },
  create(ctx) {
    return {
      Program() {
        const scope = fileScriptScope(ctx);
        if (!scope) return;
        const plugins = new Set<AnyNode>();
        if (isViteConfigFile(ctx.file.relativePath))
          readPlugins(scope, staticConfig(scope)?.get("plugins"), plugins);
        walkScriptLocal(scope.ast, (node) => {
          if (!isPluginType(scope, node.returnType?.typeAnnotation)) return;
          readPlugins(scope, simpleReturn(node.body), plugins);
        });
        for (const plugin of plugins) reportHooks(ctx, plugin);
      },
    };
  },
});

function readPlugins(scope: ScriptScope, input: AnyNode, plugins: Set<AnyNode>) {
  const node = resolveConst(scope, input);
  if (node?.type === "ArrayExpression") {
    for (const element of node.elements) readPlugins(scope, element, plugins);
  } else if (node?.type === "ObjectExpression") {
    plugins.add(node);
  }
}

function isPluginType(scope: ScriptScope, node: AnyNode): boolean {
  const name = node?.type === "TSTypeReference" ? node.typeName : undefined;
  const binding = name?.type === "Identifier" ? importBinding(scope, name) : undefined;
  return !!binding && binding.imported === "Plugin" && VITE_MODULES.has(binding.source);
}

function reportHooks(ctx: RuleContext, node: AnyNode) {
  const properties = new Map<string, AnyNode>();
  for (const property of node.properties) {
    const key = propertyKey(property);
    if (key === null || key === "__proto__") return;
    properties.set(key, property);
  }
  const apply = properties.get("apply");
  if (apply?.kind !== "init" || staticString(apply.value) !== "build") return;
  for (const [hook, property] of properties) {
    if (!Object.hasOwn(serveOnlyHooks, hook) || property.kind !== "init" || !isHook(property.value))
      continue;
    ctx.report(
      diagnostics.VITE0032({
        why: `Vite never calls ${hook} on this plugin: apply: "build" drops it whenever Vite resolves config for vite dev, vite preview, or createServer, which all use the serve command, and only ${serveOnlyHooks[hook]} calls ${hook}.`,
        fix: `Remove apply: "build" or change it to apply: "serve" if ${hook} should run, or delete ${hook}.`,
      }),
      {
        ruleId: "vite/plugin/no-unreachable-hook",
        severity: ctx.severity,
        category: "plugins",
        file: ctx.file.path,
        range: ctx.range(property.key),
      },
    );
  }
}

function isHook(value: AnyNode): boolean {
  if (["FunctionExpression", "ArrowFunctionExpression"].includes(value?.type)) return true;
  return (
    value?.type === "ObjectExpression" &&
    value.properties.some(
      (property: AnyNode) =>
        propertyKey(property) === "handler" &&
        ["FunctionExpression", "ArrowFunctionExpression"].includes(property.value?.type),
    )
  );
}
