import { diagnostics } from "../diagnostics.js";
import {
  declaredIn,
  isPackageRuntimeSource,
  isTypeOnlyModuleReference,
  owningPackage,
  runtimeDeclaration,
} from "./nitro-package.js";
import { type AnyNode, createRule } from "./shared.js";

const RULE_ID = "nitro/dependencies/declare-nitro";
const NITRO_SPECIFIER = /^nitro(?:\/|$)/;

export const declareNitroDependency = createRule({
  meta: {
    id: RULE_ID,
    title: "Declare nitro in packages that import it",
    description:
      "Flags published packages whose shipped source imports nitro or a nitro/* subpath without declaring nitro in dependencies, peerDependencies, or optionalDependencies.",
    why: "Consumers do not install a package's devDependencies. A package that imports nitro/h3 or another nitro subpath without declaring nitro works in its own workspace but cannot resolve it under a strict install, and its consumers get no signal about which Nitro it needs. Packages that declare nuxt get Nitro through the Nuxt app that installs them.",
    recommendedReplacement:
      "Declare nitro in peerDependencies with the Nitro 3 range the package supports, and keep it in devDependencies for the package's own build and tests.",
    category: "dependencies",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/migration#h3-v2",
    requires: { script: true, nitro: true },
    activationScope: "workspace",
    prefilter: { names: ["nitro"] },
  },
  create(ctx) {
    const owner = owningPackage(ctx);
    if (!owner?.manifest.name || owner.manifest.private === true) return;
    if (!isPackageRuntimeSource(owner)) return;
    const manifest = owner.manifest;
    if (runtimeDeclaration(manifest, "nitro") !== undefined) return;
    // Nuxt layers and modules run inside a Nuxt app, which installs Nitro.
    if (["nuxt", "@nuxt/kit"].some((name) => runtimeDeclaration(manifest, name) !== undefined))
      return;
    let reported = false;
    const visit = (node: AnyNode) => {
      const source = node.source;
      if (reported || typeof source?.value !== "string" || !NITRO_SPECIFIER.test(source.value))
        return;
      if (isTypeOnlyModuleReference(node)) return;
      reported = true;
      const devOnly = declaredIn(manifest, "nitro").includes("devDependencies");
      ctx.report(
        diagnostics.NITRO0028({
          why: `${manifest.name} imports "${source.value}" but ${devOnly ? "declares nitro only in devDependencies" : "does not declare nitro"}. Consumers that install it under a strict layout cannot resolve nitro.`,
          fix: "Declare nitro in peerDependencies with the Nitro 3 range this package supports.",
        }),
        {
          ruleId: RULE_ID,
          severity: ctx.severity,
          category: "dependencies",
          file: ctx.file.path,
          range: ctx.range(source),
        },
      );
    };
    return {
      ImportDeclaration: visit,
      ExportNamedDeclaration: visit,
      ExportAllDeclaration: visit,
    };
  },
});
