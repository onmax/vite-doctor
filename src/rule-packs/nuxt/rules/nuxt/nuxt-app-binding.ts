import type { NuxtProjectInfo } from "../../../../core/index.js";
import type { ScopeReference } from "../../../../core/internal/script-scope.js";
import type { AnyNode } from "./shared.js";

/**
 * Whether `reference` names the Nuxt app export `name` from `#app/<module>`: an auto-import Nuxt
 * resolves to that module, or an import of it from `#app`, `#imports`, `nuxt/app` or the module.
 */
export function isNuxtAppExport(
  reference: ScopeReference | undefined,
  nuxt: NuxtProjectInfo,
  name: string,
  module: string,
): boolean {
  if (!reference) return false;
  const binding = reference.resolved;
  if (!binding) return nuxt.autoImportEnabled && isNuxtAutoImport(reference.identifier.name);
  return binding.defs.some((definition) => {
    if (definition.type !== "ImportBinding") return false;
    const { node, parent } = definition as { node: AnyNode; parent: AnyNode };
    if (
      node.type !== "ImportSpecifier" ||
      node.importKind === "type" ||
      parent?.type !== "ImportDeclaration" ||
      parent.importKind === "type"
    )
      return false;
    const imported = node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
    const source = parent.source.value;
    return source === "#imports"
      ? isNuxtAutoImport(imported)
      : imported === name && isNuxtAppSource(source, module);
  });

  function isNuxtAutoImport(local: string): boolean {
    const entry = nuxt.autoImports.get(local);
    if (!entry) return local === name && !nuxt.autoImportsAuthoritative;
    return (
      entry.name === name &&
      !entry.type &&
      (isNuxtAppSource(entry.from, module) || (entry.from === "#imports" && entry.kind === "nuxt"))
    );
  }
}

function isNuxtAppSource(source: string, module: string): boolean {
  if (/^(?:#app|nuxt\/app|nuxt)$/.test(source)) return true;
  const path = source.replace(/\.[cm]?[jt]s$/, "");
  return path === `#app/${module}` || path.endsWith(`/nuxt/dist/app/${module}`);
}
