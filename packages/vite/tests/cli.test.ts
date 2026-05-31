import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  allDiagnostics,
  createRule,
  defineDoctorExtension,
  defineRulePack,
} from "@vue-doctor/core";
import { expect, test } from "vite-plus/test";
import { main } from "../src/cli.ts";
import { doctor } from "../src/plugin.ts";

test("CLI rejects removed run command", async () => {
  const repoRoot = findRepoRoot();
  await expect(main(["run", "--dry-run"], repoRoot)).resolves.toBe(1);
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

test("CLI lists only Vite rule metadata by default", async () => {
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
  expect(writes.join("")).not.toContain("nuxt/hydration/no-client-conditional-in-template");
});

test("Nuxt CLI entry is import-safe", async () => {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const mod = await import("../src/nuxt-cli.ts");
    expect(typeof mod.main).toBe("function");
  } finally {
    process.stdout.write = write;
  }

  expect(writes).toEqual([]);
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
        await expect(main(["."], root)).resolves.toBe(0);
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
      expect(forced.code).toBe(1);
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

test("CLI rejects executable config loading in vite-doctor", async () => {
  await withFixture(viteErrorFixture(), async (root) => {
    const result = await main([".", "--trusted-config"], root);
    expect(result).toBe(1);
  });
});

test("CLI scan fails for a missing path", async () => {
  const repoRoot = findRepoRoot();
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await expect(main(["scan", "__missing_vite_doctor_path__"], repoRoot)).resolves.toBe(1);
  } finally {
    console.error = error;
  }

  expect(errors.join("\n")).toContain("No readable directory found");
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
            allDiagnostics.DOC9999.report({
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
        "import { defineDoctorConfig } from '@vue-doctor/core'\nexport default defineDoctorConfig({ rules: { 'vite/define/no-secret-define': 'off' } })\n",
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

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => void | Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runCli(args: string[], root: string) {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await main(args, root), output: writes.join("") };
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
