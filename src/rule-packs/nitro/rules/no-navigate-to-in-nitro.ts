import { AnyNode, createRule, report } from "./shared.js";

export const noNavigateToInNitro = createRule({
  meta: {
    id: "nitro/context/no-navigateto-in-nitro",
    title: "Do not use navigateTo in Nitro routes",
    description:
      "Nitro handlers should redirect with server response utilities instead of Nuxt app navigation.",
    why: "navigateTo() is a Nuxt app navigation helper. Nitro handlers need to write an HTTP redirect response for the current request event.",
    recommendedReplacement:
      "Return the redirect response supported by the installed H3 runtime from the Nitro handler.",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "navigateTo")) {
          const h3 = ctx.project.runtimeGraph?.packages.h3;
          const replacement =
            h3?.state === "resolved" && Number(h3.version?.split(".")[0]) >= 2
              ? "Return redirect(path) from the Nitro handler."
              : h3?.state === "resolved"
                ? "Use sendRedirect(event, path) from the Nitro handler."
                : "Use the redirect response API supported by the installed H3 runtime.";
          report(
            ctx,
            node,
            "nitro/context/no-navigateto-in-nitro",
            "error",
            "server",
            "navigateTo() is for Nuxt app navigation and cannot produce a Nitro server response.",
            replacement,
          );
        }
      },
    };
  },
});
