import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

test.each([
  ["src/a.ts", "src_a.ts"],
  ["src/á.ts", "src/é.ts"],
  [`src/${"nested/".repeat(40)}a.ts`, `src/${"nested/".repeat(40)}b.ts`],
])("Rule memory keys retain distinct file identities: %s and %s", async (first, second) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-cache-identity-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    for (const path of [first, second]) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "export const value = true;");
    }
    const observed: Array<{ file: string; own?: string; other?: string }> = [];
    const rule = createRule({
      meta: {
        id: "test/cache-identity",
        title: "Remember file identities",
        category: "correctness",
        severity: "warn",
        requires: { script: true },
      },
      create(ctx) {
        const file = ctx.file.relativePath;
        const other = file === first ? second : first;
        const own = ctx.cache.get<{ file: string }>(`test/cache-identity:${file}`);
        ctx.cache.set(`test/cache-identity:${file}`, { file });
        const remembered = ctx.cache.get<{ file: string }>(`test/cache-identity:${other}`);
        observed.push({ file, own: own?.file, other: remembered?.file });
        return {};
      },
    });
    const options = {
      root,
      framework: "vite" as const,
      cache: true,
      extensions: [
        defineDoctorExtension({
          name: "test/cache-identity",
          rulePacks: [
            defineRulePack({
              name: "test/cache-identity",
              version: "0.0.0",
              rules: [rule],
              presets: { recommended: [rule.meta.id] },
            }),
          ],
        }),
      ],
    };
    const [firstFile, secondFile] = [first, second].sort((a, b) => a.localeCompare(b));
    const expected = [
      { file: firstFile, own: undefined, other: undefined },
      { file: secondFile, own: undefined, other: firstFile },
    ];
    await runDoctor(options);
    expect(observed).toEqual(expected);
    observed.length = 0;

    // Rule memory lives for one Doctor Run, so nothing a Rule remembered leaks into the next.
    await runDoctor({ ...options, cache: false });
    expect(observed).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
