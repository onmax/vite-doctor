import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, preferServerUtils } from "../../../src/rule-packs/nitro/index.ts";

const handler = "export default defineEventHandler(async (event) => requireAdmin(event))\n";
const helpers = {
  "server/lib/auth.ts": "export async function requireAdmin(event) {}\n",
  "server/helpers/paginate.ts": "export function paginate(event, rows) { return rows }\n",
  "server/utils/db.ts":
    "export const getDb = () => ({})\nexport { useDrizzle } from 'drizzle-kit'\n",
  "server/utils/db/client.ts": "export function createClient() {}\n",
};

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({ rule: preferServerUtils, framework, dependencies, files });
  return result.diagnostics;
}

async function codes(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  return (await run(files, framework, dependencies)).map((diagnostic) => diagnostic.code);
}

test("is a Strict-only Nitro rule", () => {
  expect(nitroRulePack.presets.strict).toContain(preferServerUtils.meta.id);
  expect(nitroRulePack.presets.recommended).not.toContain(preferServerUtils.meta.id);
});

describe("NITRO0021 helpers in ad-hoc server directories", () => {
  test("reports relative imports from server/lib and server/helpers", async () => {
    const diagnostics = await run({
      ...helpers,
      "server/api/admin/users.get.ts": `import { requireAdmin } from '../../lib/auth'\nimport { paginate } from '../../helpers/paginate'\n${handler}`,
    });
    expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity])).toEqual([
      ["NITRO0021", "info"],
      ["NITRO0021", "info"],
    ]);
    expect(diagnostics[0]?.message).toContain("server/lib/auth.ts");
    expect(diagnostics[0]?.suggestion).toContain("server/utils/auth.ts");
  });

  test.each([
    ["server/api/users.ts", "~~/server/lib/auth"],
    ["server/routes/feed.ts", "@@/server/lib/auth.ts"],
    ["server/middleware/auth.ts", "#server/lib/auth"],
    ["server/plugins/auth.ts", "../lib/auth.js"],
    ["server/tasks/cleanup.ts", "../lib/auth"],
  ])("reports %s importing %s", async (file, source) => {
    expect(
      await codes({ ...helpers, [file]: `import { requireAdmin } from '${source}'\n${handler}` }),
    ).toEqual(["NITRO0021"]);
  });

  test.each([
    ["type-only import", "import type { Session } from '../lib/auth'"],
    ["inline type import", "import { type Session } from '../lib/auth'"],
    ["default import", "import auth from '../lib/auth'"],
    ["namespace import", "import * as auth from '../lib/auth'"],
    ["side-effect import", "import '../lib/auth'"],
    ["database schema", "import { users } from '../db/schema'"],
    ["database directory", "import { users } from '../database/schema'"],
    ["server types", "import { Role } from '../types/roles'"],
    ["shared code", "import { slugify } from '../../shared/utils/slugify'"],
    ["package import", "import { z } from 'zod'"],
    ["unresolved import", "import { missing } from '../lib/missing'"],
    ["root-level server file", "import { helper } from '../helper'"],
  ])("ignores a %s", async (_name, source) => {
    expect(
      await codes({
        ...helpers,
        "server/db/schema.ts": "export const users = {}\n",
        "server/database/schema.ts": "export const users = {}\n",
        "server/types/roles.ts": "export enum Role { Admin }\n",
        "shared/utils/slugify.ts": "export const slugify = (value) => value\n",
        "server/helper.ts": "export const helper = () => {}\n",
        "server/api/users.ts": `${source}\n${handler}`,
      }),
    ).toEqual([]);
  });

  test("ignores imports from server/utils modules", async () => {
    expect(
      await codes({
        ...helpers,
        "server/utils/session.ts":
          "import { requireAdmin } from '../lib/auth'\nexport { requireAdmin }\n",
      }),
    ).toEqual([]);
  });
});

describe("NITRO0022 explicit imports of server/utils exports", () => {
  test("preserves explicit imports without resolved Nitro provider evidence", async () => {
    const diagnostics = await run({
      ...helpers,
      "server/api/users.ts": `import { getDb } from '../utils/db'\n${handler}`,
    });
    expect(diagnostics).toEqual([]);
  });

  test.each([
    ["nested utils module", "import { createClient } from '../utils/db/client'"],
    ["re-exported name", "import { useDrizzle } from '../utils/db'"],
    ["alias", "import { getDb } from '~~/server/utils/db'"],
    ["partial import", "import { getDb, type Db } from '../utils/db'"],
  ])("preserves a %s without resolved Nitro evidence", async (_name, source) => {
    expect(await codes({ ...helpers, "server/api/users.ts": `${source}\n${handler}` })).toEqual([]);
  });

  test.each(["db", "nested/other"])(
    "preserves imports from duplicate provider %s",
    async (source) => {
      expect(
        await codes({
          ...helpers,
          "server/utils/nested/other.ts": "export const getDb = () => 'other'",
          "server/api/users.ts": `import { getDb } from '../utils/${source}'\n${handler}`,
        }),
      ).toEqual([]);
    },
  );

  test("preserves every name in a mixed import without resolved Nitro evidence", async () => {
    const diagnostics = await run({
      ...helpers,
      "server/utils/other.ts": "export { getDb } from './db'",
      "server/api/users.ts": `import { getDb, useDrizzle } from '../utils/db'\n${handler}`,
    });
    expect(diagnostics).toEqual([]);
  });

  test.each(["db", "all"])(
    "stays silent for %s when wildcard exports obscure providers",
    async (source) => {
      expect(
        await codes({
          ...helpers,
          "server/utils/all.ts": "export * from './db'",
          "server/api/users.ts": `import { getDb } from '../utils/${source}'\n${handler}`,
        }),
      ).toEqual([]);
    },
  );

  test.each([
    "export default function getDb() {}",
    "const value = {}; export { value as default }",
    "export const { getDb } = source",
    "export const =",
    "export enum getDb { Main }",
  ])("preserves explicit imports with competing utility exports: %s", async (source) => {
    expect(
      await codes({
        ...helpers,
        "server/utils/other.ts": source,
        "server/api/users.ts": `import { getDb } from '../utils/db'\n${handler}`,
      }),
    ).toEqual([]);
  });

  test("preserves duplicate imports in standalone Nitro 2", async () => {
    expect(
      await codes(
        {
          "utils/db.ts": "export const getDb = () => 'first'",
          "utils/other.ts": "export const getDb = () => 'second'",
          "routes/users.ts": `import { getDb } from '../utils/db'\n${handler}`,
        },
        "nitro",
      ),
    ).toEqual([]);
  });

  test.each([
    "dirs: ['extra']",
    "presets: [{ from: 'custom-db', imports: ['getDb'] }]",
    "exclude: ['**/utils/db.ts']",
  ])("preserves standalone Nitro imports with %s", async (option) => {
    expect(
      await codes(
        {
          "utils/db.ts": "export const getDb = () => 'local'",
          "extra/db.ts": "export const getDb = () => 'custom'",
          "nitro.config.ts": `export default defineNitroConfig({ imports: { ${option} } })`,
          "routes/users.ts": `import { getDb } from '../utils/db'\n${handler}`,
        },
        "nitro",
      ),
    ).toEqual([]);
  });

  test("preserves default-excluded utility imports", async () => {
    expect(
      await codes(
        {
          "utils/db.test.ts": "export const getDb = () => 'test'",
          "routes/users.ts": `import { getDb } from '../utils/db.test'\n${handler}`,
        },
        "nitro",
      ),
    ).toEqual([]);
  });

  test("detects duplicate providers in another Nuxt layer", async () => {
    expect(
      await codes({
        ...helpers,
        "layers/base/server/utils/db.ts": "export const getDb = () => 'layer'",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          nuxtVersion: "4.0.0",
          vueVersion: "3.5",
          rootDir: ".",
          srcDir: "app",
          appDir: "app",
          buildDir: ".nuxt",
          autoImportEnabled: true,
          autoImports: [],
          components: [],
          aliases: {},
          routeRules: {},
          serverHandlers: [],
          modules: [],
          layers: [
            { root: ".", serverDir: "server", priority: 0 },
            { root: "layers/base", serverDir: "layers/base/server", priority: 1 },
          ],
        }),
        "server/api/users.ts": `import { getDb } from '../utils/db'\n${handler}`,
      }),
    ).toEqual([]);
  });

  test("does not classify server directories from a stale Nuxt manifest", async () => {
    expect(
      await codes({
        "old-server/lib/auth.ts": helpers["server/lib/auth.ts"],
        "old-server/api/users.ts": `import { requireAdmin } from '../lib/auth'\n${handler}`,
        ".nuxt/doctor.manifest.json": JSON.stringify({
          autoImportEnabled: true,
          layers: [{ root: ".", serverDir: "old-server", priority: 0 }],
        }),
      }),
    ).toEqual([]);
  });

  test.each([
    ["renamed import", "import { getDb as db } from '../utils/db'"],
    ["missing export", "import { nothing } from '../utils/db'"],
  ])("ignores a %s", async (_name, source) => {
    expect(await codes({ ...helpers, "server/api/users.ts": `${source}\n${handler}` })).toEqual([]);
  });
});

describe("server auto-import activation", () => {
  const route = `import { requireAdmin } from '../lib/auth'\nimport { getDb } from '../utils/db'\n${handler}`;

  test.each([
    ["imports.autoImport", "imports: { autoImport: false }"],
    ["experimental.nitroAutoImports", "experimental: { nitroAutoImports: false }"],
    ["nitro.imports", "nitro: { imports: false }"],
    ["nitro.imports.autoImport", "nitro: { imports: { autoImport: false } }"],
  ])("stays silent when Nuxt disables %s", async (_name, option) => {
    expect(
      await codes({
        ...helpers,
        "nuxt.config.ts": `export default defineNuxtConfig({ ${option} })`,
        "server/api/users.ts": route,
      }),
    ).toEqual([]);
  });

  test("stays silent when the Nuxt manifest reports auto-imports disabled", async () => {
    expect(
      await codes({
        ...helpers,
        ".nuxt/doctor.manifest.json": JSON.stringify({
          nuxtVersion: "4.0.0",
          vueVersion: "3.5",
          rootDir: ".",
          srcDir: "app",
          appDir: "app",
          buildDir: ".nuxt",
          autoImportEnabled: false,
          autoImports: [],
          components: [],
          layers: [{ root: ".", serverDir: "server", priority: 0 }],
          aliases: {},
          routeRules: {},
          serverHandlers: [],
          modules: [],
        }),
        "server/api/users.ts": route,
      }),
    ).toEqual([]);
  });

  test("runs in standalone Nitro 2 projects", async () => {
    expect(
      await codes(
        {
          "lib/auth.ts": helpers["server/lib/auth.ts"],
          "utils/db.ts": helpers["server/utils/db.ts"],
          "routes/users.ts": route,
        },
        "nitro",
      ),
    ).toEqual(["NITRO0021"]);
  });

  test("stays silent when Nitro 2 disables imports", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts": "export default defineNitroConfig({ imports: false })",
          "lib/auth.ts": helpers["server/lib/auth.ts"],
          "routes/users.ts": route,
        },
        "nitro",
      ),
    ).toEqual([]);
  });

  test("stays silent in Nitro 3, which removed auto-imports", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts": "export default defineConfig({ serverDir: 'server' })",
          ...helpers,
          "server/routes/users.ts": route,
        },
        "nitro",
        { nitro: "3.0.0-beta.1", h3: "2.0.0-beta.1" },
      ),
    ).toEqual([]);
  });
});
