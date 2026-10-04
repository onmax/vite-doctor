import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runDoctor } from "../../src/core/index.ts";

test.each([
  ["invalid JSON", () => "{"],
  ["null", () => "null"],
  [
    "missing facts",
    (facts: Record<string, unknown>) => JSON.stringify({ fileHash: facts.fileHash }),
  ],
  [
    "invalid imports",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, imports: [null] }),
  ],
  [
    "invalid tokens",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, tokens: null }),
  ],
  [
    "invalid export",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, exports: [null] }),
  ],
  [
    "invalid import source",
    (facts: Record<string, unknown>) =>
      JSON.stringify({ ...facts, imports: [{ source: {}, specifiers: [], kind: "value" }] }),
  ],
  [
    "invalid import specifiers",
    (facts: Record<string, unknown>) =>
      JSON.stringify({
        ...facts,
        imports: [{ source: "./other", specifiers: null, kind: "value" }],
      }),
  ],
  [
    "invalid dynamic import",
    (facts: Record<string, unknown>) =>
      JSON.stringify({ ...facts, dynamicImports: [{ source: {} }] }),
  ],
  ["invalid call", (facts: Record<string, unknown>) => JSON.stringify({ ...facts, calls: [null] })],
  [
    "invalid macro",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, macros: [{ name: 1 }] }),
  ],
  [
    "invalid template ref",
    (facts: Record<string, unknown>) =>
      JSON.stringify({ ...facts, templateRefs: [{ name: "div", value: {} }] }),
  ],
  [
    "invalid complexity",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, complexity: null }),
  ],
  [
    "invalid hashes",
    (facts: Record<string, unknown>) =>
      JSON.stringify({ ...facts, tokens: { hashes: [null], normalizedTokens: [] } }),
  ],
  [
    "invalid range",
    (facts: Record<string, unknown>) =>
      JSON.stringify({
        ...facts,
        exports: [
          { name: "value", kind: "value", range: { start: "zero", end: 1, line: 1, column: 1 } },
        ],
      }),
  ],
  [
    "different file path",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, path: "/different/app.ts" }),
  ],
  [
    "different inventory path",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, relativePath: "other/app.ts" }),
  ],
  [
    "different source kind",
    (facts: Record<string, unknown>) => JSON.stringify({ ...facts, sourceKind: "module" }),
  ],
  [
    "different module name",
    (facts: Record<string, unknown>) =>
      JSON.stringify({ ...facts, moduleName: "unexpected-module" }),
  ],
] as const)("Doctor regenerates a corrupt cache entry: %s", async (_name, corrupt) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-cache-corruption-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/app.ts"), "export const value = true;");
    const options = {
      root,
      framework: "vite" as const,
      cache: true,
      analyses: "graph,dupes,health",
    };
    const initial = await runDoctor(options);
    const cache = join(root, ".vite-doctor/cache");
    const entry = readdirSync(cache)[0]!;
    const path = join(cache, entry);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, corrupt(JSON.parse(original)));

    const recovered = await runDoctor(options);
    expect(recovered.graph).toEqual(initial.graph);
    expect(recovered.diagnostics).toEqual(initial.diagnostics);
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  [
    "app.ts",
    "import { value } from './other'; export { value }; import('./lazy'); console.log(value);",
  ],
  [
    "Component.vue",
    '<script setup lang="ts">import { ref } from "vue"; const value = ref(0)</script><template><div>{{ value }}</div></template><style>.a { color: red }</style>',
  ],
])("Doctor reuses valid cached FileFacts for %s", async (file, source) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-cache-valid-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", file), source);
    const options = { root, framework: "vue" as const, cache: true };
    await runDoctor(options);
    const cache = join(root, ".vite-doctor/cache");
    const path = join(cache, readdirSync(cache)[0]!);
    const facts = JSON.parse(readFileSync(path, "utf8"));
    facts.diagnosticsHints = ["cache-reuse-control"];
    writeFileSync(path, JSON.stringify(facts));

    await runDoctor(options);

    expect(JSON.parse(readFileSync(path, "utf8")).diagnosticsHints).toEqual([
      "cache-reuse-control",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
