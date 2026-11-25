import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
} from "../../src/core/index.ts";
import { expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { viteDoctorExtensions, viteDoctorRulePacks } from "../../src/doctor.ts";
import { formatMigrationReport } from "../../src/migration.ts";
import { doctor } from "../../src/plugin.ts";

const publicPackageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  version: string;
  dependencies?: Record<string, string>;
};
const publicPackageVersion = publicPackageJson.version;

test.each(["vite", "vue", "nitro", "nuxt"] as const)(
  "builtin catalog matches ordered runtime Rule Packs for %s",
  async (framework) => {
    const packs = await viteDoctorRulePacks({ framework });
    const extensions = await viteDoctorExtensions({ framework });

    expect(packs).toEqual(extensions.flatMap((extension) => extension.rulePacks ?? []));
    expect(new Set(packs.map((pack) => pack.name)).size).toBe(packs.length);
    expect(packs.every((pack) => pack.version === publicPackageVersion)).toBe(true);
  },
);

test.each(["auto", "explicit"])(
  "Nuxt catalog lists and explains an emitted Vue diagnostic with %s framework selection",
  async (selection) => {
    await withFixture(
      {
        "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0", vue: "^3.5.0" } }),
        "app/app.vue": "<template><button>Save</button></template>",
      },
      async (root) => {
        const frameworkOptions = selection === "explicit" ? ["--framework", "nuxt"] : [];
        const ruleId = "vue/template/html-button-has-type";
        const run = await runCli(
          [".", "--rules", ruleId, "--no-cache", "--format", "json", ...frameworkOptions],
          root,
        );
        expect(run.code).toBe(0);
        const report = JSON.parse(run.output);
        expect(report.framework).toBe("nuxt");
        expect(report.diagnostics).toEqual([
          expect.objectContaining({ code: "VUE0022", rule: ruleId }),
        ]);

        const catalog = await runCli(["rules", "--format", "json", ...frameworkOptions], root);
        expect(catalog.code).toBe(0);
        expect(
          JSON.parse(catalog.output).rules.filter((rule: { id: string }) => rule.id === ruleId),
        ).toEqual([
          expect.objectContaining({
            id: ruleId,
            version: publicPackageVersion,
            diagnosticCodes: ["VUE0022"],
          }),
        ]);

        for (const diagnostic of ["VUE0022", ruleId]) {
          const explanation = await runCli(
            ["explain", diagnostic, "--format", "json", ...frameworkOptions],
            root,
          );
          expect(explanation.code).toBe(0);
          expect(JSON.parse(explanation.output)).toMatchObject({
            id: ruleId,
            diagnosticCodes: ["VUE0022"],
          });
        }
      },
    );
  },
);

test("package installs the TypeScript runtime required by its parsers", () => {
  expect(publicPackageJson.dependencies?.["@typescript-eslint/parser"]).toBeTruthy();
  expect(publicPackageJson.dependencies?.typescript).toBeTruthy();
});

test("CLI rejects removed run command", async () => {
  const repoRoot = findRepoRoot();
  await expect(main(["run", "--dry-run", "--format", "text"], repoRoot)).resolves.toBe(2);
});

test("CLI rejects an unknown flag as an invocation error", async () => {
  const result = await runCli([".", "--not-a-doctor-flag", "--format", "agent"], findRepoRoot());

  expect(result.code).toBe(2);
  expect(JSON.parse(result.output)).toMatchObject({
    error: { kind: "invocation" },
    next: { action: "correct-invocation" },
  });
});

test("CLI prints the public package version", async () => {
  const repoRoot = findRepoRoot();
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await expect(main(["--version"], repoRoot)).resolves.toBe(0);
  } finally {
    process.stdout.write = write;
  }

  expect(writes.join("")).toBe(`${publicPackageVersion}\n`);
});

test("CLI help states that the analysis cache is on by default", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await expect(main(["--help"], findRepoRoot())).resolves.toBe(0);
    const help = info.mock.calls.flat().join("\n");
    expect(help).toMatch(/^ {2}--cache +Use the persistent analysis cache \(default: on\)\.\s*$/m);
    expect(help).toMatch(
      /^ {2}--no-cache +Disable the persistent analysis cache for this run\.\s*$/m,
    );
    expect(help).not.toContain("(default: true)");
  } finally {
    info.mockRestore();
  }
});

test("CLI lists Vite rule metadata with the public package version by default", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
    },
    async (root) => {
      const result = await runCli(["rules", "--format", "json"], root);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.output).rules).toContainEqual(
        expect.objectContaining({
          id: "vite/define/no-secret-define",
          version: publicPackageVersion,
        }),
      );
      expect(result.output).not.toContain("nuxt/hydration/no-client-conditional-in-template");
    },
  );
});

test("CLI returns Nuxt diagnostic exit codes without throwing", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
      "app/pages/index.vue": `<script setup lang="ts">const width = window.innerWidth</script>`,
    },
    async (root) => {
      const result = await runWithCapturedStdout(() =>
        main(
          [
            "--rules",
            "nuxt/hydration/no-browser-global-in-universal-code",
            "--format",
            "json",
            "--no-cache",
          ],
          root,
        ),
      );
      expect(result.code).toBe(1);
      const report = JSON.parse(result.output);
      expect(report.version).toBe(publicPackageVersion);
      expect(report.framework).toBe("nuxt");
      expect(report.summary.error).toBe(1);
    },
  );
});

test("CLI accepts a path shorthand for scans", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "src/main.ts": "console.log('ok')\n",
    },
    async (root) => {
      const writes: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await expect(main([".", "--format", "text"], root)).resolves.toBe(0);
      } finally {
        process.stdout.write = write;
      }
      expect(writes.join("")).toContain("Detected: Vite");
    },
  );
});

test("smart scan applies Vite rules and skips Nuxt-only rules in Vite projects", async () => {
  await withFixture(viteErrorFixture(), async (root) => {
    const viteOnly = await runCli([".", "--rules", "vite/define/no-secret-define"], root);
    expect(viteOnly.code).toBe(1);
    expect(viteOnly.output).toContain("Detected: Vite");
    expect(viteOnly.output).toContain("vite/define/no-secret-define");

    const nuxtOnly = await runCli([".", "--rules", "nuxt/**"], root);
    expect(nuxtOnly.code).toBe(0);
    expect(nuxtOnly.output).toContain("Detected: Vite");
    expect(nuxtOnly.output).not.toMatch(/^\s*rule:\s+nuxt\//m);
  });
});

test("smart scan activates Vue rules from Vue project signals", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
      "src/App.vue": `<template><div v-html="html" /></template>
<script setup lang="ts">
import { useRoute } from "vue-router";
const html = String(useRoute().query.html ?? "");
</script>
`,
    },
    async (root) => {
      const result = await runCli([".", "--rules", "vue/security/restrict-v-html"], root);
      expect(result.code).toBe(1);
      expect(result.output).toContain("Detected: Vue");
      expect(result.output).toContain("vue/security/restrict-v-html");
    },
  );
});

test("smart scan activates Nuxt and Nitro rules from Nuxt project signals", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
      "app/pages/index.vue": `<script setup lang="ts">
import { useRoute } from "vue-router";
useRoute();
</script>
`,
      "server/api/user.ts":
        "export default defineEventHandler((event) => rateLimit(getHeader(event, 'x-forwarded-for')))\n",
    },
    async (root) => {
      const nuxt = await runCli([".", "--rules", "nuxt/routing/prefer-nuxt-useroute"], root);
      expect(nuxt.code).toBe(1);
      expect(nuxt.output).toContain("Detected: Nuxt");
      expect(nuxt.output).toContain("nuxt/routing/prefer-nuxt-useroute");

      const nitro = await runCli(
        [".", "--rules", "h3/request/prefer-get-request-ip", "--max-warnings", "0"],
        root,
      );
      expect(nitro.code).toBe(1);
      expect(nitro.output).toContain("Detected: Nuxt");
      expect(nitro.output).toContain("h3/request/prefer-get-request-ip");
    },
  );
});

test("smart scan activates Nitro rules from Nitro project signals", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { nitropack: "^3.0.0" } }),
      "server/api/user.ts": "export default defineEventHandler(() => window.location.href)\n",
    },
    async (root) => {
      const result = await runCli([".", "--rules", "nitro/server/no-browser-api"], root);
      expect(result.code).toBe(1);
      expect(result.output).toContain("Detected: Nitro");
      expect(result.output).toContain("nitro/server/no-browser-api");
    },
  );
});

test("Nuxt framework scans store cache inside Nuxt build directory", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
      "app/pages/index.vue": `<script setup lang="ts">const width = window.innerWidth</script>`,
    },
    async (root) => {
      await runCli(
        [
          ".",
          "--framework",
          "nuxt",
          "--rules",
          "nuxt/hydration/no-browser-global-in-universal-code",
        ],
        root,
      );

      expect(existsSync(join(root, ".nuxt/doctor/cache"))).toBe(true);
      expect(existsSync(join(root, ".vite-doctor"))).toBe(false);
    },
  );
});

test("JSON reports use the public package version", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "src/main.ts": "console.log('ok')\n",
    },
    async (root) => {
      const result = await runCli([".", "--format", "json"], root);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output).version).toBe(publicPackageVersion);
    },
  );
});

test("framework override can enable Nuxt rules without Nuxt dependencies", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
      "app/pages/index.vue": `<script setup lang="ts">
import { useRoute } from "vue-router";
useRoute();
</script>
`,
    },
    async (root) => {
      const automatic = await runCli([".", "--rules", "nuxt/routing/prefer-nuxt-useroute"], root);
      expect(automatic.code).toBe(0);
      expect(automatic.output).toContain("Detected: Vue");

      const forced = await runCli(
        [".", "--framework", "nuxt", "--rules", "nuxt/routing/prefer-nuxt-useroute"],
        root,
      );
      expect(forced.code).toBe(3);
      expect(forced.output).toContain("Detected: Nuxt");
      expect(forced.output).toContain("nuxt/routing/prefer-nuxt-useroute");
    },
  );
});

test("framework override can enable Vue rules explicitly", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
      "src/App.vue": `<template><div v-html="html" /></template>
<script setup lang="ts">
import { useRoute } from "vue-router";
const html = String(useRoute().query.html ?? "");
</script>
`,
    },
    async (root) => {
      const result = await runCli(
        [".", "--framework", "vue", "--rules", "vue/security/restrict-v-html"],
        root,
      );
      expect(result.code).toBe(1);
      expect(result.output).toContain("Detected: Vue");
      expect(result.output).toContain("vue/security/restrict-v-html");
    },
  );
});

test("CLI rejects the removed trusted config flag", async () => {
  await withFixture(
    {
      ...viteErrorFixture(),
      "doctor.config.ts": maliciousConfigSource("cli-trusted-marker"),
    },
    async (root) => {
      const result = await main([".", "--trusted-config", "--format", "text"], root);
      expect(result).toBe(2);
      expect(existsSync(join(root, "cli-trusted-marker"))).toBe(false);
    },
  );
});

test("CLI automatically loads declarative Doctor config", async () => {
  await withFixture(
    {
      ...viteErrorFixture(),
      "doctor.config.json": JSON.stringify({
        rules: { "vite/define/no-secret-define": "off" },
      }),
    },
    async (root) => {
      const result = await runCli(
        [".", "--rules", "vite/define/no-secret-define", "--format", "json"],
        root,
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output).diagnostics).toEqual([]);
    },
  );
});

test("CLI explicitly loads executable Doctor config", async () => {
  await withFixture(
    {
      ...viteErrorFixture(),
      "doctor.config.ts": `import { writeFileSync } from "node:fs"
writeFileSync(new URL("./explicit-config-loaded", import.meta.url), "yes")
export default { rules: { "vite/define/no-secret-define": "off" } }
`,
    },
    async (root) => {
      const result = await runCli(
        [
          ".",
          "--rules",
          "vite/define/no-secret-define",
          "--config",
          "doctor.config.ts",
          "--format",
          "json",
        ],
        root,
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output).diagnostics).toEqual([]);
      expect(readFileSync(join(root, "explicit-config-loaded"), "utf8")).toBe("yes");
    },
  );
});

test("CLI identifies config loading failures and points to the config file", async () => {
  await withFixture(
    { "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }) },
    async (root) => {
      const missing = await runCli(
        [".", "--config", "missing.config.ts", "--format", "agent"],
        root,
      );
      expect(missing.code).toBe(2);
      expect(JSON.parse(missing.output)).toMatchObject({
        status: "failed",
        error: { kind: "config", file: join(root, "missing.config.ts") },
        next: { action: "fix-config", file: join(root, "missing.config.ts") },
      });
    },
  );

  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "doctor.config.json": "{not-json",
    },
    async (root) => {
      const malformed = await runCli([".", "--format", "agent"], root);
      expect(malformed.code).toBe(2);
      expect(JSON.parse(malformed.output)).toMatchObject({
        error: { kind: "config", file: join(root, "doctor.config.json") },
        next: { action: "fix-config", file: join(root, "doctor.config.json") },
      });
    },
  );

  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "doctor.config.json": JSON.stringify({
        rules: { "vite/define/no-secret-define": "fatal" },
      }),
    },
    async (root) => {
      const invalid = await runCli([".", "--format", "agent"], root);
      expect(invalid.code).toBe(2);
      expect(JSON.parse(invalid.output)).toMatchObject({
        error: { kind: "config", file: join(root, "doctor.config.json") },
        next: { action: "fix-config", file: join(root, "doctor.config.json") },
      });
    },
  );

  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "doctor.config.json": "{}",
    },
    async (root) => {
      const invalidFlag = await runCli([".", "--extends", "broken", "--format", "agent"], root);
      expect(invalidFlag.code).toBe(2);
      expect(JSON.parse(invalidFlag.output)).toMatchObject({
        error: { kind: "invocation" },
        next: { action: "correct-invocation" },
      });
    },
  );
});

test.each([
  [{ files: ["src/**"] }, "DOC0035"],
  [[{ files: ["src/**"], extends: [42] }], "DOC0035"],
  [[{ files: ["src/**"], rules: false }], "DOC0035"],
  [[{ files: ["src/**"], extends: ["typescript/recommened"] }], "DOC0018"],
])(
  "CLI attributes invalid overrides to the config even with a CLI extends flag: %j",
  async (overrides, code) => {
    await withFixture({ "doctor.config.json": JSON.stringify({ overrides }) }, async (root) => {
      const result = await runCli([".", "--extends", "auto", "--format", "agent"], root);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        error: { kind: "config", code, file: join(root, "doctor.config.json") },
        next: { action: "fix-config", file: join(root, "doctor.config.json") },
      });
    });
  },
);

test.each([
  [undefined, 0, "info"],
  ["error", 1, "error"],
  ["off", 0, undefined],
] as const)(
  "CLI exit code follows a configured DOC0037 severity of %s",
  async (severity, code, reported) => {
    await withFixture(
      {
        "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
        "src/main.ts":
          "// doctor-disable-next-line vite/env/no-such-rule -- Typo.\nconsole.log(1);\n",
        ...(severity && {
          "doctor.config.json": JSON.stringify({
            rules: { "doctor/inline/unknown-suppression-rule": severity },
          }),
        }),
      },
      async (root) => {
        const result = await runCli([".", "--no-cache", "--format", "json"], root);
        expect(result.code).toBe(code);
        const report = JSON.parse(result.output) as {
          diagnostics: Array<{ code: string; severity: string }>;
        };
        expect(
          report.diagnostics
            .filter((diagnostic) => diagnostic.code === "DOC0037")
            .map((diagnostic) => diagnostic.severity),
        ).toEqual(reported ? [reported] : []);
      },
    );
  },
);

test("CLI rejects config for a Doctor Rule ID that no Doctor Run reports", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "doctor.config.json": JSON.stringify({
        rules: { "doctor/inline/unused-suppresion": "error" },
      }),
    },
    async (root) => {
      const result = await runCli([".", "--format", "agent"], root);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        error: { kind: "config", code: "DOC0020", file: join(root, "doctor.config.json") },
      });
    },
  );
});

test("CLI identifies ambiguous Config Extends from a loaded config", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "doctor.config.ts": `export default {
  extends: ["vite/recommended"],
  extensions: [
    {
      name: "test/vendor-a",
      rulePacks: [{ name: "vendor-a/vite", version: "1.0.0", rules: [], presets: { recommended: ["test/a"] } }],
    },
    {
      name: "test/vendor-b",
      rulePacks: [{ name: "vendor-b/vite", version: "1.0.0", rules: [], presets: { recommended: ["test/b"] } }],
    },
  ],
}
`,
    },
    async (root) => {
      const result = await runCli([".", "--config", "doctor.config.ts", "--format", "agent"], root);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        error: { kind: "config" },
        next: { action: "fix-config", file: join(root, "doctor.config.ts") },
      });

      const invocation = await runCli(
        [".", "--config", "doctor.config.ts", "--extends", "vite/recommended", "--format", "agent"],
        root,
      );
      expect(invocation.code).toBe(2);
      expect(JSON.parse(invocation.output)).toMatchObject({
        error: { kind: "invocation" },
        next: { action: "correct-invocation" },
      });
    },
  );
});

test("CLI rejects invalid run options before starting a Doctor Run", async () => {
  const root = findRepoRoot();
  const cases: Array<[string[], string]> = [
    [["--framework", "banana"], "Unknown framework"],
    [["--severity", "banana"], "Unknown severity"],
    [["--max-warnings=-1"], "non-negative integer"],
    [["--max-warnings", "1.5"], "non-negative integer"],
    [["--analyses", "banana"], "Unknown analysis"],
    [["--analyses", ","], "at least one analysis"],
  ];

  for (const [options, message] of cases) {
    const result = await runCli([".", ...options, "--format", "agent"], root);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "failed",
      error: { kind: "invocation", message: expect.stringContaining(message) },
      next: { action: "correct-invocation" },
    });
  }
});

test.each([
  ["framework", "vue", "typo"],
  ["rules", "vue", "vite"],
  ["severity", "warn", "info"],
  ["extends", "vite-doctor/vue/recommended", "vite-doctor/vue/strict"],
  ["analyses", "graph", "health"],
  ["since", "main", "HEAD"],
  ["baseline", "first.json", "second.json"],
  ["config", "first.config.ts", "second.config.ts"],
  ["max-warnings", "0", "1"],
])("CLI rejects repeated --%s values before starting a Doctor Run", async (flag, first, second) => {
  await withFixture({ "package.json": "{}", "index.js": "export {}" }, async (root) => {
    const result = await runCli(
      [".", `--${flag}`, first, `--${flag}`, second, "--format", "agent"],
      root,
    );
    expect(result.code).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "failed",
      error: { kind: "invocation", message: `Option --${flag} may only be provided once.` },
      next: { action: "correct-invocation" },
    });
  });
});

test("CLI rejects repeated report formats without silently switching presentation", async () => {
  const result = await runWithCapturedStdout(() =>
    main(["rules", "--format=json", "--format=json"], findRepoRoot()),
  );
  expect(result.code).toBe(2);
  expect(JSON.parse(result.output)).toMatchObject({
    schema: "vite-doctor.report/v4",
    status: "failed",
    error: { kind: "invocation", message: "Option --format may only be provided once." },
  });
});

test("CLI rejects repeated migration targets", async () => {
  const result = await runCli(
    ["migrate", ".", "--to", "nuxt@5", "--to", "nitro@3", "--format", "agent"],
    findRepoRoot(),
  );
  expect(result.code).toBe(2);
  expect(JSON.parse(result.output)).toMatchObject({
    error: { kind: "invocation", message: "Option --to may only be provided once." },
  });
});

test("CLI and Vite plugin report the Rule Packs an explicit extends left out", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ devDependencies: { vite: "^7.0.0", typescript: "^5.9.0" } }),
      "tsconfig.json": "{}",
      "src/main.ts": "export {}",
    },
    async (root) => {
      const cli = await runCli(
        [".", "--extends", "vite-doctor/typescript/strict", "--no-cache", "--format", "json"],
        root,
      );
      const logs = await runVitePlugin(
        doctor({ extends: ["vite-doctor/typescript/strict"], format: "json", cache: false }),
        root,
        "build",
      );
      expect(JSON.parse(cli.output).rulePacks).toEqual([
        { name: "vite-doctor/vite", selected: false, activatedBy: ["."] },
        { name: "vite-doctor/typescript", selected: true, activatedBy: ["."] },
      ]);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!).rulePacks).toEqual(JSON.parse(cli.output).rulePacks);
      const text = await runCli(
        [".", "--extends", "vite-doctor/typescript/strict", "--no-cache"],
        root,
      );
      expect(text.output).toContain(
        'Rule Packs not selected by extends: vite-doctor/vite (add "auto" to extends to select their recommended presets)',
      );
    },
  );
});

const strictFixture = {
  "package.json": JSON.stringify({ devDependencies: { vite: "^7.0.0", typescript: "^5.9.0" } }),
  "tsconfig.json": "{}",
  "src/main.ts":
    "export const values = [1, 2, 3].filter((value) => value > 1).map((value) => value * 2)\n",
};

async function jsonRun(root: string, ...args: string[]) {
  const result = await runCli(
    [".", ...args, "--profile", "--severity", "info", "--no-cache", "--format", "json"],
    root,
  );
  const report = JSON.parse(result.output) as {
    extends?: unknown;
    diagnostics: Array<{ rule: string }>;
    ruleTimings: Array<{ rule: string }>;
    rulePacks: Array<{ name: string; selected: boolean }>;
  };
  return {
    ...report,
    ruleIds: new Set(report.diagnostics.map((item) => item.rule)),
    ran: new Set(report.ruleTimings.map((item) => item.rule)),
  };
}

test("--strict runs strictly more Rules than the default Doctor Run", async () => {
  await withFixture(strictFixture, async (root) => {
    const recommended = await jsonRun(root);
    const strict = await jsonRun(root, "--strict");

    expect(strict.extends).toBe("strict");
    expect(strict.ran.size).toBeGreaterThan(recommended.ran.size);
    expect([...recommended.ran].filter((rule) => !strict.ran.has(rule))).toEqual([]);
    expect(strict.ran).toContain("typescript/performance/no-array-filter-map");
    expect(recommended.ran).not.toContain("typescript/performance/no-array-filter-map");
    expect(strict.ruleIds).toContain("typescript/performance/no-array-filter-map");
    expect(recommended.ruleIds).not.toContain("typescript/performance/no-array-filter-map");
    expect(strict.rulePacks).toEqual(recommended.rulePacks);
    expect(strict.rulePacks.every((pack) => pack.selected)).toBe(true);

    expect((await jsonRun(root, "--extends", "strict")).ran).toEqual(strict.ran);
    expect((await jsonRun(root, "--strict", "--strict")).ran).toEqual(strict.ran);
  });
});

test("--strict alongside --extends adds strict to the list", async () => {
  await withFixture(strictFixture, async (root) => {
    expect((await jsonRun(root, "--strict", "--extends", "vite/recommended")).extends).toEqual([
      "vite/recommended",
      "strict",
    ]);
  });
});

test("--strict preserves the Recommended Rules selected by explicit auto", async () => {
  await withFixture(
    {
      ...strictFixture,
      "doctor.config.ts": `
const rule = (mode) => ({
  meta: { id: 'fixture/' + mode, title: mode, category: 'fixture', severity: 'warn' },
  create() {},
});
export default { extensions: [{ name: 'fixture', rulePacks: [{
  name: 'fixture', version: '0.0.0', activation: { frameworks: ['vite'] },
  rules: [rule('recommended'), rule('strict')],
  presets: { recommended: ['fixture/recommended'], strict: ['fixture/strict'] },
}] }] };
`,
    },
    async (root) => {
      const config = ["--config", "doctor.config.ts"];
      const strict = await jsonRun(root, ...config, "--strict");
      expect(strict.ran).toContain("fixture/strict");
      expect(strict.ran).not.toContain("fixture/recommended");
      const composed = await jsonRun(root, ...config, "--extends", "auto", "--strict");
      expect(composed.ran).toContain("fixture/recommended");
      expect(composed.ran).toContain("fixture/strict");
      expect(composed.ran).toEqual(
        (await jsonRun(root, ...config, "--extends", "auto,strict")).ran,
      );
    },
  );
});

test("--strict does not mark a suppression from an omitted configured Preset stale", async () => {
  const extendsSelection = ["auto", "package/recommended"];
  await withFixture(
    { "package.json": JSON.stringify({ peerDependencies: { vue: "3.5.44" } }) },
    async (root) => {
      async function report(...args: string[]) {
        return JSON.parse(
          (
            await runCli(
              [".", ...args, "--severity", "info", "--no-cache", "--format", "json"],
              root,
            )
          ).output,
        );
      }
      const first = await report("--extends", extendsSelection.join(","));
      const finding = first.diagnostics.find((item: { code: string }) => item.code === "PKG0005");
      expect(finding?.fingerprint).toBeTruthy();
      writeFileSync(
        join(root, "doctor.config.json"),
        JSON.stringify({
          extends: extendsSelection,
          suppressions: [{ fingerprint: finding.fingerprint, reason: "Pinned intentionally." }],
        }),
      );
      const configured = await report();
      expect(configured.suppressedDiagnostics).toContainEqual(
        expect.objectContaining({ code: "PKG0005" }),
      );
      const strict = await report("--strict");
      expect(strict.suppressedDiagnostics).toEqual([]);
      expect(strict.diagnostics).not.toContainEqual(expect.objectContaining({ code: "DOC0031" }));
    },
  );
});

test("doctor.config.json and the Vite plugin accept extends strict", async () => {
  await withFixture(
    { ...strictFixture, "doctor.config.json": JSON.stringify({ extends: "strict" }) },
    async (root) => {
      const configured = await jsonRun(root);
      expect(configured.extends).toBe("strict");
      expect(configured.ruleIds).toContain("typescript/performance/no-array-filter-map");
    },
  );
  await withFixture(strictFixture, async (root) => {
    const cli = await jsonRun(root, "--strict");
    for (const plugin of [
      doctor({ config: { extends: "strict" }, severity: "info", format: "json", cache: false }),
      doctor({ extends: "strict", severity: "info", format: "json", cache: false }),
    ]) {
      const logs = await runVitePlugin(plugin, root, "build");
      expect(logs).toHaveLength(1);
      const report = JSON.parse(logs[0]!) as { diagnostics: Array<{ rule: string }> };
      expect(new Set(report.diagnostics.map((item) => item.rule))).toEqual(cli.ruleIds);
    }
  });
});

test("agent reports rerun strict Doctor Runs with --strict", async () => {
  await withFixture(strictFixture, async (root) => {
    const result = await runCli([".", "--strict", "--no-cache", "--format", "agent"], root);
    const rerun = JSON.parse(result.output).commandArgs.rerun as string[];
    expect(rerun).toContain("--strict");
    expect(rerun).not.toContain("--extends");
  });
});

test("agent commands retain an explicit auto override of configured strict mode", async () => {
  await withFixture(
    { ...strictFixture, "doctor.config.json": JSON.stringify({ extends: "strict" }) },
    async (root) => {
      const result = await runCli(
        [".", "--extends", "auto", "--severity", "info", "--no-cache", "--format", "agent"],
        root,
      );
      const { rerun, verify } = JSON.parse(result.output).commandArgs as Record<
        "rerun" | "verify",
        string[]
      >;
      for (const args of [rerun, verify]) {
        expect(args.slice(args.indexOf("--extends"), args.indexOf("--extends") + 2)).toEqual([
          "--extends",
          "auto",
        ]);
      }
      const replay = JSON.parse((await runCli(rerun.slice(1), root)).output);
      expect(replay.diagnostics).not.toContainEqual(
        expect.objectContaining({ rule: "typescript/performance/no-array-filter-map" }),
      );
    },
  );
});

test("CLI keeps comma-separated selectors and repeated boolean flags", async () => {
  await withFixture({ "package.json": "{}", "index.js": "export {}" }, async (root) => {
    const result = await runCli(
      [
        ".",
        "--rules",
        "vite,vue",
        "--analyses",
        "graph,health",
        "--no-cache",
        "--no-cache",
        "--format",
        "json",
      ],
      root,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).status).not.toBe("failed");
  });
});

test("CLI returns structured failures for unknown Diagnostic Codes", async () => {
  const result = await runWithCapturedStdout(() =>
    main(["explain", "DOES_NOT_EXIST", "--format", "agent"], findRepoRoot()),
  );
  expect(result.code).toBe(2);
  expect(JSON.parse(result.output)).toMatchObject({
    schema: "vite-doctor.agent/v2",
    status: "failed",
    next: { action: "correct-invocation" },
  });
});

test("CLI explains workspace Diagnostic Codes by code and rule ID", async () => {
  await withFixture({ "package.json": "{}", "index.ts": "export {}" }, async (root) => {
    for (const diagnostic of ["DOC0001", "workspace/health/high-fan-out"]) {
      const result = await runCli(["explain", diagnostic, "--format", "agent"], root);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({
        schema: "vite-doctor.explain/v1",
        status: "ready",
      });
    }
  });
});

test.each(["DOC0039", "doctor/baseline/resolved-entries"])(
  "CLI explains resolved baseline entries by %s",
  async (diagnostic) => {
    const result = await runCli(["explain", diagnostic, "--format", "agent"], findRepoRoot());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      schema: "vite-doctor.explain/v1",
      status: "ready",
      id: "doctor/baseline/resolved-entries",
      severity: "info",
      recommendedReplacement: expect.stringContaining("Delete only the fingerprints"),
      docsUrl: expect.stringMatching(/\/diagnostics\/DOC0039$/),
    });
  },
);

test("CLI rejects the removed scan alias", async () => {
  const repoRoot = findRepoRoot();
  const result = await runWithCapturedStdout(() =>
    main(["scan", "__missing_vite_doctor_path__", "--format=json"], repoRoot),
  );
  expect(result.code).toBe(2);
  expect(JSON.parse(result.output).error.message).toContain("vite-doctor scan was removed");
});

test("exports a Vite plugin factory", () => {
  const plugin = doctor();
  expect(plugin.name).toBe("vite-doctor");
});

test("Vite plugin defaults to build-only checks", async () => {
  await withFixture(viteErrorFixture(), async (root) => {
    const plugin = doctor({ rules: "vite/define/no-secret-define" });
    const logs = await runVitePlugin(plugin, root, "serve");
    expect(logs).toEqual([]);
  });
});

test("Vite plugin fails builds in error mode", async () => {
  await withFixture(viteErrorFixture(), async (root) => {
    const plugin = doctor({ rules: "vite/define/no-secret-define" });
    await expect(runVitePlugin(plugin, root, "build")).rejects.toThrow(
      /vite\/define\/no-secret-define/,
    );
  });
});

test("Vite plugin reports but does not fail in warn mode", async () => {
  await withFixture(viteErrorFixture(), async (root) => {
    const plugin = doctor({ mode: "warn", rules: "vite/define/no-secret-define" });
    const logs = await runVitePlugin(plugin, root, "build");
    expect(logs.join("\n")).toContain("vite/define/no-secret-define");
  });
});

test("Vite plugin keeps info-only reports at info log level", async () => {
  const infoRule = createRule({
    meta: {
      id: "fixture/info-only",
      title: "Info-only fixture",
      category: "style",
      severity: "info",
      execution: "workspace",
    },
    create(ctx) {
      return {
        onProjectStart(project) {
          ctx.report(
            allDiagnostics.DOC9999({
              why: "The fixture emits an informational diagnostic.",
              fix: "Review the informational diagnostic.",
            }),
            {
              ruleId: "fixture/info-only",
              severity: "info",
              category: "style",
              file: project.root,
            },
          );
        },
      };
    },
  });

  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
    },
    async (root) => {
      const plugin = doctor({
        extensions: [
          defineDoctorExtension({
            name: "fixture/info-only",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [infoRule],
                presets: { recommended: ["fixture/info-only"] },
              }),
            ],
          }),
        ],
      });
      const levels = { info: [] as string[], warn: [] as string[] };
      const logs = await runVitePlugin(plugin, root, "build", levels);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("fixture/info-only");
      expect(levels.info).toEqual(logs);
      expect(levels.warn).toEqual([]);
    },
  );
});

test("Vite plugin contributes resolved config inventory to Doctor Run", async () => {
  const surfaceInventoryRule = createRule({
    meta: {
      id: "fixture/vite-surface-inventory",
      title: "Vite surface inventory",
      category: "inventory",
      severity: "warn",
      execution: "workspace",
    },
    create(ctx) {
      return {
        onProjectStart(project) {
          const vite = project.inventory?.vite as { command?: string };
          if (vite?.command !== "build") return;
          ctx.report(
            allDiagnostics.DOC9999({
              why: "Vite surface inventory is available.",
              fix: "Inspect the Vite surface inventory.",
            }),
            {
              ruleId: "fixture/vite-surface-inventory",
              severity: "warn",
              category: "inventory",
              file: ctx.file.path,
            },
          );
        },
      };
    },
  });

  await withFixture(viteWarningFixture(), async (root) => {
    const plugin = doctor({
      mode: "warn",
      extensions: [
        defineDoctorExtension({
          name: "fixture",
          rulePacks: [
            defineRulePack({
              name: "fixture",
              version: "0.0.0",
              rules: [surfaceInventoryRule],
              presets: { recommended: ["fixture/vite-surface-inventory"] },
            }),
          ],
        }),
      ],
    });
    const logs = await runVitePlugin(plugin, root, "build");
    expect(logs.join("\n")).toContain("fixture/vite-surface-inventory");
  });
});

test("Vite plugin fails when maxWarnings is zero", async () => {
  await withFixture(viteWarningFixture(), async (root) => {
    const plugin = doctor({
      rules: "vite/env/no-broad-env-prefix",
      maxWarnings: 0,
    });
    await expect(runVitePlugin(plugin, root, "build")).rejects.toThrow(
      /vite\/env\/no-broad-env-prefix/,
    );
  });
});

test("Vite plugin keeps executable config disabled by default", async () => {
  await withFixture(
    {
      ...viteErrorFixture(),
      "doctor.config.ts":
        "import { defineDoctorConfig } from 'vite-doctor/config'\nexport default defineDoctorConfig({ rules: { 'vite/define/no-secret-define': 'off' } })\n",
    },
    async (root) => {
      const plugin = doctor({ rules: "vite/define/no-secret-define" });
      await expect(runVitePlugin(plugin, root, "build")).rejects.toThrow(
        /vite\/define\/no-secret-define/,
      );
    },
  );
});

test("Vite plugin accepts full Doctor config options", async () => {
  await withFixture(viteErrorFixture(), async (root) => {
    const plugin = doctor({
      rules: "vite/define/no-secret-define",
      config: {
        rules: { "vite/define/no-secret-define": "off" },
      },
    });
    const logs = await runVitePlugin(plugin, root, "build");
    expect(logs.join("\n")).not.toContain("vite/define/no-secret-define");
  });
});

test("Vite plugin runs Nitro rules in Nitro-backed Vite apps", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({
        dependencies: { vite: "^7.0.0", nitropack: "^3.0.0", react: "^19.0.0" },
      }),
      "server/api/user.ts": "export default defineEventHandler(() => window.location.href)\n",
    },
    async (root) => {
      const plugin = doctor({ mode: "warn", rules: "nitro/server/no-browser-api" });
      const logs = await runVitePlugin(plugin, root, "build");
      expect(logs.join("\n")).toContain("Detected: Nitro");
      expect(logs.join("\n")).toContain("nitro/server/no-browser-api");
    },
  );
});

test("installed Nitro 2 and H3 v1 activate only their generation of runtime config advice", async () => {
  await withFixture(
    {
      ...nuxtRuntimeFixture({ nuxt: "4.2.0", nitro: "2.12.0", h3: "1.15.4" }),
      "server/api/config.ts":
        'import { defineConfig } from "nitropack"\nimport { useBase } from "h3"\nexport default defineEventHandler(() => useRuntimeConfig())\n',
    },
    async (root) => {
      const result = await runCli(
        [
          ".",
          "--rules",
          "nitro/runtime/require-event-runtime-config-in-server,nitro/runtime/no-event-runtime-config-in-server,nitro/migration/no-v2-imports,h3/migration/prefer-with-base",
          "--format",
          "json",
          "--no-cache",
        ],
        root,
      );
      const codes = JSON.parse(result.output).diagnostics.map(
        (item: { code: string }) => item.code,
      );

      expect(codes).toContain("NITRO0008");
      expect(codes).not.toContain("NITRO0013");
      expect(codes).not.toContain("NITRO0014");
      expect(codes).not.toContain("H30003");
    },
  );
});

test("Nuxt compatibility 5 stays independent from the installed Nitro and H3 generations", async () => {
  await withFixture(
    {
      ...nuxtRuntimeFixture({ nuxt: "4.2.0", nitro: "2.12.0", h3: "1.15.4" }),
      "nuxt.config.ts":
        "export default defineNuxtConfig({ future: { compatibilityVersion: 5 } })\n",
      "app/app.ts": "if (process.server) console.log('server')\n",
      "server/api/config.ts": 'import { defineConfig } from "nitropack"\n',
    },
    async (root) => {
      const result = await runCli(
        [
          ".",
          "--rules",
          "nuxt/context/no-legacy-process-client-server,nitro/migration/no-v2-imports",
          "--format",
          "json",
          "--no-cache",
        ],
        root,
      );
      const codes = JSON.parse(result.output).diagnostics.map(
        (item: { code: string }) => item.code,
      );

      expect(codes).toContain("NUXT0021");
      expect(codes).not.toContain("NITRO0014");
    },
  );
});

test("Nuxt 5 prereleases activate Nitro 3 and H3 v2 migration diagnostics", async () => {
  await withFixture(
    {
      ...nuxtRuntimeFixture({
        nuxt: "5.0.0-beta.2",
        nitroName: "nitro",
        nitro: "3.0.0-beta.4",
        h3: "2.0.0-rc.26",
      }),
      "server/api/config.ts": `import type { NitroConfig } from "nitropack"
import { send, sendRedirect, useBase } from "h3"
export default defineHandler((event) => {
  useRuntimeConfig(event)
  send(event, "ok")
  return sendRedirect(event, "/next")
})
`,
    },
    async (root) => {
      const result = await runCli(
        [
          ".",
          "--rules",
          "nitro/runtime/require-event-runtime-config-in-server,nitro/runtime/no-event-runtime-config-in-server,nitro/migration/no-v2-imports,h3/migration/no-removed-send,h3/migration/prefer-redirect-response,h3/migration/prefer-with-base",
          "--format",
          "json",
          "--no-cache",
        ],
        root,
      );
      const codes = JSON.parse(result.output).diagnostics.map(
        (item: { code: string }) => item.code,
      );

      expect(codes).toEqual(
        expect.arrayContaining(["NITRO0013", "NITRO0014", "H30001", "H30002", "H30003"]),
      );
      expect(
        JSON.parse(result.output).diagnostics.find(
          (item: { code: string }) => item.code === "NITRO0014",
        ).remediation,
      ).toBe('Import types from "nitro/types".');
      expect(codes).not.toContain("NITRO0008");
    },
  );
});

test("unresolved runtime identity suppresses version-specific advice and reports inventory once", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { nuxt: "npm:custom-nuxt@5.0.0" } }),
      "node_modules/nuxt/package.json": JSON.stringify({
        name: "custom-nuxt",
        version: "5.0.0",
        dependencies: { nitro: "3.0.0" },
      }),
      "server/api/config.ts":
        'import { defineConfig } from "nitropack"\nexport default defineEventHandler((event) => useRuntimeConfig(event))\n',
    },
    async (root) => {
      const result = await runCli(
        [
          ".",
          "--framework",
          "nuxt",
          "--rules",
          "nitro/runtime/no-event-runtime-config-in-server,nitro/migration/no-v2-imports",
          "--format",
          "json",
          "--no-cache",
        ],
        root,
      );
      const codes = JSON.parse(result.output).diagnostics.map(
        (item: { code: string }) => item.code,
      );

      expect(result.code).toBe(3);
      expect(JSON.parse(result.output).status).toBe("incomplete");
      expect(codes.filter((code: string) => code === "DOC0022")).toHaveLength(1);
      expect(codes).not.toContain("NITRO0013");
      expect(codes).not.toContain("NITRO0014");
    },
  );
});

test("migrate infers Nuxt 5 and emits stable staged JSON without rewriting files", async () => {
  const source = `import { defineConfig } from "nitropack"
import { send, useBase } from "h3"
export default defineEventHandler((event) => {
  useRuntimeConfig(event)
  return send(event, "ok")
})
`;
  await withFixture(
    {
      ...nuxtRuntimeFixture({ nuxt: "4.2.0", nitro: "2.12.0", h3: "1.15.4" }),
      "nuxt.config.ts": `export default defineNuxtConfig({
  unhead: { legacy: true },
  experimental: { parseErrorData: false },
})
`,
      "app/app.ts": "if (process.client) console.log('client')\n",
      "server/api/config.ts": source,
    },
    async (root) => {
      const result = await runCli(["migrate", ".", "--format", "json"], root);
      const report = JSON.parse(result.output);

      expect(result.code).toBe(1);
      expect(report.reportVersion).toBe(1);
      expect(report.command).toBe("migrate");
      expect(report.target).toMatchObject({
        source: "inferred",
        requested: ["nuxt@5"],
        runtime: {
          nuxt: "5.0.0-0",
          nitro: "3.0.0-0",
          h3: "2.0.0-0",
          nuxtCompatibility: 5,
        },
      });
      expect(report.stages.map((stage: { id: string }) => stage.id)).toEqual([
        "source",
        "dependencies",
        "deferred",
      ]);
      expect(report.stages[0].diagnostics).toEqual([]);
      expect(report.stages[1].diagnostics.map((item: { code: string }) => item.code)).toEqual(
        expect.arrayContaining([
          "NITRO0013",
          "NITRO0014",
          "H30001",
          "H30003",
          "NUXT0021",
          "NUXT0073",
        ]),
      );
      expect(report.stages[1].changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: "nuxt@5" }),
          expect.objectContaining({ to: "future.compatibilityVersion: 5" }),
        ]),
      );
      const agentResult = await runCli(["migrate", ".", "--format", "agent"], root);
      expect(JSON.parse(agentResult.output)).toMatchObject({
        schema: "vite-doctor.migration/v1",
        status: "findings",
      });
      const textResult = await runCli(["migrate", "."], root);
      expect(textResult.output).toContain(
        `Summary: ${report.summary.diagnostics} diagnostics, ${report.summary.dependencyChanges} dependency/config changes`,
      );
      expect(textResult.output).not.toContain("source diagnostics");
      expect(readFileSync(join(root, "server/api/config.ts"), "utf8")).toBe(source);
    },
  );
});

test("migrate asks users to verify composed compatibility config instead of adding it again", async () => {
  await withFixture(
    {
      ...nuxtRuntimeFixture({ nuxt: "4.2.0", nitro: "2.12.0", h3: "1.15.4" }),
      "nuxt.config.ts": `const overrides = {}
export default defineNuxtConfig({
  future: { compatibilityVersion: 5 },
  ...overrides,
})
`,
    },
    async (root) => {
      const result = await runCli(["migrate", ".", "--format", "json"], root);
      const report = JSON.parse(result.output);
      const configChange = report.stages[1].changes.find(
        (change: { kind: string }) => change.kind === "config",
      );

      expect(configChange).toMatchObject({
        to: "future.compatibilityVersion: 5",
        instruction:
          "Verify that the effective future.compatibilityVersion resolves to 5; Doctor could not prove it from the composed Nuxt config.",
      });
      expect(report.summary.errors).toBe(0);
      expect(JSON.parse(formatMigrationReport(report, "agent")).status).toBe("findings");
    },
  );
});

test("migrate accepts an explicit standalone Nitro target", async () => {
  await withFixture(
    {
      ...nitroRuntimeFixture({ nitro: "2.12.0", h3: "1.15.4" }),
      "server/api/config.ts": 'import { defineNitroConfig } from "nitropack/config"\n',
    },
    async (root) => {
      const result = await runCli(["migrate", ".", "--to", "nitro@3", "--format", "json"], root);
      const report = JSON.parse(result.output);

      expect(report.framework).toBe("nitro");
      expect(report.target.source).toBe("explicit");
      expect(report.target.requested).toEqual(["nitro@3"]);
      expect(report.stages[1].diagnostics.map((item: { code: string }) => item.code)).toContain(
        "NITRO0014",
      );
      expect(
        report.stages[1].diagnostics.find((item: { code: string }) => item.code === "NITRO0014")
          .fix,
      ).toContain("Replace defineNitroConfig with defineConfig");
    },
  );
});

test("migrate rejects Nuxt targets outside Nuxt projects", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.18" } }),
      "src/App.vue": "<template><div /></template>\n",
    },
    async (root) => {
      const result = await runCli(["migrate", ".", "--to", "nuxt@5", "--format", "json"], root);

      expect(result.code).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        schema: "vite-doctor.report/v4",
        status: "failed",
      });
    },
  );
});

test("migrate rejects Nitro targets outside Nuxt and Nitro projects", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "7.0.0" } }),
    },
    async (root) => {
      const result = await runCli(["migrate", ".", "--to", "nitro@3", "--format", "json"], root);

      expect(result.code).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        schema: "vite-doctor.report/v4",
        status: "failed",
      });
    },
  );
});

const h3RedirectHandler = `import { send, sendRedirect } from "h3"
export default defineEventHandler((event) => {
  if (event.path === "/old") return sendRedirect(event, "/new")
  return send(event, "ok")
})
`;

test.each([
  ["nitro@3", nitroRuntimeFixture({ nitro: "2.12.0", h3: "1.15.4" })],
  ["nuxt@5", nuxtRuntimeFixture({ nuxt: "4.2.0", nitro: "2.12.0", h3: "1.15.4" })],
] as const)(
  "migrate --to %s keeps the H3 Rule Pack's v2 migration rules",
  async (target, files) => {
    await withFixture({ ...files, "server/api/redirect.ts": h3RedirectHandler }, async (root) => {
      const result = await runCli(["migrate", ".", "--to", target, "--format", "json"], root);
      const report = JSON.parse(result.output);

      expect(report.applicability.activated).toEqual(
        expect.arrayContaining([
          "h3/migration/no-removed-send",
          "h3/migration/prefer-redirect-response",
        ]),
      );
      expect(report.applicability.retained).toContain("h3/errors/no-http-error-masking");
      expect(
        report.stages[1].diagnostics
          .filter((item: { file: string }) => item.file === "server/api/redirect.ts")
          .map((item: { ruleId: string }) => item.ruleId),
      ).toEqual(
        expect.arrayContaining([
          "h3/migration/no-removed-send",
          "h3/migration/prefer-redirect-response",
        ]),
      );
    });
  },
);

const h3ServerFiles = (h3: string) => ({
  "package.json": JSON.stringify({ dependencies: { h3: `^${h3}` } }),
  "node_modules/h3/package.json": JSON.stringify({ name: "h3", version: h3 }),
  "src/server.ts": `import { createServer } from "node:http"
import { createApp, sendRedirect, toNodeListener } from "h3"
const app = createApp()
app.use("/old", defineEventHandler((event) => sendRedirect(event, "/new")))
createServer(toNodeListener(app)).listen(3000)
`,
});

test.each([
  ["explicit", ["--to", "h3@2"]],
  ["inferred", []],
] as const)("migrate targets h3@2 for a plain h3 1.x server (%s)", async (source, to) => {
  await withFixture(h3ServerFiles("1.15.4"), async (root) => {
    const result = await runCli(["migrate", ".", ...to, "--format", "json"], root);
    const report = JSON.parse(result.output);

    expect(report.framework).toBe("vite");
    expect(report.target).toEqual({ source, requested: ["h3@2"], runtime: { h3: "2.0.0-0" } });
    expect(report.applicability.activated).toEqual(
      expect.arrayContaining([
        "h3/migration/no-removed-send",
        "h3/migration/prefer-redirect-response",
      ]),
    );
    expect(
      report.stages[1].diagnostics
        .filter((item: { file: string }) => item.file === "src/server.ts")
        .map((item: { code: string }) => item.code),
    ).toContain("H30002");
    expect(report.stages[1].changes).toEqual([
      {
        kind: "dependency",
        package: "h3",
        file: "package.json",
        from: "1.15.4",
        to: "h3@2",
        instruction: "Update h3 from 1.15.4 to h3@2 in package.json.",
      },
    ]);
    expect(report.stages[2].checks.map((check: { id: string }) => check.id)).toContain(
      "serve-h3-app",
    );
  });
});

test("migrate --to h3@2 proposes the h3 bump in each workspace package that declares h3 1.x", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/api/package.json": JSON.stringify({
        name: "api",
        dependencies: { h3: "^1.15.4" },
      }),
      "packages/api/node_modules/h3/package.json": JSON.stringify({
        name: "h3",
        version: "1.15.4",
      }),
      "packages/edge/package.json": JSON.stringify({
        name: "edge",
        dependencies: { h3: "^2.0.1-rc.26" },
      }),
      "packages/edge/node_modules/h3/package.json": JSON.stringify({
        name: "h3",
        version: "2.0.1-rc.26",
      }),
    },
    async (root) => {
      const result = await runCli(["migrate", ".", "--to", "h3@2", "--format", "json"], root);
      const report = JSON.parse(result.output);

      expect(report.stages[1].changes).toEqual([
        expect.objectContaining({
          package: "h3",
          file: "packages/api/package.json",
          from: "1.15.4",
          to: "h3@2",
        }),
      ]);
    },
  );
});

test.each([
  [
    "Nitro provides h3",
    nitroRuntimeFixture({ nitro: "2.12.0", h3: "1.15.4" }),
    "Nitro provides h3",
  ],
  ["h3 is already v2", h3ServerFiles("2.0.1-rc.26"), "h3 is already 2.0.1-rc.26"],
  [
    "no package declares h3",
    { "package.json": JSON.stringify({ dependencies: { vite: "7.0.0" } }) },
    "do not declare h3",
  ],
] as const)("migrate rejects h3@2 when %s", async (_case, files, message) => {
  await withFixture(files, async (root) => {
    const result = await runCli(["migrate", ".", "--to", "h3@2", "--format", "json"], root);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      schema: "vite-doctor.report/v4",
      status: "failed",
      error: { message: expect.stringContaining(message) },
    });
  });
});

test("CLI can record and refresh a baseline while retaining new-only findings", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^8.0.0" } }),
      "src/known.ts": "export const secret = import.meta.env.VITE_SECRET_TOKEN",
    },
    async (root) => {
      const baseline = "reports/known findings.json";
      const args = [".", "--baseline", baseline, "--format", "json", "--no-cache"];
      const record = await runCli([...args, "--update-baseline"], root);
      expect(record.code).toBe(1);
      const first = JSON.parse(record.output);
      expect(first.diagnostics.map((item: { code: string }) => item.code)).toEqual(["VITE0009"]);
      const readBaseline = () => JSON.parse(readFileSync(join(root, baseline), "utf8"));
      expect(readBaseline()).toMatchObject({
        version: 2,
        diagnostics: [{ fingerprint: first.diagnostics[0].fingerprint, file: "src/known.ts" }],
      });

      const known = await runCli([...args, "--new-only"], root);
      expect(known.code).toBe(0);
      expect(JSON.parse(known.output).diagnostics).toEqual([]);

      writeFileSync(
        join(root, "src/new.ts"),
        "export const token = import.meta.env.VITE_API_SECRET",
      );
      const added = await runCli([...args, "--new-only", "--update-baseline"], root);
      expect(added.code).toBe(1);
      expect(JSON.parse(added.output).diagnostics).toHaveLength(1);
      expect(JSON.parse(added.output).suppressedDiagnostics).toHaveLength(1);
      expect(readBaseline().diagnostics).toHaveLength(2);

      writeFileSync(join(root, "src/known.ts"), "export const publicValue = 1");
      const refreshed = await runCli([...args, "--update-baseline"], root);
      expect(refreshed.code).toBe(1);
      expect(readBaseline().diagnostics.map((item: { file: string }) => item.file)).toEqual([
        "src/new.ts",
      ]);
      expect((await runCli([...args, "--new-only"], root)).code).toBe(0);
    },
  );
});

test("CLI reports resolved baseline findings when syntax is removed, not when it is unreadable", async () => {
  const template = "<template><div /></template>";
  const script = "const { MODE } = import.meta.env";
  const component = `<script setup lang="ts">${script}</script>${template}`;
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^8.0.0", vue: "^3.5.0" } }),
      "src/Empty.ts": script,
      "src/TemplateOnly.vue": component,
      "src/Broken.vue": component,
      "src/External.vue": component,
      "src/ScriptOnly.vue": "<template><button>Save</button></template>",
      "src/Pug.vue": "<template><button>Save</button></template>",
    },
    async (root) => {
      const rule = "vite/env/prefer-direct-import-meta-env-access";
      const baseline = "baseline.json";
      const args = [".", "--baseline", baseline, "--format", "json", "--strict"];
      const recorded = await runCli([...args, "--update-baseline"], root);
      const report = JSON.parse(recorded.output);
      expect(
        report.diagnostics.filter((item: { rule: string }) => item.rule === rule),
      ).toHaveLength(4);
      const { diagnostics } = JSON.parse(readFileSync(join(root, baseline), "utf8")) as {
        diagnostics: { ruleId: string; file: string; fingerprint: string }[];
      };
      writeFileSync(join(root, "src/Empty.ts"), " \n");
      writeFileSync(join(root, "src/TemplateOnly.vue"), template);
      writeFileSync(join(root, "src/Broken.vue"), `<script setup>const =</script>${template}`);
      writeFileSync(join(root, "src/External.vue"), `<script src="./external.js" />${template}`);
      writeFileSync(join(root, "src/ScriptOnly.vue"), "<script>export default {}</script>");
      writeFileSync(join(root, "src/Pug.vue"), '<template lang="pug">button Save</template>');

      const expected = diagnostics
        .filter(
          ({ ruleId, file }) =>
            (ruleId === rule && ["src/Empty.ts", "src/TemplateOnly.vue"].includes(file)) ||
            (ruleId === "vue/template/html-button-has-type" && file === "src/ScriptOnly.vue"),
        )
        .map(
          ({ ruleId, file, fingerprint }) =>
            `${ruleId} no longer reports fingerprint ${fingerprint} in ${file}.`,
        )
        .sort();
      expect(expected).toHaveLength(3);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          ruleId: "vue/template/html-button-has-type",
          file: "src/Pug.vue",
        }),
      );
      for (const _run of ["cold", "cached"]) {
        const result = await runCli([...args, "--new-only"], root);
        const resolved = JSON.parse(result.output).diagnostics.filter(
          (item: { code: string }) => item.code === "DOC0039",
        );
        expect(resolved).toHaveLength(1);
        expect(
          resolved[0].evidence.map((item: { summary: string }) => item.summary).sort(),
        ).toEqual(expected);
      }
    },
  );
});

test("CLI baseline updates require an explicit output path", async () => {
  await withFixture({ "package.json": "{}" }, async (root) => {
    const result = await runCli([".", "--update-baseline", "--format", "agent"], root);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "failed",
      error: { kind: "invocation", message: "--update-baseline requires --baseline <file>." },
    });
  });
});

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => void | Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-"));
  try {
    for (const [file, contents] of Object.entries(withResolvedRuntimePackages(files))) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withResolvedRuntimePackages(files: Record<string, string>): Record<string, string> {
  const packageJson = JSON.parse(files["package.json"] ?? "{}") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...packageJson.devDependencies, ...packageJson.dependencies };
  const generated: Record<string, string> = {};
  if (dependencies.nuxt && !files["node_modules/nuxt/package.json"]) {
    Object.assign(generated, nuxtRuntimeFixture({ nuxt: "4.0.0", nitro: "2.12.0", h3: "1.15.4" }));
    delete generated["package.json"];
  } else if (
    (dependencies.nitro || dependencies.nitropack) &&
    !files[`node_modules/${dependencies.nitro ? "nitro" : "nitropack"}/package.json`]
  ) {
    const nitroName = dependencies.nitro ? "nitro" : "nitropack";
    generated[`node_modules/${nitroName}/package.json`] = JSON.stringify({
      name: nitroName,
      version: "2.12.0",
      dependencies: { h3: "1.15.4" },
    });
    generated[`node_modules/${nitroName}/node_modules/h3/package.json`] = JSON.stringify({
      name: "h3",
      version: "1.15.4",
    });
  }
  if (dependencies.vue && !files["node_modules/vue/package.json"]) {
    generated["node_modules/vue/package.json"] = JSON.stringify({
      name: "vue",
      version: "3.5.18",
    });
  }
  return { ...generated, ...files };
}

async function runCli(args: string[], root: string) {
  const explicitFormat = args.includes("--format");
  return runWithCapturedStdout(() =>
    main(explicitFormat ? args : [...args, "--format", "text"], root),
  );
}

async function runWithCapturedStdout(fn: () => Promise<number>) {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await fn(), output: writes.join("") };
  } finally {
    process.stdout.write = write;
  }
}

function viteErrorFixture() {
  return {
    "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
    "vite.config.ts":
      "export default {\n  define: {\n    SECRET_KEY: JSON.stringify('secret'),\n  },\n}\n",
  };
}

function viteWarningFixture() {
  return {
    "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
    "vite.config.ts": "export default { envPrefix: ['APP_'] }\n",
  };
}

function nuxtRuntimeFixture({
  nuxt,
  nitro,
  h3,
  nitroName = "nitropack",
}: {
  nuxt: string;
  nitro: string;
  h3: string;
  nitroName?: "nitro" | "nitropack";
}) {
  return {
    "package.json": JSON.stringify({ dependencies: { nuxt, vue: "3.5.18" } }),
    "node_modules/nuxt/package.json": JSON.stringify({
      name: "nuxt",
      version: nuxt,
      dependencies: { [nitroName]: nitro, vue: "3.5.18" },
    }),
    [`node_modules/nuxt/node_modules/${nitroName}/package.json`]: JSON.stringify({
      name: nitroName,
      version: nitro,
      dependencies: { h3 },
    }),
    [`node_modules/nuxt/node_modules/${nitroName}/node_modules/h3/package.json`]: JSON.stringify({
      name: "h3",
      version: h3,
    }),
    "node_modules/vue/package.json": JSON.stringify({ name: "vue", version: "3.5.18" }),
  };
}

function nitroRuntimeFixture({ nitro, h3 }: { nitro: string; h3: string }) {
  return {
    "package.json": JSON.stringify({ dependencies: { nitropack: nitro } }),
    "node_modules/nitropack/package.json": JSON.stringify({
      name: "nitropack",
      version: nitro,
      dependencies: { h3 },
    }),
    "node_modules/nitropack/node_modules/h3/package.json": JSON.stringify({
      name: "h3",
      version: h3,
    }),
  };
}

function maliciousConfigSource(marker: string) {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./${marker}", import.meta.url), "executed");\n`;
}

async function runVitePlugin(
  plugin: ReturnType<typeof doctor>,
  root: string,
  command: "build" | "serve",
  levels?: { info: string[]; warn: string[] },
) {
  const logs: string[] = [];
  const logger = {
    info: (message: string) => {
      logs.push(message);
      levels?.info.push(message);
    },
    warn: (message: string) => {
      logs.push(message);
      levels?.warn.push(message);
    },
  };
  const context: any = {
    error(message: string) {
      throw new Error(message);
    },
  };

  const configResolved = plugin.configResolved;
  if (typeof configResolved === "function") {
    await configResolved.call(context, { root, command, logger } as any);
  }

  const buildStart = plugin.buildStart;
  if (typeof buildStart === "function") {
    await buildStart.call(context, {} as any);
  } else if (buildStart && "handler" in buildStart) {
    await buildStart.handler.call(context, {} as any);
  }

  return logs;
}

function findRepoRoot(): string {
  let current = process.cwd();
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = join(current, "..");
    if (parent === current) throw new Error("Could not find repo root");
    current = parent;
  }
  return current;
}
