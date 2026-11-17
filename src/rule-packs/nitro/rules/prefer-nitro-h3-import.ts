import { diagnostics } from "../diagnostics.js";
import {
  declaresOnlyNitro3,
  installedNitroH3Exports,
  isLibrary,
  isPackageRuntimeSource,
  isTypeOnlyModuleReference,
  owningPackage,
  runtimeDeclaration,
  type NitroH3Exports,
  type OwningPackage,
} from "./nitro-package.js";
import { nitroServerFile } from "./server-layout.js";
import { type AnyNode, createRule, isNitroServerFile } from "./shared.js";
import type { RuleContext } from "../../../core/index.js";

const RULE_ID = "nitro/h3/prefer-nitro-h3";

export const preferNitroH3Import = createRule({
  meta: {
    id: RULE_ID,
    title: "Import H3 through nitro/h3 in Nitro 3 server code",
    description:
      "Flags value imports and re-exports from h3 in Nitro 3 server code and in packages that declare nitro as a runtime dependency.",
    why: "Nitro 3 imports every H3 utility from nitro/h3, which re-exports the h3 Nitro runs. In a Nuxt 5 app, server code from a package that imports values from h3 makes Nuxt treat it as Nitro v2 code, apply its Nitro v2 compatibility layer to the whole app, and warn NUXT_B9003. In app server code, a bare h3 import resolves the h3 the app installs, which matches Nitro's only while the two ranges stay in step.",
    recommendedReplacement:
      'Import H3 values from "nitro/h3". Type-only imports from "h3" can stay.',
    category: "h3",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/migration#h3-v2",
    requires: { script: true, nitro: true },
    activationScope: "workspace",
    prefilter: { names: ["h3"] },
    applicability: {
      runtimes: { nitro: ">=3.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    const scope = nitroCodeScope(ctx);
    if (!scope) return;
    const visit = (node: AnyNode) => {
      const source = node.source;
      if (source?.value !== "h3" || isTypeOnlyModuleReference(node)) return;
      const exports = installedNitroH3Exports(ctx, scope.dir);
      const available = exports !== undefined && reexportsEveryName(node, exports);
      ctx.report(
        diagnostics.NITRO0027({
          why:
            scope.kind === "package"
              ? `${scope.name} runs on Nitro 3 but imports H3 values from "h3". In a Nuxt 5 app, Nuxt treats server code that imports values from h3 as Nitro v2 code, applies its Nitro v2 compatibility layer to the whole app, and warns NUXT_B9003 naming this package.`
              : `This Nitro 3 server file imports H3 values from "h3". Nitro 3 imports every H3 utility from nitro/h3, which re-exports the h3 Nitro runs; a bare h3 import resolves the h3 the app installs, which matches only while its range stays in step with Nitro's.`,
          fix: available
            ? 'Review H3 v2 API and host compatibility changes before importing from "nitro/h3". Exported names alone do not establish compatible behavior.'
            : exports
              ? 'Import from "nitro/h3", after replacing the names the installed nitro/h3 does not export.'
              : 'Import from "nitro/h3". Doctor could not read the installed nitro/h3 exports, so check that it exports every name this import uses.',
        }),
        {
          ruleId: RULE_ID,
          severity: ctx.severity,
          category: "h3",
          file: ctx.file.path,
          range: ctx.range(source),
          fix: null,
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

type NitroCodeScope = { kind: "app"; dir: string } | { kind: "package"; dir: string; name: string };

/**
 * Nitro server code of an app, by Doctor's server-directory detection, or the shipped source of a
 * package that declares Nitro 3 as a runtime dependency. A package that only develops against
 * Nitro, or that also accepts Nitro 2, has no evidence its code runs where nitro/h3 exists.
 */
function nitroCodeScope(ctx: RuleContext): NitroCodeScope | undefined {
  const owner = owningPackage(ctx);
  const dir = owner?.dir ?? ctx.project.root;
  // Directory containment must not override a library's own runtime contract.
  if (owner && !isPackageRuntimeSource(owner)) return undefined;
  if (!owner || !isLibrary(owner.manifest)) {
    if (owner && owner.dir !== ctx.project.root && !["nuxt", "nitro"].includes(owner.framework))
      return undefined;
    if (nitroServerFile(ctx, ctx.file.path) || isNitroServerFile(ctx) || isOwnServerFile(owner))
      return { kind: "app", dir };
    return undefined;
  }
  if (owner.framework === "nuxt") return undefined;
  if (runtimeDeclaration(owner.manifest, "nitropack") !== undefined) return undefined;
  const nitro = runtimeDeclaration(owner.manifest, "nitro");
  if (nitro === undefined || !declaresOnlyNitro3(ctx, nitro)) return undefined;
  return { kind: "package", dir, name: owner.manifest.name ?? "This package" };
}

/** A Nuxt or Nitro workspace package's own `server/` directory, below the Doctor Run root. */
function isOwnServerFile(owner: OwningPackage | undefined) {
  return (
    !!owner &&
    (owner.framework === "nuxt" || owner.framework === "nitro") &&
    !isLibrary(owner.manifest) &&
    /^(?:app\/)?server\//.test(owner.path) &&
    isPackageRuntimeSource(owner)
  );
}

function reexportsEveryName(node: AnyNode, exports: NitroH3Exports): boolean {
  if (node.type === "ExportAllDeclaration") return exports.reexportsH3;
  for (const specifier of (node.specifiers ?? []) as AnyNode[]) {
    if (specifier.type === "ImportNamespaceSpecifier") {
      if (!exports.reexportsH3) return false;
      continue;
    }
    const name =
      specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : node.type === "ExportNamedDeclaration"
          ? (specifier.local?.name ?? specifier.local?.value)
          : (specifier.imported?.name ?? specifier.imported?.value);
    const typeOnly = (specifier.importKind ?? specifier.exportKind) === "type";
    if (exports.names.has(name) || (typeOnly && exports.reexportsH3)) continue;
    return false;
  }
  return true;
}
