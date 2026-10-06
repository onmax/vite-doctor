import type { FileFacts } from "../primitives.js";

export function isCachedFileFacts(value: unknown): value is FileFacts {
  if (!record(value)) return false;
  return (
    integer(value.fileId) &&
    typeof value.path === "string" &&
    typeof value.relativePath === "string" &&
    ["app", "layer", "module"].includes(value.sourceKind as string) &&
    optionalString(value.moduleName) &&
    ["ts", "tsx", "js", "jsx", "vue", "md", "mdc", "unknown"].includes(value.lang as string) &&
    typeof value.fileHash === "string" &&
    (value.sfc === undefined ||
      (record(value.sfc) &&
        optionalString(value.sfc.template) &&
        optionalString(value.sfc.script) &&
        optionalString(value.sfc.scriptSetup) &&
        strings(value.sfc.styles) &&
        strings(value.sfc.custom))) &&
    facts(
      value.imports,
      (item) => typeof item.source === "string" && strings(item.specifiers) && factKind(item.kind),
    ) &&
    facts(
      value.exports,
      (item) =>
        typeof item.name === "string" &&
        optionalString(item.localName) &&
        optionalString(item.source) &&
        factKind(item.kind),
    ) &&
    facts(
      value.dynamicImports,
      (item) => item.source === null || typeof item.source === "string",
    ) &&
    facts(value.calls, named) &&
    facts(value.macros, named) &&
    facts(value.templateRefs, (item) => named(item) && optionalString(item.value)) &&
    record(value.complexity) &&
    integer(value.complexity.cyclomatic) &&
    integer(value.complexity.cognitive) &&
    integer(value.complexity.lines, 1) &&
    record(value.tokens) &&
    strings(value.tokens.hashes) &&
    strings(value.diagnosticsHints)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function named(value: Record<string, unknown>): boolean {
  return typeof value.name === "string";
}

function factKind(value: unknown): boolean {
  return value === "value" || value === "type" || value === "mixed";
}

function facts(value: unknown, valid: (item: Record<string, unknown>) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => record(item) && valid(item) && optionalRange(item.range))
  );
}

function optionalRange(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      integer(value.start) &&
      integer(value.end) &&
      (value.end as number) >= (value.start as number) &&
      integer(value.line, 1) &&
      integer(value.column, 1))
  );
}
