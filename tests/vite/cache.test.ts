import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { runViteDoctor } from "../../src/doctor.ts";

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

test("CLI cache clean rejects a regular file target", async () => {
  await withFixture(
    { "doctor.config.json": JSON.stringify({ cache: { dir: "package.json" } }) },
    async (root) => {
      writeFileSync(join(root, "package.json"), "{}");

      const result = await main(["cache", "clean"], root);

      expect(result).toBe(2);
      expect(existsSync(join(root, "package.json"))).toBe(true);
    },
  );
});

test("CLI cache clean removes a dangling cache symlink", async () => {
  await withFixture(
    {
      "doctor.config.json": JSON.stringify({ cache: { dir: "dangling-cache" } }),
    },
    async (root) => {
      const cache = join(root, "dangling-cache");
      symlinkSync(join(root, "missing-cache"), cache, "junction");
      expect(lstatSync(cache).isSymbolicLink()).toBe(true);

      const result = await main(["cache", "clean", "--framework", "vite"], root);

      expect(result).toBe(0);
      expect(() => lstatSync(cache)).toThrow();
    },
  );
});

test("CLI cache clean rejects an invalid framework without deleting caches", async () => {
  await withFixture(
    { "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }) },
    async (root) => {
      const caches = [join(root, ".nuxt/doctor/cache"), join(root, ".vite-doctor/cache")];
      for (const cache of caches) mkdirSync(cache, { recursive: true });

      const result = await main(["cache", "clean", "--framework", "banana"], root);

      expect(result).toBe(2);
      for (const cache of caches) expect(existsSync(cache)).toBe(true);
    },
  );
});

test("CLI cache clean reports filesystem errors for an invalid cache parent", async () => {
  await withFixture(
    {
      "doctor.config.json": JSON.stringify({ cache: { dir: "cache-parent/cache" } }),
      "cache-parent": "not a directory",
    },
    async (root) => {
      expect(await main(["cache", "clean"], root)).toBe(2);
      expect(existsSync(join(root, "cache-parent"))).toBe(true);
    },
  );
});

test("CLI cache clean succeeds when the cache is absent", async () => {
  await withFixture({}, async (root) => {
    expect(await main(["cache", "clean"], root)).toBe(0);
  });
});

test("CLI cache clean honors an explicit framework", async () => {
  await withFixture(
    { "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }) },
    async (root) => {
      const viteCache = join(root, ".vite-doctor/cache");
      mkdirSync(viteCache, { recursive: true });
      writeFileSync(join(viteCache, "entry.json"), "{}");

      const result = await main(["cache", "clean", "--framework", "vite"], root);

      expect(result).toBe(0);
      expect(existsSync(viteCache)).toBe(false);
    },
  );
});

test.each([false, true])(
  "Nuxt cache cleanup shares Doctor Run configuration (override: %s)",
  async (override) => {
    await withFixture(
      {
        "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
        "app/example.ts": "export const example = true;",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          doctorConfig: { cache: { dir: ".host-cache" } },
        }),
        ...(override
          ? { "doctor.config.json": JSON.stringify({ cache: { dir: ".explicit-cache" } }) }
          : {}),
      },
      async (root) => {
        const activeCache = join(root, override ? ".explicit-cache" : ".host-cache");
        const config = override ? { cache: { dir: ".explicit-cache" } } : undefined;
        await runViteDoctor({ root, config, extends: [], cache: true });
        expect(existsSync(activeCache)).toBe(true);

        const result = await main(["cache", "clean"], root);

        expect(result).toBe(0);
        expect(existsSync(activeCache)).toBe(false);
      },
    );
  },
);

test("CLI cache clean accepts an explicit executable config", async () => {
  await withFixture(
    {
      "package.json": JSON.stringify({ type: "module", dependencies: { vite: "^7.0.0" } }),
      "custom.config.ts": "export default { cache: { dir: '.custom-doctor-cache' } }",
    },
    async (root) => {
      const configuredCache = join(root, ".custom-doctor-cache");
      mkdirSync(configuredCache, { recursive: true });
      writeFileSync(join(configuredCache, "entry.json"), "{}");

      const result = await main(["cache", "clean", "--config", "custom.config.ts"], root);

      expect(result).toBe(0);
      expect(existsSync(configuredCache)).toBe(false);
    },
  );
});

test.each([".", "..", "absolute"])(
  "CLI cache clean rejects unsafe cache directory %s",
  async (dir) => {
    await withFixture({}, async (parent) => {
      const root = join(parent, "project");
      mkdirSync(root);
      writeFileSync(join(parent, "keep.json"), "{}");
      writeFileSync(
        join(root, "doctor.config.json"),
        JSON.stringify({ cache: { dir: dir === "absolute" ? parent : dir } }),
      );
      const result = await main(["cache", "clean"], root);

      expect(result).toBe(2);
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(parent, "keep.json"))).toBe(true);
    });
  },
);

test("CLI cache clean rejects paths through a symlink outside the project", async () => {
  await withFixture({}, async (parent) => {
    const root = join(parent, "project");
    const outsideCache = join(parent, "cache");
    mkdirSync(root);
    mkdirSync(outsideCache);
    writeFileSync(join(outsideCache, "entry.json"), "{}");
    symlinkSync(parent, join(root, "linked"), "junction");
    writeFileSync(
      join(root, "doctor.config.json"),
      JSON.stringify({ cache: { dir: "linked/cache" } }),
    );

    const result = await main(["cache", "clean"], root);

    expect(result).toBe(2);
    expect(existsSync(join(outsideCache, "entry.json"))).toBe(true);
  });
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
