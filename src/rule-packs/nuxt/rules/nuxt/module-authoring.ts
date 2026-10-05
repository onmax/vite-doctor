import { existsSync, statSync } from "node:fs";
import { resolve } from "pathe";
import type { NuxtModuleDefinition, RuleContext } from "../../../../core/index.js";
import { toPosixPath } from "./shared.js";

export {
  findDefaultNuxtModuleDefinition,
  unwrapExpression,
} from "../../../../core/internal/nuxt-module-inventory.js";

export const NUXT_KIT_SOURCES = new Set(["@nuxt/kit", "nuxt/kit"]);

const RESOLVABLE_EXTENSIONS = [
  ".ts",
  ".mts",
  ".js",
  ".mjs",
  ".tsx",
  ".jsx",
  ".vue",
  ".cjs",
  ".cts",
];

export function packageModuleEntry(ctx: RuleContext): NuxtModuleDefinition | undefined {
  const file = toPosixPath(ctx.file.path);
  return ctx.project.nuxtModuleDefinitions?.find(
    (definition) => definition.kind === "package" && toPosixPath(definition.entry) === file,
  );
}

export function packageModuleRuntime(ctx: RuleContext): NuxtModuleDefinition | undefined {
  const file = toPosixPath(ctx.file.path);
  return ctx.project.nuxtModuleDefinitions?.find(
    (definition) =>
      definition.kind === "package" &&
      !definition.layer &&
      definition.runtimeDir !== undefined &&
      isInside(definition.runtimeDir, file),
  );
}

export function moduleDefinitionScope(ctx: RuleContext): NuxtModuleDefinition | undefined {
  const file = toPosixPath(ctx.file.path);
  return ctx.project.nuxtModuleDefinitions?.find((definition) => {
    if (toPosixPath(definition.entry) === file) return true;
    if (definition.root === definition.entry) return false;
    if (!isInside(definition.root, file)) return false;
    return !definition.runtimeDir || !isInside(definition.runtimeDir, file);
  });
}

export function isRelativePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}

export function pathExistsFrom(base: string, path: string): boolean {
  const target = resolve(base, path);
  if (existsSync(target)) return true;
  if (RESOLVABLE_EXTENSIONS.some((extension) => existsSync(target + extension))) return true;
  if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) return false;
  return RESOLVABLE_EXTENSIONS.some((extension) =>
    existsSync(resolve(target, `index${extension}`)),
  );
}

export function staticStringValue(node: any): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && !node.expressions?.length && node.quasis?.length === 1)
    return node.quasis[0].value?.cooked ?? node.quasis[0].value?.raw;
  return undefined;
}

export function propertyKeyName(property: any): string | undefined {
  if (property?.type !== "Property" || property.computed) return undefined;
  const key = property.key;
  if (key?.type === "Identifier") return key.name;
  return staticStringValue(key);
}

export function findProperty(object: any, name: string): any {
  if (object?.type !== "ObjectExpression") return undefined;
  return object.properties?.find((property: any) => propertyKeyName(property) === name);
}

function isInside(directory: string, file: string): boolean {
  const root = toPosixPath(directory).replace(/\/$/, "");
  return file.startsWith(`${root}/`);
}
