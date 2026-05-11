import { AnyNode, NUXT_APP_DIRS, createRule } from "./shared.js";

export const preferAppDirectoryPlacement = createRule({
  meta: {
    id: "nuxt/project/prefer-app-directory-placement",
    title: "Place app directories under app/",
    category: "architecture",
    severity: "info",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (nuxtMajor(ctx.project.nuxt?.version ?? ctx.project.nuxtVersion) < 4) return;
    const [first] = ctx.file.relativePath.split("/");
    if (!first || !NUXT_APP_DIRS.has(first)) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report({
        ruleId: "nuxt/project/prefer-app-directory-placement",
        severity: "info",
        category: "architecture",
        file: ctx.file.path,
        message: `Nuxt 4 projects should place ${first}/ under app/${first}/.`,
        suggestion: `Move ${ctx.file.relativePath} under app/${ctx.file.relativePath}.`,
      });
    };
    return {
      SFC: reportOnce,
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});

function nuxtMajor(version?: string): number {
  return Number(version?.match(/\d+/)?.[0] ?? 4);
}
