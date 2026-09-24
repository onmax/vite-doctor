import * as v from "valibot";
import type { FileFacts } from "../primitives.js";

const range = v.object({
  start: v.number(),
  end: v.number(),
  line: v.number(),
  column: v.number(),
});

const namedFact = v.object({
  name: v.string(),
  range: v.optional(range),
});

const fileFactsSchema = v.object({
  fileId: v.number(),
  path: v.string(),
  relativePath: v.string(),
  sourceKind: v.picklist(["app", "layer", "module"]),
  moduleName: v.optional(v.string()),
  lang: v.picklist(["ts", "tsx", "js", "jsx", "vue", "md", "mdc", "unknown"]),
  fileHash: v.string(),
  sfc: v.optional(
    v.object({
      template: v.optional(v.string()),
      script: v.optional(v.string()),
      scriptSetup: v.optional(v.string()),
      styles: v.array(v.string()),
      custom: v.array(v.string()),
    }),
  ),
  imports: v.array(
    v.object({
      source: v.string(),
      specifiers: v.array(v.string()),
      kind: v.picklist(["value", "type", "mixed"]),
      range: v.optional(range),
    }),
  ),
  exports: v.array(
    v.object({
      name: v.string(),
      kind: v.picklist(["value", "type", "mixed"]),
      localName: v.optional(v.string()),
      source: v.optional(v.string()),
      range: v.optional(range),
    }),
  ),
  dynamicImports: v.array(v.object({ source: v.nullable(v.string()), range: v.optional(range) })),
  calls: v.array(namedFact),
  templateRefs: v.array(
    v.object({ name: v.string(), value: v.optional(v.string()), range: v.optional(range) }),
  ),
  macros: v.array(namedFact),
  complexity: v.object({ cyclomatic: v.number(), cognitive: v.number(), lines: v.number() }),
  tokens: v.object({ hashes: v.array(v.string()), normalizedTokens: v.array(v.string()) }),
  diagnosticsHints: v.array(v.string()),
});

export function parseCachedFileFacts(value: unknown): FileFacts | null {
  const result = v.safeParse(fileFactsSchema, value);
  return result.success ? result.output : null;
}
