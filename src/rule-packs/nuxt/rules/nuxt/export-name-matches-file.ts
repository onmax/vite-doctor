import { basename, relative, resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/composables/export-name-matches-file";
const COMPOSABLE_NAME = /^use[A-Z0-9]/;

interface NamedExport {
  name: string;
  node: AnyNode;
}

export const exportNameMatchesFile = createRule({
  meta: {
    id: RULE_ID,
    title: "Match composable exports to their file name",
    category: "composables",
    severity: "info",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/directory-structure/app/composables#how-files-are-scanned",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const fileName = scannedComposableFileName(ctx);
    if (!fileName) return;
    const autoImportName = defaultExportAutoImportName(fileName);

    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const defaultExport = findDefaultExport(node);
        if (defaultExport) {
          if (COMPOSABLE_NAME.test(autoImportName)) return;
          const target = `use${upperFirst(autoImportName)}`;
          ctx.report(
            diagnostics.NUXT0080({
              why: `Nuxt auto-imports the default export of ${basename(ctx.file.path)} as ${autoImportName}, a name that does not start with "use", so callers cannot tell it is a composable.`,
              fix: `Rename the file to ${target}${extension(ctx.file.path)} so the default export is auto-imported as ${target}, or replace it with a named export called ${target}.`,
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "composables",
              file: ctx.file.path,
              range: ctx.range(defaultExport),
            },
          );
          return;
        }

        if (!COMPOSABLE_NAME.test(autoImportName)) return;
        const exports = namedValueExports(node);
        if (exports === null) return;
        const composables = exports.filter((entry) => COMPOSABLE_NAME.test(entry.name));
        if (!composables.length || composables.some((entry) => entry.name === autoImportName))
          return;
        const names = composables.map((entry) => entry.name).join(", ");
        const casing = composables.find(
          (entry) => entry.name.toLowerCase() === autoImportName.toLowerCase(),
        );
        const subject = casing ?? composables[0]!;
        const fix = casing
          ? `Make the casing match: rename ${casing.name} to ${autoImportName} or the file to ${casing.name}${extension(ctx.file.path)}.`
          : composables.length > 1
            ? `Export the main composable as ${autoImportName}, or rename the file after the composable it is organized around.`
            : `Rename ${subject.name} to ${autoImportName}, or rename the file to ${subject.name}${extension(ctx.file.path)} so the file name matches the composable it exports.`;
        ctx.report(
          diagnostics.NUXT0079({
            why: casing
              ? `${basename(ctx.file.path)} suggests it provides ${autoImportName}, but Nuxt auto-imports ${casing.name}, which differs only in casing.`
              : `${basename(ctx.file.path)} suggests it provides ${autoImportName}, but Nuxt auto-imports its named exports as ${names}.`,
            fix,
          }),
          {
            ruleId: RULE_ID,
            severity: ctx.severity,
            category: "composables",
            file: ctx.file.path,
            range: ctx.range(subject.node),
          },
        );
      },
    };
  },
});

function scannedComposableFileName(ctx: RuleContext): string | null {
  const nuxt = ctx.project.nuxt;
  if (!nuxt || ctx.file.isVueSfc) return null;
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(ctx.file.path) || /\.d\.[cm]?ts$/.test(ctx.file.path))
    return null;
  const roots = new Set<string>([nuxt.appDir]);
  for (const layer of nuxt.layers ?? []) if (layer.srcDir) roots.add(layer.srcDir);
  for (const root of nuxt.appRoots ?? []) {
    roots.add(root);
    roots.add(resolve(root, "app"));
  }
  for (const root of roots) {
    const path = relative(resolve(ctx.project.root, root), ctx.file.path);
    const match = /^composables\/([^/]+)$/.exec(path);
    if (!match) continue;
    const name = match[1]!.replace(/\.[^.]+$/, "");
    return name === "index" ? null : name;
  }
  return null;
}

// Mirrors unimport's scanExports(): the default export takes the file name, camelCased
// only when it contains "-", "_" or ".".
function defaultExportAutoImportName(fileName: string) {
  if (!/[-_.]/.test(fileName)) return fileName;
  return lowerFirst(fileName.split(/[-_.]/).filter(Boolean).map(upperFirst).join(""));
}

function findDefaultExport(program: AnyNode): AnyNode {
  for (const statement of program.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      if (statement.declaration?.type?.startsWith("TS")) continue;
      return statement.declaration?.id ?? statement;
    }
    if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
      const specifier = (statement.specifiers ?? []).find(
        (entry: AnyNode) => entry.exportKind !== "type" && exportedName(entry) === "default",
      );
      if (specifier) return specifier;
    }
  }
  return null;
}

function namedValueExports(program: AnyNode): NamedExport[] | null {
  const exports: NamedExport[] = [];
  for (const statement of program.body ?? []) {
    if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") continue;
      if (!statement.exported) return null;
      exports.push({ name: exportedName({ exported: statement.exported })!, node: statement });
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
      if (declaration.id) exports.push({ name: declaration.id.name, node: declaration.id });
    } else if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations ?? [])
        for (const id of patternIdentifiers(declarator.id))
          exports.push({ name: id.name, node: id });
    }
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.exportKind === "type") continue;
      const name = exportedName(specifier);
      if (name && name !== "default") exports.push({ name, node: specifier.exported });
    }
  }
  return exports;
}

function exportedName(specifier: AnyNode): string | null {
  return specifier.exported?.name ?? specifier.exported?.value ?? null;
}

function patternIdentifiers(pattern: AnyNode): AnyNode[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern];
  if (pattern.type === "AssignmentPattern") return patternIdentifiers(pattern.left);
  if (pattern.type === "RestElement") return patternIdentifiers(pattern.argument);
  if (pattern.type === "ObjectPattern")
    return (pattern.properties ?? []).flatMap((property: AnyNode) =>
      patternIdentifiers(property.value ?? property.argument),
    );
  if (pattern.type === "ArrayPattern")
    return (pattern.elements ?? []).flatMap((element: AnyNode) => patternIdentifiers(element));
  return [];
}

function extension(path: string) {
  return /\.[^.]+$/.exec(path)?.[0] ?? ".ts";
}

function upperFirst(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function lowerFirst(value: string) {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}
