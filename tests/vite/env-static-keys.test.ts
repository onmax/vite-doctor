import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import {
  noClientSecretPattern,
  noUntypedEnv,
  preferDirectImportMetaEnvAccess,
} from "../../src/rules.ts";

describe("Vite env static keys", () => {
  test.each([
    "const VITE_SECRET = 'VITE_PUBLIC'; console.log(import.meta.env[VITE_SECRET])",
    "const env = 'other'; console.log(import.meta[env].VITE_SECRET)",
    "const env = 'other'; const { VITE_SECRET } = import.meta[env]",
    "const VITE_SECRET = 'VITE_PUBLIC'; console.log(import.meta.env[VITE_SECRET as string])",
    "const env = 'other'; console.log(import.meta[env as string].VITE_SECRET)",
  ])("does not invent env names from computed variables: %s", async (source) => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noClientSecretPattern, noUntypedEnv, preferDirectImportMetaEnvAccess],
      files: { "src/main.ts": source },
    });

    expect(result.diagnostics).toEqual([]);
  });

  test.each([
    "import.meta.env.VITE_SECRET",
    "import.meta.env['VITE_SECRET']",
    "import.meta['env']['VITE_SECRET']",
    "import.meta.env[`VITE_SECRET`]",
    "import.meta[`env`].VITE_SECRET",
    'import.meta.env["VITE_SECRET" as const]',
    'import.meta.env["VITE_SECRET" satisfies string]',
    'import.meta.env["VITE_SECRET"!]',
    'import.meta.env[("VITE_SECRET")]',
    'import.meta.env[<string>"VITE_SECRET"]',
    'import.meta["env" as const].VITE_SECRET',
    'import.meta["env" satisfies string].VITE_SECRET',
    'import.meta["env"!].VITE_SECRET',
    'import.meta[("env")].VITE_SECRET',
    "import.meta.env[(`VITE_SECRET` as const)!]",
  ])("reports statically known env names: %s", async (expression) => {
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noClientSecretPattern, noUntypedEnv],
      files: { "src/main.ts": `console.log(${expression})` },
    });

    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual(["VITE0009", "VITE0011"]);
    expect(result.diagnostics.every(({ why }) => why?.includes("VITE_SECRET"))).toBe(true);
  });
});
