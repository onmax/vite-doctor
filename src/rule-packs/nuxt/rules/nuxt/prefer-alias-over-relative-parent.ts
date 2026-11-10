import { posix } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule, report } from "./shared.js";

const RULE_ID = "nuxt/imports/prefer-alias-over-relative-parent";
const ROOTS = ["app/", "server/", "shared/"];
const ALIASES = ["~", "#server", "#shared", "~~"];

/** `../../shared/utils/time` from `server/api/events/x.ts` reads better as `#shared/utils/time`. */
export const preferAliasOverRelativeParent = createRule({
  meta: {
    id: RULE_ID,
    title: "Import across Nuxt directories through an alias",
    description: "Flags imports that climb two or more directories in app/, server/ or shared/.",
    why: "A chain of ../ breaks when a file moves and hides which part of the app it reaches into. Nuxt aliases depend on the installed version and configured directories; a replacement must point to the same module.",
    recommendedReplacement:
      "Use an alias from the project's resolved Nuxt configuration. Concrete replacements are suggested only when the alias base is known.",
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
        const suggestion = verifiedAlias(ctx, target);
        report(
          ctx,
          node,
          RULE_ID,
          "warn",
          "imports",
          `"${source}" climbs ${source.split("../").length - 1} directories.`,
          suggestion
            ? `Import it as "${suggestion}".`
            : "Use an alias from this Nuxt project's resolved configuration that points to the same module.",
        );
      },
    };
  },
});

function verifiedAlias(ctx: RuleContext, target: string): string | undefined {
  const nuxt = ctx.project.nuxt;
  const manifest = nuxt?.manifest;
  if (!nuxt || !manifest?.isCurrent) return;
  const root = posix.resolve(ctx.project.root.replace(/\\/g, "/"));
  const file = posix.resolve(root, ctx.file.relativePath.replace(/\\/g, "/"));
  // Layer-local aliases can override the app-wide map. Omit a concrete replacement there.
  if (
    nuxt.localLayerAliases !== false &&
    nuxt.layers.some((layer) => {
      const layerRoot = posix.resolve(root, layer.root.replace(/\\/g, "/"));
      return layerRoot !== root && file.startsWith(`${layerRoot}/`);
    })
  )
    return;
  const absoluteTarget = posix.resolve(root, target);
  const aliases = Object.entries(manifest.aliases)
    .map(([alias, base]) => [alias, posix.resolve(root, base.replace(/\\/g, "/"))] as const)
    .sort(([a], [b]) => b.length - a.length);
  const candidates = aliases
    .filter(([alias]) => ALIASES.includes(alias))
    .sort(([, a], [, b]) => b.length - a.length);
  for (const [alias, base] of candidates) {
    const suffix = posix.relative(base, absoluteTarget);
    if (suffix === ".." || suffix.startsWith("../") || posix.isAbsolute(suffix)) continue;
    const specifier = suffix ? `${alias}/${suffix}` : alias;
    const resolved = aliases.find(([key]) => specifier === key || specifier.startsWith(`${key}/`));
    if (
      resolved &&
      posix.resolve(resolved[1], specifier.slice(resolved[0].length + 1)) === absoluteTarget
    )
      return specifier;
  }
}
