import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { main } from "../../src/cli.ts";

test("CLI cache clean removes the active Nuxt cache directory", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
    },
    async (root) => {
      const nuxtCache = join(root, ".nuxt/doctor/cache");
      const viteCache = join(root, ".vite-doctor/cache");
      mkdirSync(nuxtCache, { recursive: true });
      mkdirSync(viteCache, { recursive: true });
      writeFileSync(join(nuxtCache, "entry.json"), "{}");
      writeFileSync(join(viteCache, "entry.json"), "{}");

      const result = await main(["cache", "clean"], root);

      expect(result).toBe(0);
      expect(existsSync(nuxtCache)).toBe(false);
      expect(existsSync(viteCache)).toBe(true);
    },
  );
});

test("CLI cache clean respects declarative cache configuration", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ dependencies: { vite: "^7.0.0" } }),
      "doctor.config.json": JSON.stringify({ cache: { dir: ".custom-doctor-cache" } }),
    },
    async (root) => {
      const configuredCache = join(root, ".custom-doctor-cache");
      mkdirSync(configuredCache, { recursive: true });
      writeFileSync(join(configuredCache, "entry.json"), "{}");

      const result = await main(["cache", "clean"], root);

      expect(result).toBe(0);
      expect(existsSync(configuredCache)).toBe(false);
    },
  );
});

async function withFixture(files: Record<string, string>, fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-cache-"));
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
