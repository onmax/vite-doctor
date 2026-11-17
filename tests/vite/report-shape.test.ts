import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { createAgentReport, createJsonReport } from "../../src/core/index.ts";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { noConstantComputed } from "../../src/rule-packs/vue/rules/vue/no-constant-computed.ts";
import { noReactiveDestructure } from "../../src/rule-packs/vue/rules/vue/no-reactive-destructure.ts";
import { noWatchUseAttrs } from "../../src/rule-packs/vue/rules/vue/no-watch-use-attrs.ts";
import { runViteDoctor, viteDoctorExtensions } from "../../src/doctor.ts";
import { nuxtDoctorExtensions } from "../../src/rule-packs/nuxt/rules/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nitroRootWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "doctor-report-shape-"));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "workspace",
      private: true,
      devDependencies: { nitro: "^3.0.0" },
    }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/app/package.json": JSON.stringify({
      name: "@workspace/app",
      dependencies: { vue: "^3.5.0" },
    }),
    "packages/app/src/Save.vue": "<template><button>Save</button></template>\n",
    "packages/site/package.json": JSON.stringify({
      name: "@workspace/site",
      dependencies: { nuxt: "^4.0.0" },
    }),
    "packages/site/nuxt.config.ts": "export default defineNuxtConfig({})\n",
    "packages/site/app/app.vue": "<template><NuxtPage /></template>\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

test("every built-in Rule declares its confidence", async () => {
  const extensions = [
    ...(await viteDoctorExtensions({ root: tmpdir() })),
    ...nuxtDoctorExtensions(),
  ];
  const rules = new Map(
    extensions.flatMap((extension) =>
      (extension.rulePacks ?? []).flatMap((pack) =>
        pack.rules.map((rule) => [rule.meta.id, rule.meta.confidence] as const),
      ),
    ),
  );
  expect(rules.size).toBeGreaterThan(200);
  expect([...rules].filter(([, confidence]) => !confidence).map(([id]) => id)).toEqual([]);
});

test("the JSON report carries each Rule's confidence and only the evidence the Rule gave", async () => {
  const root = nitroRootWorkspace();
  const report = JSON.parse(createJsonReport(await runViteDoctor({ root, cache: false })));

  const button = report.diagnostics.find(
    (diagnostic: { rule: string }) => diagnostic.rule === "vue/template/html-button-has-type",
  );
  expect(button).toMatchObject({
    confidence: "proven",
    location: { path: "packages/app/src/Save.vue" },
  });
  expect(button).not.toHaveProperty("evidence");
  for (const diagnostic of report.diagnostics) {
    expect(diagnostic.evidence ?? []).not.toContainEqual(
      expect.objectContaining({ summary: expect.stringMatching(/^\w+ analysis$/) }),
    );
  }
});

test("the JSON report names the root's own framework and one Rule Pack list with its activating packages", async () => {
  const root = nitroRootWorkspace();
  const result = await runViteDoctor({ root, cache: false });
  const report = JSON.parse(createJsonReport(result));

  expect(report.reportVersion).toBe(4);
  expect(report.framework).toBe("nitro");
  expect(
    report.workspacePackages.map((item: { root: string; framework: string }) => [
      item.root,
      item.framework,
    ]),
  ).toEqual([
    [".", "nitro"],
    ["packages/app", "vue"],
    ["packages/site", "nuxt"],
  ]);
  expect(report.rulePacks).toEqual(
    expect.arrayContaining([
      { name: "vite-doctor/nuxt", selected: true, activatedBy: ["packages/site"] },
      { name: "vite-doctor/vue", selected: true, activatedBy: ["packages/app", "packages/site"] },
      { name: "vite-doctor/nitro", selected: true, activatedBy: [".", "packages/site"] },
    ]),
  );
  expect(report.rulePacks.map((pack: { name: string }) => pack.name)).toEqual([
    ...new Set(report.rulePacks.map((pack: { name: string }) => pack.name)),
  ]);

  const agent = JSON.parse(createAgentReport(result, { runOptions: { root } }));
  expect(agent.schema).toBe("vite-doctor.agent/v2");
  expect(agent.project.framework).toBe("nitro");
  expect(agent.rulePacks).toEqual(report.rulePacks);
});

test.each([
  [noConstantComputed, "const heading = computed(() => 'Events')"],
  [noReactiveDestructure, "const state = reactive({ count: 0 }); const { count } = state"],
  [noWatchUseAttrs, "const attrs = useAttrs(); watch(attrs, () => {})"],
  [
    noReactiveDestructure,
    "import { reactive } from 'vue'; const state = reactive({ child: null, ...loadState() }); const { child } = state",
  ],
])("unresolved Vue semantics stay heuristic for $meta.id", async (rule, source) => {
  const result = await runRuleFixture({
    framework: "vue",
    rule,
    files: { "src/App.vue": `<script setup>${source}</script><template><div /></template>` },
  });
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics.every((item) => item.confidence === "heuristic-high")).toBe(true);
});
