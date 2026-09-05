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
import { expect, test } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { formatMigrationReport } from "../../src/migration.ts";
import { doctor } from "../../src/plugin.ts";

const publicPackageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  version: string;
  dependencies?: Record<string, string>;
};
const publicPackageVersion = publicPackageJson.version;

test("package installs the TypeScript runtime required by its parsers", () => {
  expect(publicPackageJson.dependencies?.["@typescript-eslint/parser"]).toBeTruthy();
  expect(publicPackageJson.dependencies?.typescript).toBeTruthy();
});

test("CLI rejects removed run command", async () => {
  const repoRoot = findRepoRoot();
  await expect(main(["run", "--dry-run", "--format", "text"], repoRoot)).resolves.toBe(2);
});

test("CLI rejects the removed type analysis flag", async () => {
  const result = await runCli([".", "--types", "--format", "agent"], findRepoRoot());

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

test("CLI prints Vite rule metadata", async () => {
  const repoRoot = findRepoRoot();
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await expect(main(["rules", "--format", "json"], repoRoot)).resolves.toBe(0);
  } finally {
    process.stdout.write = write;
  }

  expect(writes.join("")).toContain("vite/define/no-secret-define");
});

test("CLI rules report uses the public package version", async () => {
  const repoRoot = findRepoRoot();
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await expect(main(["rules", "--format", "json"], repoRoot)).resolves.toBe(0);
  } finally {
    process.stdout.write = write;
  }

  const report = JSON.parse(writes.join(""));
  expect(report.rules[0].version).toBe(publicPackageVersion);
});

test("CLI lists only Vite rule metadata by default", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
    },
    async (root) => {
      const result = await runCli(["rules", "--format", "json"], root);

      expect(result.code).toBe(0);
      expect(result.output).toContain("vite/define/no-secret-define");
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
    expect(nuxtOnly.output).not.toContain("nuxt/");
  });
});

test("smart scan activates Vue rules from Vue project signals", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vue: "^3.5.0" } }),
      "src/App.vue": `<template><div v-html="html" /></template>
<script setup lang="ts">
const html = "<strong>unsafe</strong>";
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
        [".", "--rules", "nitro/request/prefer-get-request-ip", "--max-warnings", "0"],
        root,
      );
      expect(nitro.code).toBe(1);
      expect(nitro.output).toContain("Detected: Nuxt");
      expect(nitro.output).toContain("nitro/request/prefer-get-request-ip");
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
const html = "<strong>unsafe</strong>";
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

test("CLI returns structured failures for unknown Diagnostic Codes", async () => {
  const result = await runWithCapturedStdout(() =>
    main(["explain", "DOES_NOT_EXIST", "--format", "agent"], findRepoRoot()),
  );
  expect(result.code).toBe(2);
  expect(JSON.parse(result.output)).toMatchObject({
    schema: "vite-doctor.agent/v1",
    status: "failed",
    next: { action: "correct-invocation" },
  });
});

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

test("Vite plugin contributes resolved config inventory to Doctor Run", async () => {
  const surfaceInventoryRule = createRule({
    meta: {
      id: "fixture/vite-surface-inventory",
      title: "Vite surface inventory",
      category: "inventory",
      severity: "warn",
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
          "nitro/runtime/require-event-runtime-config-in-server,nitro/runtime/no-event-runtime-config-in-server,nitro/migration/no-v2-imports,nitro/h3/prefer-with-base",
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
      expect(codes).not.toContain("NITRO0017");
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
          "nitro/runtime/require-event-runtime-config-in-server,nitro/runtime/no-event-runtime-config-in-server,nitro/migration/no-v2-imports,nitro/h3/no-removed-send,nitro/h3/prefer-redirect-response,nitro/h3/prefer-with-base",
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
        expect.arrayContaining(["NITRO0013", "NITRO0014", "NITRO0015", "NITRO0016", "NITRO0017"]),
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
          "NITRO0015",
          "NITRO0017",
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
        schema: "vite-doctor.report/v3",
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
        schema: "vite-doctor.report/v3",
        status: "failed",
      });
    },
  );
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
) {
  const logs: string[] = [];
  const logger = {
    info: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message),
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
