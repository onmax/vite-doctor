import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { detectPackageManager, parsePackageManager, planCi, selectScripts } from "../src/index.ts";
import { main } from "../src/cli.ts";
import nuxtModule from "../src/nuxt.ts";
import { doctor } from "../src/plugin.ts";

test("detects package manager from packageManager field", () => {
  expect(parsePackageManager("pnpm@11.0.9")).toBe("pnpm");
  expect(parsePackageManager("bun@1.2.0")).toBe("bun");
  expect(parsePackageManager("yarn@4.0.0")).toBe("yarn");
  expect(parsePackageManager("npm@11.0.0")).toBe("npm");
});

test("detects package manager from lockfiles", async () => {
  await withFixture({ "pnpm-lock.yaml": "" }, (root) => {
    expect(detectPackageManager(root, {})).toBe("pnpm");
  });
  await withFixture({ "bun.lock": "" }, (root) => {
    expect(detectPackageManager(root, {})).toBe("bun");
  });
  await withFixture({ "yarn.lock": "" }, (root) => {
    expect(detectPackageManager(root, {})).toBe("yarn");
  });
  await withFixture({ "package-lock.json": "" }, (root) => {
    expect(detectPackageManager(root, {})).toBe("npm");
  });
});

test("prefers package ci script unless it calls vite-doctor", () => {
  expect(selectScripts({ ci: "pnpm test", ready: "pnpm build" })).toEqual(["ci"]);
  expect(selectScripts({ ci: "vite-doctor", ready: "pnpm test" })).toEqual(["ready"]);
});

test("prefers ready before standard scripts", () => {
  expect(selectScripts({ ready: "vp fmt", test: "vp test", build: "vp build" })).toEqual(["ready"]);
});

test("selects standard scripts in stable order", () => {
  expect(
    selectScripts({
      build: "vite build",
      "type:check": "vue-tsc",
      lint: "eslint .",
      test: "vitest",
      check: "biome check .",
    }),
  ).toEqual(["check", "lint", "type:check", "test", "build"]);

  expect(selectScripts({ typecheck: "tsc", "type:check": "vue-tsc" })).toEqual(["typecheck"]);
});

test("fails when no package json exists", async () => {
  await withFixture({}, (root) => {
    expect(() => planCi(root)).toThrow(/No package\.json found/);
  });
});

test("fails when no known scripts exist", async () => {
  await withFixture(
    { "package.json": JSON.stringify({ scripts: { dev: "vite dev" } }) },
    (root) => {
      expect(() => planCi(root)).toThrow(/No project scripts found/);
    },
  );
});

test("dry-run plan for this repo uses pnpm ready", () => {
  const repoRoot = findRepoRoot();
  const plan = planCi(repoRoot);

  expect(plan.packageManager).toBe("pnpm");
  expect(plan.commands.map((command) => command.display)).toEqual(["pnpm run ready"]);
});

test("CLI dry-run for this repo prints pnpm ready", async () => {
  const repoRoot = findRepoRoot();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await expect(main(["--dry-run"], repoRoot)).resolves.toBe(0);
  } finally {
    console.log = log;
  }

  expect(lines).toContain("Package manager: pnpm");
  expect(lines).toContain("- pnpm run ready");
});

test("CLI accepts run as the explicit command", async () => {
  const repoRoot = findRepoRoot();
  const log = console.log;
  console.log = () => {};
  try {
    await expect(main(["run", "--dry-run"], repoRoot)).resolves.toBe(0);
  } finally {
    console.log = log;
  }
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

test("CLI prints Nuxt rule metadata through vite-doctor", async () => {
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

  expect(writes.join("")).toContain("nuxt/hydration/no-client-conditional-in-template");
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

test("smart scan applies Vue rules in Vue projects", async () => {
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

test("smart scan applies Nuxt and Nitro rules in Nuxt projects", async () => {
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

test("exports the Nuxt module path", () => {
  expect(typeof nuxtModule).toBe("function");
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
