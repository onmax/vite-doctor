import { AnyNode, createRule, report } from "./shared.js";

export const noSecretInPublicConfig = createRule({
  meta: {
    id: "nuxt/runtime/no-secret-in-public-config",
    title: "Do not expose secrets in runtimeConfig.public",
    category: "runtime-config",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Property") return;
        const key = node.key?.name ?? node.key?.value;
        if (typeof key === "string" && /(secret|token|password|private|key)$/i.test(key)) {
          const nearby = ctx.file.text.slice(Math.max(0, node.start - 120), node.start);
          if (nearby.includes("public")) {
            report(
              ctx,
              node,
              "nuxt/runtime/no-secret-in-public-config",
              "error",
              "runtime-config",
              `runtimeConfig.public.${key} looks sensitive and will be exposed to the client. Move it to private runtimeConfig.`,
            );
          }
        }
      },
    };
  },
});
