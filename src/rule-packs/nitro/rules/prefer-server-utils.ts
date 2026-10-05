import { readFileSync, statSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { basename, dirname, relative, resolve } from "pathe";
import type { ProjectInfo, RuleContext } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { type AnyNode, createRule } from "./shared.js";
import {
  type NitroServerFile,
  nitroServerDirs,
  nitroServerFile,
  readStaticConfigOptions,
  runtimeMajor,
  staticOptionValue,
} from "./server-layout.js";

const RULE_ID = "nitro/structure/prefer-server-utils";
const SCANNED_SERVER_DIRS = new Set(["api", "routes", "middleware", "plugins", "tasks"]);
// Directories with their own Nitro meaning, or conventional homes for non-helper modules.
const NON_HELPER_DIRS = new Set([
  ...SCANNED_SERVER_DIRS,
  "utils",
  "assets",
  "public",
  "modules",
  "db",
  "database",
  "migrations",
  "types",
  "emails",
  "templates",
]);
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const RESOLVE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];

interface ImportedName {
  imported: string;
  local: string;
}

export const preferServerUtils = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep Nitro server helpers in server/utils",
    category: "imports",
    severity: "info",
    fixable: "suggestion",
    diagnosticCodes: ["NITRO0021", "NITRO0022"],
    docsUrl: "https://nuxt.com/docs/4.x/guide/directory-structure/server#server-utilities",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    const serverFile = nitroServerFile(ctx.project, ctx.file.path);
    if (!serverFile || !SCANNED_SERVER_DIRS.has(serverFile.dir)) return;
    if (!SCRIPT_FILE.test(ctx.file.path) || !serverAutoImportsEnabled(ctx.project)) return;
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.importKind === "type") return;
        const names = valueNames(node);
        if (!names.length) return;
        const target = resolveImport(ctx, String(node.source?.value ?? ""));
        if (!target) return;
        const targetFile = nitroServerFile(ctx.project, target);
        if (!targetFile || !targetFile.path.includes("/")) return;
        if (targetFile.dir === "utils") {
          reportAutoImported(ctx, node, names, targetFile, target);
          return;
        }
        if (NON_HELPER_DIRS.has(targetFile.dir)) return;
        reportAdHocHelper(ctx, node, names, targetFile, target);
      },
    };
  },
});

function reportAdHocHelper(
  ctx: RuleContext,
  node: AnyNode,
  names: ImportedName[],
  targetFile: NitroServerFile,
  target: string,
) {
  const utils = utilsDir(ctx.project, targetFile);
  const destination = `${utils}/${basename(target)}`;
  ctx.helpers.report(
    ctx,
    node,
    diagnostics.NITRO0021({
      why: `This server file imports ${formatNames(names.map((name) => name.imported))} from ${displayPath(ctx.project, target)}. Nitro does not auto-import from ${displayPath(ctx.project, resolve(targetFile.serverDir, targetFile.dir))}/, so every caller needs a relative import.`,
      fix: `Move ${displayPath(ctx.project, target)} to ${destination} and remove this import. Nitro auto-imports exports from ${utils}/ in server code and generates their types.`,
    }),
    { ruleId: RULE_ID, severity: "info", category: "imports" },
  );
}

function reportAutoImported(
  ctx: RuleContext,
  node: AnyNode,
  names: ImportedName[],
  targetFile: NitroServerFile,
  target: string,
) {
  const exported = exportedNames(ctx, target);
  const autoImported = names
    .filter((name) => name.local === name.imported && exported.has(name.imported))
    .map((name) => name.imported);
  if (!autoImported.length) return;
  const partial = autoImported.length < (node.specifiers?.length ?? 0);
  ctx.helpers.report(
    ctx,
    node,
    diagnostics.NITRO0022({
      why: `${formatNames(autoImported)} ${autoImported.length === 1 ? "is" : "are"} exported from ${displayPath(ctx.project, target)}, which Nitro already auto-imports in server code.`,
      fix: partial
        ? `Remove ${formatNames(autoImported)} from this import and use the auto-imported ${autoImported.length === 1 ? "name" : "names"} directly.`
        : `Remove this import; Nitro auto-imports exports from ${utilsDir(ctx.project, targetFile)}/.`,
    }),
    { ruleId: RULE_ID, severity: "info", category: "imports" },
  );
}

function serverAutoImportsEnabled(project: ProjectInfo): boolean {
  if (project.framework === "nuxt") {
    if (project.nuxt?.autoImportEnabled === false) return false;
    // Nuxt 4 runs on Nitro 2; later majors are not assumed to keep server auto-imports.
    const nitro =
      runtimeMajor(project, "nitro") ?? ((runtimeMajor(project, "nuxt") ?? 4) >= 5 ? 3 : 2);
    if (nitro >= 3) return false;
    const options = readStaticConfigOptions(project, "nuxt");
    return ![
      "imports.autoImport",
      "experimental.nitroAutoImports",
      "nitro.imports",
      "nitro.imports.autoImport",
    ].some((key) => staticOptionValue(options, (path) => path.join(".") === key) === false);
  }
  if (project.framework !== "nitro" || (runtimeMajor(project, "nitro") ?? 2) >= 3) return false;
  const options = readStaticConfigOptions(project, "nitro");
  return !["imports", "imports.autoImport"].some(
    (key) => staticOptionValue(options, (path) => path.join(".") === key) === false,
  );
}

function valueNames(node: AnyNode): ImportedName[] {
  return (node.specifiers ?? []).flatMap((specifier: AnyNode) => {
    if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") return [];
    const imported = specifier.imported?.name ?? specifier.imported?.value;
    const local = specifier.local?.name;
    return typeof imported === "string" && typeof local === "string" ? [{ imported, local }] : [];
  });
}

function resolveImport(ctx: RuleContext, source: string): string | null {
  const project = ctx.project;
  if (source.startsWith("./") || source.startsWith("../"))
    return resolveSourceFile(resolve(dirname(ctx.file.path), source));
  if (/^(?:~~|@@)\//.test(source)) return resolveSourceFile(resolve(project.root, source.slice(3)));
  if (/^[~@]\//.test(source)) {
    const base = project.nuxt?.appDir ?? nitroServerDirs(project)[0];
    return base ? resolveSourceFile(resolve(base, source.slice(2))) : null;
  }
  const aliases = Object.entries(project.nuxt?.manifest?.aliases ?? {});
  const serverDir = nitroServerDirs(project)[0];
  if (project.framework === "nuxt" && serverDir && !aliases.some(([alias]) => alias === "#server"))
    aliases.push(["#server", serverDir]);
  aliases.sort(([left], [right]) => right.length - left.length);
  for (const [alias, target] of aliases) {
    if (source !== alias && !source.startsWith(`${alias}/`)) continue;
    return resolveSourceFile(
      resolve(String(target), source.slice(alias.length).replace(/^\//, "")),
    );
  }
  return null;
}

function resolveSourceFile(path: string): string | null {
  if (isFile(path)) return SCRIPT_FILE.test(path) ? path : null;
  const withoutJsExtension = path.replace(/\.([cm]?)js$/, ".$1ts");
  if (withoutJsExtension !== path && isFile(withoutJsExtension)) return withoutJsExtension;
  const candidates = [path, resolve(path, "index")].flatMap((base) =>
    RESOLVE_EXTENSIONS.map((extension) => `${base}${extension}`),
  );
  return candidates.find(isFile) ?? null;
}

function isFile(path: string) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function exportedNames(ctx: RuleContext, file: string): Set<string> {
  const key = `${RULE_ID}:exports:${file}`;
  const cached = ctx.cache.get<string[]>(key);
  if (cached) return new Set(cached);
  const names = new Set<string>();
  try {
    const { program } = parseSync(file, readFileSync(file, "utf8"), {
      sourceType: "module",
      lang: file.endsWith("x") ? "tsx" : "ts",
    });
    for (const statement of program.body as AnyNode[]) {
      if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
      const declaration = statement.declaration;
      if (declaration?.type === "VariableDeclaration" && !declaration.declare)
        for (const item of declaration.declarations)
          if (item.id?.type === "Identifier") names.add(item.id.name);
      if (
        (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
        declaration.id?.name
      )
        names.add(declaration.id.name);
      for (const specifier of statement.specifiers ?? []) {
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        if (specifier.exportKind !== "type" && exported && exported !== "default")
          names.add(exported);
      }
    }
  } catch {
    return names;
  }
  ctx.cache.set(key, [...names]);
  return names;
}

function utilsDir(project: ProjectInfo, file: NitroServerFile) {
  const serverDir = relative(project.root, file.serverDir);
  return serverDir && serverDir !== "." ? `${serverDir}/utils` : "utils";
}

function displayPath(project: ProjectInfo, path: string) {
  return relative(project.root, path);
}

function formatNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
