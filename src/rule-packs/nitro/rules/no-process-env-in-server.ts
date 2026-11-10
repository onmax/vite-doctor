import type { RuleContext } from "../../../core/index.js";
import { fileTextScope } from "../../../core/internal/script-scope.js";
import { AnyNode, createRule, isNitroServerFile, report } from "./shared.js";

export const noProcessEnvInServer = createRule({
  meta: {
    id: "nitro/runtime/no-process-env-in-server",
    title: "Read server settings from runtime config, not process.env",
    description: "Flags process.env reads in Nitro server files.",
    why: "Nitro maps NITRO_ and NUXT_ environment variables onto runtimeConfig at startup, with types and defaults in one place. process.env is empty on Cloudflare Workers and other runtimes without a Node process, and a key read straight from it bypasses that contract.",
    recommendedReplacement:
      "Declare the setting in runtimeConfig and read it with useRuntimeConfig(); override it with NUXT_<KEY> or NITRO_<KEY> at runtime.",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/configuration#runtime-configuration",
    requires: { script: true, nitro: true },
    prefilter: { names: ["process"] },
  },
  create(ctx) {
    const path = ctx.file.relativePath.replace(/\\/g, "/");
    const nitroUtility =
      ctx.project.framework === "nitro" &&
      /^(?:server\/)?(?:plugins|utils)\/.+\.[cm]?[jt]s$/.test(path);
    if (!isNitroServerFile(ctx) && !nitroUtility) return;
    let processImports: Set<number> | undefined;
    return {
      MemberExpression(node: AnyNode) {
        if (ctx.helpers.getNodeName(node) !== "process.env") return;
        if (ctx.helpers.isTypeOnlyContext(node)) return;
        if (
          ctx.helpers.hasLocalBinding(node.object) &&
          !(processImports ??= importedProcessReferences(ctx)).has(node.object.start)
        )
          return;
        const parent = node.parent ?? node.__doctorParent;
        const access =
          parent?.type === "MemberExpression" && parent.object === node ? parent : node;
        if (isWriteOnly(access)) return;
        const key =
          access !== node
            ? parent.computed
              ? parent.property?.type === "Literal"
                ? parent.property.value
                : undefined
              : parent.property?.name
            : undefined;
        // NODE_ENV is the build mode libraries read; import.meta.dev says the same in app code.
        if (key === "NODE_ENV") return;
        report(
          ctx,
          node,
          "nitro/runtime/no-process-env-in-server",
          "warn",
          "runtime-config",
          key
            ? `process.env.${key} is read directly in Nitro server code.`
            : "process.env is read directly in Nitro server code.",
          "Declare the setting in runtimeConfig and read it with useRuntimeConfig().",
        );
      },
    };
  },
});

function importedProcessReferences(ctx: RuleContext): Set<number> {
  const result = new Set<number>();
  const scope = fileTextScope(ctx);
  if (!scope) return result;
  try {
    // Resolve each reference so a nested binding still shadows a built-in process import.
    for (const reference of scope.references.values()) {
      if (reference.identifier.name !== "process") continue;
      if (
        reference.resolved?.defs.some(
          (definition) =>
            definition.type === "ImportBinding" &&
            definition.parent.type === "ImportDeclaration" &&
            definition.parent.importKind !== "type" &&
            ["node:process", "process"].includes(String(definition.parent.source.value)) &&
            (definition.node.type === "ImportDefaultSpecifier" ||
              definition.node.type === "ImportNamespaceSpecifier"),
        )
      )
        result.add(reference.identifier.range[0]);
    }
  } catch {
    return new Set();
  }
  return result;
}

function isWriteOnly(node: AnyNode): boolean {
  const parent = node.parent ?? node.__doctorParent;
  return (
    (parent?.type === "AssignmentExpression" && parent.left === node && parent.operator === "=") ||
    (parent?.type === "UnaryExpression" && parent.operator === "delete" && parent.argument === node)
  );
}
