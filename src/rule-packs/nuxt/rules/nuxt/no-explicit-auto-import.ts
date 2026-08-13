import { dirname, isAbsolute, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import {
  AnyNode,
  createRule,
  includeTrailingNewline,
  isNuxtRuntimeFile,
  toPosixPath,
} from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const noExplicitAutoImport = createRule({
  meta: {
    id: "nuxt/imports/no-explicit-auto-import",
    title: "Use configured Nuxt auto-imports directly",
    category: "imports",
    severity: "info",
    fixable: "safe",
    docsUrl: "https://nuxt.com/docs/4.x/guide/concepts/auto-imports#explicit-imports",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        if (
          !isNuxtRuntimeFile(ctx) ||
          !ctx.project.nuxt?.autoImportEnabled ||
          !ctx.project.nuxt.autoImportsAuthoritative
        )
          return;
        if (!isAutoImportTransformEnabled(ctx.file.path, ctx.project.nuxt.manifest)) return;
        const source = String(node.source?.value ?? "");
        const specifiers =
          node.specifiers?.filter((specifier: AnyNode) => {
            if (specifier.type !== "ImportSpecifier") return false;
            if (node.importKind === "type" || specifier.importKind === "type") return false;
            const imported = String(specifier.imported?.name ?? specifier.imported?.value ?? "");
            const local = String(specifier.local?.name ?? imported);
            const entry = ctx.project.nuxt?.autoImports.get(
              source === "#imports" ? imported : local,
            );
            if (!entry || entry.type) return false;
            if (source === "#imports")
              return local === imported && imported === (entry.as ?? entry.name);
            return (
              imported === entry.name &&
              local === (entry.as ?? entry.name) &&
              sameImportSource(ctx, source, entry.from)
            );
          }) ?? [];
        if (!specifiers.length) return;
        const all = specifiers.length === node.specifiers.length;
        ctx.report(
          diagnostics.NUXT0036({
            why: "This imports symbols that Nuxt is configured to auto-import in this file.",
            fix: "Remove the explicit import when all specifiers are auto-imported.",
          }),
          {
            ruleId: "nuxt/imports/no-explicit-auto-import",
            severity: ctx.severity,
            category: "imports",
            file: ctx.file.path,
            range: ctx.range(node),
            fix: all
              ? {
                  kind: "safe",
                  edits: [
                    {
                      range: {
                        start: node.start,
                        end: includeTrailingNewline(ctx.file.text, node.end),
                      },
                      text: "",
                    },
                  ],
                }
              : null,
          },
        );
      },
    };
  },
});

function sameImportSource(ctx: RuleContext, source: string, autoImportSource: string) {
  const explicit = resolveImportSource(ctx, source);
  const automatic = resolveImportSource(ctx, autoImportSource);
  return explicit && automatic ? explicit === automatic : source === autoImportSource;
}

function resolveImportSource(ctx: RuleContext, source: string): string | null {
  if (isAbsolute(source)) return canonicalPath(source);
  if (source.startsWith("~~/") || source.startsWith("@@/"))
    return canonicalPath(resolve(ctx.project.root, source.slice(3)));
  if (source.startsWith("~/") || source.startsWith("@/"))
    return canonicalPath(resolve(ctx.project.nuxt!.appDir, source.slice(2)));
  if (source.startsWith(".")) return canonicalPath(resolve(dirname(ctx.file.path), source));

  const aliases = Object.entries(ctx.project.nuxt!.manifest?.aliases ?? {}).sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [alias, target] of aliases) {
    if (source !== alias && !source.startsWith(`${alias}/`)) continue;
    return canonicalPath(resolve(String(target), source.slice(alias.length).replace(/^\//, "")));
  }
  return null;
}

function canonicalPath(path: string) {
  return toPosixPath(resolve(path))
    .replace(/\.(?:[cm]?[jt]sx?|vue)$/, "")
    .replace(/\/index$/, "");
}

function isAutoImportTransformEnabled(
  file: string,
  manifest: NonNullable<RuleContext["project"]["nuxt"]>["manifest"],
) {
  const transform = manifest?.autoImportTransform;
  if (!transform) return true;
  if (transform.include.some((pattern) => matchesPattern(file, pattern))) return true;
  return !transform.exclude.some((pattern) => matchesPattern(file, pattern));
}

function matchesPattern(file: string, pattern: { source: string; flags: string }) {
  try {
    return new RegExp(pattern.source, pattern.flags).test(file);
  } catch {
    return false;
  }
}
