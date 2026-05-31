import { AnyNode, createRule, report } from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";

export const noPlainEnvInAppCode = createRule({
  meta: {
    id: "nuxt/runtime/no-plain-env-in-app-code",
    title: "Use runtimeConfig instead of process.env in app code",
    category: "runtime-config",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/going-further/runtime-config#environment-variables",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    if (!evidence.isRuntimeAppFile()) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.getNodeName(node) !== "process.env") return;
        report(
          ctx,
          node,
          "nuxt/runtime/no-plain-env-in-app-code",
          "error",
          "runtime-config",
          "process.env is not the public runtime contract for Nuxt app code.",
          "Expose values through runtimeConfig.public and read them with useRuntimeConfig().",
        );
      },
    };
  },
});
