import { posix } from "pathe";
import { AnyNode, createRule, report } from "./shared.js";

const RULE_ID = "nuxt/imports/prefer-alias-over-relative-parent";
const ROOTS = ["app/", "server/", "shared/"];
const ALIASES: Record<string, string> = { app: "~/", server: "#server/", shared: "#shared/" };

/** `../../shared/utils/time` from `server/api/events/x.ts` reads better as `#shared/utils/time`. */
export const preferAliasOverRelativeParent = createRule({
  meta: {
    id: RULE_ID,
    title: "Import across Nuxt directories through an alias",
    description: "Flags imports that climb two or more directories in app/, server/ or shared/.",
    why: "A chain of ../ breaks when a file moves and hides which part of the app it reaches into. Nuxt gives every directory an alias: ~/ for app/, #server/ for server/, #shared/ for shared/ and ~~/ for the project root.",
    recommendedReplacement: "Import through ~/, #server/, #shared/ or ~~/.",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/directory-structure/shared#how-files-are-imported",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const path = ctx.file.relativePath.replace(/\\/g, "/");
    if (!ROOTS.some((root) => path.startsWith(root))) return;
    return {
      ImportDeclaration(node: AnyNode) {
        const source = String(node.source?.value ?? "");
        if (!source.startsWith("../../")) return;
        const target = posix.normalize(posix.join(posix.dirname(path), source));
        if (target.startsWith("../")) return;
        const [top, ...rest] = target.split("/");
        const alias = ALIASES[top ?? ""];
        const suggestion = alias ? `${alias}${rest.join("/")}` : `~~/${target}`;
        report(
          ctx,
          node,
          RULE_ID,
          "warn",
          "imports",
          `"${source}" climbs ${source.split("../").length - 1} directories.`,
          `Import it as "${suggestion}".`,
        );
      },
    };
  },
});
