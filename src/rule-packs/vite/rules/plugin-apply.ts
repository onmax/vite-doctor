import { createRule } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import { propertyName, staticString, type AnyNode } from "./shared.js";

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
      ObjectExpression(node: AnyNode) {
        if (node.properties.some((property: AnyNode) => property.type !== "Property")) return;
        const apply = node.properties.filter((property: AnyNode) => keyName(property) === "apply");
        if (apply.length !== 1 || staticString(apply[0].value) !== "build") return;
        for (const property of node.properties) {
          const hook = keyName(property);
          if (hook === null || !Object.hasOwn(serveOnlyHooks, hook) || !isHook(property.value))
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
      },
    };
  },
});

function keyName(property: AnyNode): string | null {
  if (property?.type !== "Property") return null;
  return property.computed ? staticString(property.key) : propertyName(property.key);
}

function isHook(value: AnyNode): boolean {
  if (["FunctionExpression", "ArrowFunctionExpression"].includes(value?.type)) return true;
  return (
    value?.type === "ObjectExpression" &&
    value.properties.some(
      (property: AnyNode) =>
        keyName(property) === "handler" &&
        ["FunctionExpression", "ArrowFunctionExpression"].includes(property.value?.type),
    )
  );
}
