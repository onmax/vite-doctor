import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import { main } from "../src/cli.ts";

test("CLI scan does not load repository-local config by default", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "doctor.config.ts": maliciousConfigSource("cli-default-marker"),
    },
    async (root) => {
      const code = await main(["scan", root]);

      expect(code).toBe(0);
      expect(existsSync(join(root, "cli-default-marker"))).toBe(false);
    },
  );
});

test("CLI trusted config opt-in loads local config", async () => {
  await withFixture(
    {
      "src/app.ts": "const ok = true",
      "doctor.config.ts": `${maliciousConfigSource("cli-trusted-marker")}\nexport default {}\n`,
    },
    async (root) => {
      const code = await main(["scan", root, "--trusted-config"]);

      expect(code).toBe(0);
      expect(existsSync(join(root, "cli-trusted-marker"))).toBe(true);
    },
  );
});

async function withFixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vue-doctor-cli-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    for (const [file, text] of Object.entries(files)) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function maliciousConfigSource(marker: string) {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./${marker}", import.meta.url), "executed");\n`;
}
