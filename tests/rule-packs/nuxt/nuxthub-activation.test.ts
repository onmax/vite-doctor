import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { runDoctor } from "../../../src/core/index.ts";
import { nuxtHubRulePack } from "../../../src/rule-packs/nuxt/rules/nuxthub.ts";

const source = "export default cachedEventHandler(event => event.context.user)";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function diagnose(options: {
  framework: "nuxt" | "vue";
  dependencies?: Record<string, string | undefined>;
  files: Record<string, string>;
}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-nuxthub-activation-"));
  roots.push(root);
  const files = {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { nuxt: "4.5.1", vue: "3.5.40", ...options.dependencies },
    }),
    ...options.files,
  };
  for (const [file, text] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return runDoctor({
    root,
    framework: options.framework,
    cache: false,
    runtimeTarget: {
      nuxt: "4.5.1",
      nitro: "2.13.4",
      h3: "1.15.11",
      vue: "3.5.40",
      nuxtCompatibility: 4,
    },
    extensions: [{ name: "fixture/nuxthub", rulePacks: [nuxtHubRulePack] }],
  });
}

for (const section of ["dependencies", "devDependencies"]) {
  test(`NuxtHub activates from @nuxthub/core in ${section}`, async () => {
    const result = await diagnose({
      framework: "nuxt",
      files: {
        "package.json": JSON.stringify({
          type: "module",
          dependencies: { nuxt: "4.5.1", vue: "3.5.40" },
          [section]: {
            ...(section === "dependencies" ? { nuxt: "4.5.1", vue: "3.5.40" } : {}),
            "@nuxthub/core": "0.10.8",
          },
        }),
        "server/api/profile.ts": source,
      },
    });
    expect(result.diagnostics.map((d) => d.ruleId)).toEqual([
      "nuxthub/no-personalized-cached-handler",
    ]);
  });
}

test("NuxtHub activates from resolved @nuxthub/core module evidence", async () => {
  const result = await diagnose({
    framework: "nuxt",
    files: {
      ".nuxt/doctor.manifest.json": JSON.stringify({
        modules: [{ name: "@nuxthub/core", version: "0.10.8" }],
      }),
      "server/api/profile.ts": source,
    },
  });
  expect(result.diagnostics.map((d) => d.ruleId)).toEqual([
    "nuxthub/no-personalized-cached-handler",
  ]);
});

test.each([{}, { "@nuxthub/core-example": "1.0.0" }, { nuxthub: "1.0.0" }])(
  "unrelated packages do not activate NuxtHub: %j",
  async (dependencies) => {
    const result = await diagnose({
      framework: "nuxt",
      dependencies,
      files: { "server/api/profile.ts": source },
    });
    expect(result.diagnostics).toEqual([]);
  },
);

test("NuxtHub still requires a Nuxt project", async () => {
  const result = await diagnose({
    framework: "vue",
    dependencies: { "@nuxthub/core": "0.10.8" },
    files: { "server/api/profile.ts": source },
  });
  expect(result.diagnostics).toEqual([]);
});
