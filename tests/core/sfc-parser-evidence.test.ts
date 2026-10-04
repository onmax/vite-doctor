import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";
import { createAgentReport, createJsonReport, reportStatus } from "../../src/core/reports.ts";

const rule = "vite/env/no-client-secret-pattern";

test.each([
  [
    "duplicate setup blocks",
    "<script setup>const value = 1</script><script setup>console.info(import.meta.env.VITE_API_SECRET)</script>",
    /only one <script setup>/,
  ],
  [
    "duplicate templates",
    "<template><div /></template><template><p /></template>",
    /only one <template>/,
  ],
  ["unclosed template elements", "<template><div></template>", /missing end tag/],
  ["missing component blocks", "", /at least one <template> or <script>/i],
])("marks %s incomplete on cold and cached runs", async (_name, source, message) => {
  await withProject({ "src/App.vue": source }, async (root) => {
    for (let run = 0; run < 2; run++) {
      const result = await runViteDoctor({ root, framework: "vite", rules: rule, cache: true });
      expect(reportStatus(result)).toBe("incomplete");
      expect(result.project.evidenceGaps).toEqual([
        {
          source: "vue-sfc-parser",
          message: expect.stringMatching(message),
          files: [join(root, "src/App.vue")],
        },
      ]);
      expect(JSON.parse(createJsonReport(result))).toMatchObject({ status: "incomplete" });
      expect(JSON.parse(createAgentReport(result))).toMatchObject({
        status: "incomplete",
        next: { action: "restore-evidence" },
      });
    }
  });
});

test("retains findings from a recovered SFC and clears its evidence gap after repair", async () => {
  const script = "<script setup>console.info(import.meta.env.VITE_API_SECRET)</script>";
  await withProject({ "src/App.vue": `${script}<template><div></template>` }, async (root) => {
    const options = { root, framework: "vite" as const, rules: rule, cache: true };
    const broken = await runViteDoctor(options);
    expect(reportStatus(broken)).toBe("incomplete");
    expect(broken.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["VITE0009"]);

    await writeFile(join(root, "src/App.vue"), `${script}<template><div /></template>`);
    const repaired = await runViteDoctor(options);
    expect(reportStatus(repaired)).toBe("findings");
    expect(repaired.project.evidenceGaps ?? []).toEqual([]);
    expect(repaired.diagnostics.map((diagnostic) => diagnostic.fingerprint)).toEqual(
      broken.diagnostics.map((diagnostic) => diagnostic.fingerprint),
    );
  });
});

test.each([
  "<template><div /></template>",
  "<script setup>const value = 1</script>",
  '<script>export default { name: "App" };</script><script setup>const value = 1</script><template>{{ value }}</template>',
  '<template lang="pug">div App</template>',
])("keeps compiler-valid SFC blocks complete: %s", async (source) => {
  await withProject({ "src/App.vue": source }, async (root) => {
    const result = await runViteDoctor({ root, framework: "vite", rules: rule, cache: false });
    expect(reportStatus(result)).toBe("clean");
    expect(result.project.evidenceGaps ?? []).toEqual([]);
  });
});

test("does not add SFC parser gaps for excluded files", async () => {
  await withProject(
    { "src/App.vue": "<template><div /></template>", "ignored/Bad.vue": "<template><div>" },
    async (root) => {
      const result = await runViteDoctor({
        root,
        framework: "vite",
        rules: rule,
        config: { exclude: ["ignored/**"] },
        cache: false,
      });
      expect(result.scope.files).toBe(1);
      expect(reportStatus(result)).toBe("clean");
      expect(result.project.evidenceGaps ?? []).toEqual([]);
    },
  );
});

async function withProject(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-sfc-evidence-"));
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
