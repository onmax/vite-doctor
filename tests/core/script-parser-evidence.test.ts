import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";
import { createAgentReport, createJsonReport, reportStatus } from "../../src/core/reports.ts";

const rule = "vite/env/no-client-secret-pattern";

test.each([
  ["src/main.ts", "const secret = import.meta.env.VITE_SECRET_TOKEN; const broken = ;"],
  ["src/main.js", "const secret = import.meta.env.VITE_SECRET_TOKEN; function ("],
  ["src/main.ts", "export type Draft ="],
  ["app.vue", '<script setup lang="ts">const value = ;</script><template><p>App</p></template>'],
])("marks failed script parsing in %s incomplete on cold and warm runs", async (file, source) => {
  await withProject({ [file]: source }, async (root) => {
    for (let run = 0; run < 2; run++) {
      const result = await runViteDoctor({ root, framework: "vite", rules: rule, cache: true });
      expect(reportStatus(result)).toBe("incomplete");
      expect(result.project.evidenceGaps).toEqual([
        expect.objectContaining({ source: "script-parser", files: [join(root, file)] }),
      ]);
      expect(JSON.parse(createJsonReport(result))).toMatchObject({ status: "incomplete" });
      expect(JSON.parse(createAgentReport(result))).toMatchObject({
        status: "incomplete",
        next: { action: "restore-evidence" },
      });
    }
  });
});

test("keeps diagnostics from successfully parsed files and clears the gap after repair", async () => {
  await withProject(
    {
      "src/good.ts": "export const secret = import.meta.env.VITE_SECRET_TOKEN;",
      "src/draft.ts": "export const draft = ;",
    },
    async (root) => {
      const options = { root, framework: "vite" as const, rules: rule, cache: true };
      const broken = await runViteDoctor(options);
      expect(reportStatus(broken)).toBe("incomplete");
      expect(broken.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VITE0009"]);

      await writeFile(join(root, "src/draft.ts"), "export const draft = 1;");
      const repaired = await runViteDoctor(options);
      expect(reportStatus(repaired)).toBe("findings");
      expect(repaired.project.evidenceGaps ?? []).toEqual([]);
      expect(repaired.diagnostics.map((diagnostic) => diagnostic.fingerprint)).toEqual(
        broken.diagnostics.map((diagnostic) => diagnostic.fingerprint),
      );
    },
  );
});

test.each(["", "// Work in progress\n", "export const value: string = 'ok';"])(
  "keeps valid empty, comment-only, or typed scripts complete: %s",
  async (source) => {
    await withProject({ "src/main.ts": source }, async (root) => {
      const result = await runViteDoctor({ root, framework: "vite", rules: rule, cache: false });
      expect(reportStatus(result)).toBe("clean");
      expect(result.project.evidenceGaps ?? []).toEqual([]);
    });
  },
);

test("does not require Markdown content to parse as JavaScript", async () => {
  await withProject(
    { "content/article.md": "# Article\n\nThis is prose, not a JavaScript program." },
    async (root) => {
      const result = await runViteDoctor({
        root,
        framework: "vite",
        rules: rule,
        config: { include: ["content/**/*.md"] },
        cache: false,
      });
      expect(result.scope.files).toBe(1);
      expect(reportStatus(result)).toBe("clean");
    },
  );
});

test.each(["js", "cjs"])("keeps recovered CommonJS .%s syntax complete", async (extension) => {
  const file = `src/main.${extension}`;
  await withProject(
    { [file]: "if (process.env.SKIP) return; module.exports = {};" },
    async (root) => {
      execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
      const result = await runViteDoctor({ root, framework: "vite", rules: rule, cache: false });
      expect(reportStatus(result)).toBe("clean");
      expect(result.project.evidenceGaps ?? []).toEqual([]);
    },
  );
});

async function withProject(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-parser-evidence-"));
  try {
    for (const [name, content] of Object.entries({ "package.json": "{}", ...files })) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
