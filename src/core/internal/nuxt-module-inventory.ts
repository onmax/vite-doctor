import { existsSync, readFileSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join, resolve } from "pathe";
import type { NuxtModuleDefinition } from "../primitives.js";
import { parseScript } from "./script.js";

type AnyNode = any;

const MODULE_EXTENSIONS = ["ts", "mts", "js", "mjs"];
const NUXT_KIT_SOURCES = new Set(["@nuxt/kit", "nuxt/kit"]);
const NUXT_CONFIG_FILES = ["ts", "mts", "js", "mjs", "cjs", "cts"].map(
  (extension) => `nuxt.config.${extension}`,
);

interface ModulePackageJson {
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  devDependencies?: Record<string, string>;
}

export interface NuxtModuleDefinitionNode {
  call: AnyNode;
  definition: AnyNode;
  typeArguments: AnyNode;
}

export async function detectNuxtModuleDefinitions(
  root: string,
  appRoots: string[],
): Promise<NuxtModuleDefinition[]> {
  const packageModule = detectPackageModule(root);
  if (packageModule) return [packageModule];
  return detectLocalModules(appRoots.length ? appRoots : [root]);
}

export function findDefaultNuxtModuleDefinition(program: AnyNode): NuxtModuleDefinitionNode | null {
  const body: AnyNode[] = program?.body ?? [];
  const locals = new Set<string>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (!NUXT_KIT_SOURCES.has(String(statement.source?.value))) continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
      const imported = specifier.imported?.name ?? specifier.imported?.value;
      if (imported === "defineNuxtModule") locals.add(specifier.local.name);
    }
  }
  if (!locals.size) return null;
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  if (!exported) return null;
  let expression = unwrapExpression(exported.declaration);
  if (expression?.type === "Identifier") {
    expression = unwrapExpression(findTopLevelInitializer(body, expression.name));
  }
  return matchDefineNuxtModuleCall(expression, locals);
}

export function unwrapExpression(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
    ].includes(current.type)
  )
    current = current.expression;
  return current;
}

function matchDefineNuxtModuleCall(
  expression: AnyNode,
  locals: Set<string>,
): NuxtModuleDefinitionNode | null {
  if (expression?.type !== "CallExpression") return null;
  const callee = expression.callee;
  if (callee?.type === "Identifier" && locals.has(callee.name)) {
    return {
      call: expression,
      definition: expression.arguments?.[0],
      typeArguments: expression.typeArguments ?? expression.typeParameters,
    };
  }
  const inner = callee?.type === "MemberExpression" ? callee.object : undefined;
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.name === "with" &&
    inner?.type === "CallExpression" &&
    inner.callee?.type === "Identifier" &&
    locals.has(inner.callee.name)
  ) {
    return {
      call: expression,
      definition: expression.arguments?.[0],
      typeArguments: inner.typeArguments ?? inner.typeParameters,
    };
  }
  return null;
}

function findTopLevelInitializer(body: AnyNode[], name: string): AnyNode {
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type === "Identifier" && declarator.id.name === name)
        return declarator.init;
    }
  }
  return undefined;
}

function detectPackageModule(root: string): NuxtModuleDefinition | undefined {
  const packageJson = readJson<ModulePackageJson>(join(root, "package.json"));
  if (!packageJson) return undefined;
  const distEntries = packageEntryTargets(packageJson)
    .map((target) => target.replace(/^\.\//, ""))
    .map((target) => target.match(/^dist\/(.+)\.(?:mjs|cjs|js)$/)?.[1])
    .filter((name): name is string => Boolean(name));
  const hasModuleBuilder = Boolean(packageJson.devDependencies?.["@nuxt/module-builder"]);
  if (!hasModuleBuilder && !distEntries.length) return undefined;
  const names = [...new Set(["module", ...distEntries])];
  for (const name of names) {
    for (const extension of MODULE_EXTENSIONS) {
      const entry = resolve(root, "src", `${name}.${extension}`);
      if (!isFile(entry) || !definesNuxtModule(entry)) continue;
      const sourceDir = dirname(entry);
      return {
        kind: "package",
        entry,
        root: sourceDir,
        runtimeDir: join(sourceDir, "runtime"),
        layer: NUXT_CONFIG_FILES.some((file) => existsSync(join(root, file))),
      };
    }
  }
  return undefined;
}

async function detectLocalModules(appRoots: string[]): Promise<NuxtModuleDefinition[]> {
  const definitions: NuxtModuleDefinition[] = [];
  const extensions = MODULE_EXTENSIONS.join(",");
  for (const appRoot of [...new Set(appRoots)].sort()) {
    const modulesDir = join(appRoot, "modules");
    if (!existsSync(modulesDir)) continue;
    for await (const entry of glob([`*.{${extensions}}`, `*/index.{${extensions}}`], {
      cwd: modulesDir,
    })) {
      if (typeof entry !== "string") continue;
      const file = resolve(modulesDir, entry);
      if (!isFile(file)) continue;
      const isDirectoryModule = entry.includes("/");
      const moduleRoot = isDirectoryModule ? dirname(file) : file;
      definitions.push({
        kind: "local",
        entry: file,
        root: moduleRoot,
        ...(isDirectoryModule ? { runtimeDir: join(moduleRoot, "runtime") } : {}),
      });
    }
  }
  return definitions.sort((left, right) => left.entry.localeCompare(right.entry));
}

function packageEntryTargets(packageJson: ModulePackageJson): string[] {
  const targets: string[] = [];
  for (const value of [packageJson.main, packageJson.module]) {
    if (typeof value === "string") targets.push(value);
  }
  const exportsField = packageJson.exports;
  const rootExport =
    exportsField && typeof exportsField === "object" && "." in exportsField
      ? (exportsField as Record<string, unknown>)["."]
      : exportsField;
  collectStrings(rootExport, targets);
  return targets;
}

function collectStrings(value: unknown, into: string[]) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith(".")) continue;
      collectStrings(item, into);
    }
  }
}

function definesNuxtModule(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (!text.includes("defineNuxtModule")) return false;
  return Boolean(findDefaultNuxtModuleDefinition(parseScript(file, text)));
}

function isFile(file: string): boolean {
  return Boolean(statSync(file, { throwIfNoEntry: false })?.isFile());
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
