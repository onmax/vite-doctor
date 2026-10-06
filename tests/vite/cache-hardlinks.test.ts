import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.ts";

async function fixture(run: (root: string, parent: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "doctor-cache-hardlink-"));
  const root = join(parent, "project");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      '{"type":"module","devDependencies":{"vite":"^7.0.0"}}',
    );
    writeFileSync(
      join(root, "src/main.ts"),
      "export const secret = import.meta.env.VITE_SECRET_TOKEN;",
    );
    await run(root, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const options = { rules: "vite/env/no-client-secret-pattern", cache: true };

test("rebuilding an invalid hardlinked cache entry preserves the other file", async () => {
  await fixture(async (root, parent) => {
    const initial = await runViteDoctor({ root, ...options });
    const cache = join(root, ".vite-doctor/cache");
    const entries = readdirSync(cache);
    expect(entries).toHaveLength(1);
    const cached = join(cache, entries[0]!);
    const outside = join(parent, "outside.txt");
    const original = "This file is unrelated to Doctor's cache.\n";
    writeFileSync(outside, original);
    rmSync(cached);
    linkSync(outside, cached);
    expect(statSync(outside).nlink).toBe(2);

    const rerun = await runViteDoctor({ root, ...options });

    expect(readFileSync(outside, "utf8")).toBe(original);
    expect(statSync(outside).nlink).toBe(1);
    expect(Object.values(JSON.parse(readFileSync(cached, "utf8")).entries)).toEqual([
      expect.objectContaining({ path: join(root, "src/main.ts") }),
    ]);
    expect(rerun.diagnostics.map((item) => item.code)).toEqual(
      initial.diagnostics.map((item) => item.code),
    );
    expect(readdirSync(cache)).toEqual(entries);
  });
});

test("ordinary cache writes remain readable and preserve warm-run diagnostics", async () => {
  await fixture(async (root) => {
    const cold = await runViteDoctor({ root, ...options });
    const cache = join(root, ".vite-doctor/cache");
    const entries = readdirSync(cache);
    const cached = join(cache, entries[0]!);
    const content = readFileSync(cached, "utf8");
    const warm = await runViteDoctor({ root, ...options });
    expect(cold.diagnostics.map((item) => item.code)).toEqual(["VITE0009"]);
    expect(warm.diagnostics.map((item) => item.fingerprint)).toEqual(
      cold.diagnostics.map((item) => item.fingerprint),
    );
    expect(readFileSync(cached, "utf8")).toBe(content);
    expect(readdirSync(cache)).toEqual(entries);
  });
});

test("failed cache replacement preserves the existing path and removes temporary files", async () => {
  await fixture(async (root) => {
    const cold = await runViteDoctor({ root, ...options });
    const cache = join(root, ".vite-doctor/cache");
    const entries = readdirSync(cache);
    const cached = join(cache, entries[0]!);
    rmSync(cached);
    mkdirSync(cached);
    writeFileSync(join(cached, "sentinel.txt"), "Keep this directory.");

    const rerun = await runViteDoctor({ root, ...options });

    expect(rerun.diagnostics.map((item) => item.fingerprint)).toEqual(
      cold.diagnostics.map((item) => item.fingerprint),
    );
    expect(readFileSync(join(cached, "sentinel.txt"), "utf8")).toBe("Keep this directory.");
    expect(readdirSync(cache)).toEqual(entries);
  });
});
