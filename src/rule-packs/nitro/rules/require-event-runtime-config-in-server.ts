import { parseForESLint } from "@typescript-eslint/parser";
import type { RuleContext } from "../../../core/index.js";
import { AnyNode, createRule, report } from "./shared.js";

export const requireEventRuntimeConfigInServer = createRule({
  meta: {
    id: "nitro/runtime/require-event-runtime-config-in-server",
    title: "Pass event to useRuntimeConfig in server handlers",
    description: "Read runtime config with the Nitro event inside server handlers.",
    why: "Passing the event lets Nitro resolve request-aware runtime config consistently in server code.",
    recommendedReplacement: "Use useRuntimeConfig(event).",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://v2.nitro.build/guide/configuration#runtime-configuration",
    requires: { script: true, nitro: true },
    applicability: { runtimes: { nitro: ">=2 <3" } },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    let startupCalls: Set<number> | undefined;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useRuntimeConfig")) return;
        if (node.arguments?.length) return;
        if ((startupCalls ??= pluginStartupCalls(ctx)).has(node.start)) return;
        report(
          ctx,
          node,
          "nitro/runtime/require-event-runtime-config-in-server",
          "warn",
          "runtime-config",
          "Server handlers should read runtime config with the request event.",
          "Use useRuntimeConfig(event).",
        );
      },
    };
  },
});

function pluginStartupCalls(ctx: RuleContext): Set<number> {
  try {
    const { ast, scopeManager, visitorKeys } = parseForESLint(ctx.file.text, {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx: /\.[jt]sx$/.test(ctx.file.relativePath) },
    });
    const references = new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference] as const),
      ),
    );
    const isPluginFactory = (node: AnyNode): boolean => {
      if (node?.type !== "Identifier") return false;
      const variable = references.get(node)?.resolved;
      if (!variable) return node.name === "defineNitroPlugin";
      return variable.defs.some(
        (definition) =>
          definition.type === "ImportBinding" &&
          definition.parent.type === "ImportDeclaration" &&
          definition.parent.importKind !== "type" &&
          ["nitropack/runtime", "#imports"].includes(String(definition.parent.source.value)) &&
          definition.node.type === "ImportSpecifier" &&
          definition.node.importKind !== "type" &&
          (definition.node.imported.type === "Identifier"
            ? definition.node.imported.name
            : definition.node.imported.value) === "defineNitroPlugin",
      );
    };
    const pluginFile = /^(?:app\/)?server\/plugins\//.test(ctx.file.relativePath);
    const result = new Set<number>();
    const visit = (node: AnyNode, parent?: AnyNode, startup = false) => {
      if (!node?.type) return;
      if (
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
      ) {
        startup =
          (pluginFile && parent?.type === "ExportDefaultDeclaration") ||
          (parent?.type === "CallExpression" &&
            parent.arguments[0] === node &&
            isPluginFactory(parent.callee));
      }
      if (startup && node.type === "CallExpression") result.add(node.range[0]);
      for (const key of visitorKeys[node.type] ?? []) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach((child) => visit(child, node, startup));
        else visit(value, node, startup);
      }
    };
    visit(ast);
    return result;
  } catch {
    return new Set();
  }
}
