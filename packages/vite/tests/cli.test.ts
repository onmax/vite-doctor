import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { detectPackageManager, parsePackageManager, planCi, selectScripts } from "../src/index.ts";
import { main } from "../src/cli.ts";

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

async function withFixture(files: Record<string, string>, fn: (root: string) => void) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
