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
])("extension cache keys retain distinct file identities: %s and %s", async (first, second) => {
  const root = mkdtempSync(join(tmpdir(), "doctor-cache-identity-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    for (const path of [first, second]) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "export const value = true;");
    }
    const observed: Array<{ file: string; cached?: string }> = [];
    const rule = createRule({
      meta: {
        id: "test/cache-identity",
        title: "Cache extension file facts",
        category: "correctness",
        severity: "warn",
        requires: { script: true },
      },
      create(ctx) {
        const file = ctx.file.relativePath;
        const key = `fileFacts:test/cache-identity:${file}`;
        const cached = ctx.cache.get<{ file: string }>(key);
        observed.push({ file, cached: cached?.file });
        if (!cached) ctx.cache.set(key, { file });
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
    await runDoctor(options);
    expect(observed).toHaveLength(2);
    expect(observed).toEqual(
      expect.arrayContaining([first, second].map((file) => ({ file, cached: undefined }))),
    );
    observed.length = 0;

    await runDoctor(options);
    expect(observed).toHaveLength(2);
    expect(observed).toEqual(
      expect.arrayContaining([first, second].map((file) => ({ file, cached: file }))),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
