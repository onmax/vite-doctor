import { type AnyNode, createRule, report } from "./shared.js";

export const noV2Imports = createRule({
  meta: {
    id: "nitro/migration/no-v2-imports",
    title: "Replace Nitro 2 package imports",
    description: "Nitro 3 renamed the package and removed several Nitro 2 public subpaths.",
    why: "Nitro 3 publishes the nitro package and a smaller public export map, so Nitro 2 package names and removed subpaths no longer resolve.",
    recommendedReplacement:
      "Import from nitro and its documented Nitro 3 public subpaths. Use nitro/builder for the old builder entry points.",
    category: "migration",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/migration",
    requires: { script: true, nitro: true },
    applicability: {
      runtimes: { nitro: ">=3.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        const source = node.source?.value;
        if (typeof source !== "string") return;
        const replacement = v3Replacement(source, node);
        if (!replacement) return;
        report(
          ctx,
          node.source ?? node,
          "nitro/migration/no-v2-imports",
          "error",
          "migration",
          `${source} is not a supported Nitro 3 public import.`,
          replacement,
        );
      },
    };
  },
});

function v3Replacement(source: string, node: AnyNode): string | null {
  if (source === "nitropack") return rootPackageReplacement(node);
  if (source === "nitropack/config") {
    const importsDefineNitroConfig = node.specifiers?.some(
      (specifier: AnyNode) => specifier.imported?.name === "defineNitroConfig",
    );
    return importsDefineNitroConfig
      ? 'Replace defineNitroConfig with defineConfig and import it from "nitro".'
      : 'Import configuration APIs from "nitro".';
  }
  if (source === "nitropack/types") return 'Import types from "nitro/types".';
  if (source === "nitro/rollup" || source === "nitropack/core") {
    return 'Import builder APIs from "nitro/builder".';
  }
  if (source === "nitropack/kit" || source === "nitropack/presets") {
    return "Remove this import and migrate to a supported Nitro 3 API; this subpath has no direct replacement.";
  }
  if (source.startsWith("nitropack/runtime")) {
    return "Use the documented Nitro 3 public subpath for this runtime API.";
  }
  if (source.startsWith("nitro/deps/")) {
    return "Import the dependency directly; Nitro 3 removed nitro/deps subpaths.";
  }
  return null;
}

function rootPackageReplacement(node: AnyNode): string {
  const typeOnlyDeclaration = node.importKind === "type";
  const typeImports =
    typeOnlyDeclaration ||
    node.specifiers?.some((specifier: AnyNode) => specifier.importKind === "type");
  const valueImports =
    !typeOnlyDeclaration &&
    (node.specifiers?.length === 0 ||
      node.specifiers?.some((specifier: AnyNode) => specifier.importKind !== "type"));

  if (typeImports && valueImports) {
    return 'Import runtime values from "nitro" and types from "nitro/types".';
  }
  if (typeImports) return 'Import types from "nitro/types".';
  return 'Import from "nitro".';
}
