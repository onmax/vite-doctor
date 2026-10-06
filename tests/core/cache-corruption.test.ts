import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runDoctor } from "../../src/core/index.ts";
import { readStoreFile, writeStoreFile } from "./cache-store-file.ts";

test.each([
  ["null", () => null],
  ["missing facts", (facts: Record<string, unknown>) => ({ fileHash: facts.fileHash })],
  ["invalid imports", (facts: Record<string, unknown>) => ({ ...facts, imports: [null] })],
  ["invalid export", (facts: Record<string, unknown>) => ({ ...facts, exports: [null] })],
  [
    "invalid import source",
    (facts: Record<string, unknown>) => ({
      ...facts,
      imports: [{ source: {}, specifiers: [], kind: "value" }],
    }),
  ],
  [
    "invalid import specifiers",
    (facts: Record<string, unknown>) => ({
      ...facts,
      imports: [{ source: "./other", specifiers: null, kind: "value" }],
    }),
  ],
  [
    "invalid dynamic import",
    (facts: Record<string, unknown>) => ({ ...facts, dynamicImports: [{ source: {} }] }),
  ],
  ["invalid call", (facts: Record<string, unknown>) => ({ ...facts, calls: [null] })],
  ["invalid macro", (facts: Record<string, unknown>) => ({ ...facts, macros: [{ name: 1 }] })],
  [
    "invalid template ref",
    (facts: Record<string, unknown>) => ({ ...facts, templateRefs: [{ name: "div", value: {} }] }),
  ],
  [
    "invalid range",
    (facts: Record<string, unknown>) => ({
      ...facts,
      exports: [
        { name: "value", kind: "value", range: { start: "zero", end: 1, line: 1, column: 1 } },
      ],
    }),
  ],
  [
    "different file path",
    (facts: Record<string, unknown>) => ({ ...facts, path: "/different/app.ts" }),
  ],
  [
    "different inventory path",
    (facts: Record<string, unknown>) => ({ ...facts, relativePath: "other/app.ts" }),
  ],
  [
    "different source kind",
    (facts: Record<string, unknown>) => ({ ...facts, sourceKind: "module" }),
  ],
  [
    "different module name",
    (facts: Record<string, unknown>) => ({ ...facts, moduleName: "unexpected-module" }),
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
    const path = join(root, ".vite-doctor/cache/store.json");
    const store = readStoreFile(path);
    const original = structuredClone(store.facts);
    const [key, facts] = Object.entries(store.facts)[0]!;
    store.facts[key] = corrupt(facts) as Record<string, unknown>;
    writeStoreFile(path, store);

    const recovered = await runDoctor(options);
    expect(recovered.graph).toEqual(initial.graph);
    expect(recovered.diagnostics).toEqual(initial.diagnostics);
    expect(readStoreFile(path).facts).toEqual(original);
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
    const options = { root, framework: "vue" as const, cache: true, analyses: "graph" };
    await runDoctor(options);
    const path = join(root, ".vite-doctor/cache/store.json");
    const store = readStoreFile(path);
    const facts = Object.values(store.facts)[0]!;
    facts.diagnosticsHints = ["cache-reuse-control"];
    writeStoreFile(path, store);
    const edited = join(root, "src", file === "app.ts" ? "other.ts" : "Other.vue");
    // A second file makes the run rewrite the store, so it shows which facts it kept.
    writeFileSync(
      edited,
      file === "app.ts" ? "export const value = 1;" : "<template><p /></template>",
    );

    await runDoctor(options);

    expect(readStoreFile(path).facts[join(root, "src", file)]).toEqual(
      expect.objectContaining({ diagnosticsHints: ["cache-reuse-control"] }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
