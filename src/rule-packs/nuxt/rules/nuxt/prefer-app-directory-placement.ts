import { AnyNode, NUXT_APP_DIRS, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const preferAppDirectoryPlacement = createRule({
  meta: {
    id: "nuxt/project/prefer-app-directory-placement",
    title: "Place app directories under app/",
    category: "architecture",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/directory-structure/app",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (nuxtMajor(ctx.project.nuxt?.version ?? ctx.project.nuxtVersion) < 4) return;
    if (isExternalComponentRoot(ctx.file.relativePath, ctx.project.nuxt?.modules)) return;
    const [first] = ctx.file.relativePath.split("/");
    if (!first || !NUXT_APP_DIRS.has(first)) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report(
        diagnostics.NUXT0044({
          why: `Nuxt 4 projects should place ${first}/ under app/${first}/.`,
          fix: `Move ${ctx.file.relativePath} under app/${ctx.file.relativePath}.`,
        }),
        {
          ruleId: "nuxt/project/prefer-app-directory-placement",
          severity: "info",
          category: "architecture",
          file: ctx.file.path,
        },
      );
    };
    return {
      SFC: reportOnce,
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});

function isExternalComponentRoot(
  relativePath: string,
  modules: Array<{ name: string }> | undefined,
) {
  if (!relativePath.startsWith("components/ui/")) return false;
  return modules?.some((module) => module.name === "shadcn-nuxt") ?? false;
}

function nuxtMajor(version?: string): number {
  return Number(version?.match(/\d+/)?.[0] ?? 4);
}
