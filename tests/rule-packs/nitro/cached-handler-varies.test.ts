import { describe, expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import { nitroRulePack, requireVariesForHeaderRead } from "../../../src/rule-packs/nitro/index.ts";

const nitro3 = { nitro: "3.0.0-beta.1", h3: "2.0.0-beta.1" };
const nitro3Config = "export default defineConfig({ serverDir: true })\n";

async function run(
  files: Record<string, string>,
  framework: "nuxt" | "nitro" = "nuxt",
  dependencies?: Record<string, string>,
) {
  const result = await runRuleFixture({
    rule: requireVariesForHeaderRead,
    framework,
    dependencies,
    files,
  });
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    line: diagnostic.range?.line,
    why: diagnostic.why,
    suggestion: diagnostic.suggestion,
  }));
}

async function codes(...args: Parameters<typeof run>) {
  return (await run(...args)).map((diagnostic) => `${diagnostic.code}:${diagnostic.line}`);
}

test("is a recommended Nitro rule", () => {
  expect(nitroRulePack.presets.recommended).toContain(requireVariesForHeaderRead.meta.id);
});

describe("NITRO0029 Nitro 2 cached handlers", () => {
  test("explains that a custom key must vary independently of header passthrough", async () => {
    expect(
      await run({
        "server/api/locale.ts":
          "export default defineCachedEventHandler((event) => getHeader(event, 'accept-language'), { getKey: () => 'page' })",
      }),
    ).toEqual([
      expect.objectContaining({
        suggestion: expect.stringContaining("custom getKey"),
      }),
    ]);
  });

  test("reports a header read that varies does not list", async () => {
    const diagnostics = await run({
      "server/api/greeting.get.ts": `export default defineCachedEventHandler(async (event) => {
  const language = getHeader(event, 'accept-language')
  return { language }
}, { maxAge: 60 })
`,
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "NITRO0029",
        line: 2,
        why: expect.stringContaining("accept-language request header"),
      }),
    ]);
  });

  test.each([
    ["getCookie", "getCookie(event, 'session')"],
    ["getRequestHeader", "getRequestHeader(event, 'X-Tenant')"],
    ["parseCookies", "parseCookies(event)"],
    ["event.headers.get", "event.headers.get('authorization')"],
    ["node request headers", "event.node.req.headers['x-tenant']"],
  ])("reports %s", async (_name, read) => {
    expect(
      await codes({
        "server/routes/profile.ts": `export default cachedEventHandler((event) => ${read}, { varies: ['accept-language'] })\n`,
      }),
    ).toEqual(["NITRO0029:1"]);
  });

  test("reports handlers imported from nitropack/runtime in a standalone Nitro app", async () => {
    expect(
      await codes(
        {
          "api/tenant.ts": `import { defineCachedEventHandler } from 'nitropack/runtime'
import { getRequestHeader } from 'h3'

export default defineCachedEventHandler((event) => getRequestHeader(event, 'x-tenant'))
`,
        },
        "nitro",
      ),
    ).toEqual(["NITRO0029:4"]);
  });

  test.each([
    ["a header listed in varies with different casing", "{ varies: ['X-Tenant'] }"],
    ["headersOnly, which passes the live request", "{ headersOnly: true }"],
  ])("stays quiet for %s", async (_name, options) => {
    expect(
      await codes({
        "server/api/tenant.ts": `export default defineCachedEventHandler((event) => getHeader(event, 'x-tenant'), ${options})\n`,
      }),
    ).toEqual([]);
  });

  test("stays quiet outside a cached handler and for a local cached-handler helper", async () => {
    expect(
      await codes({
        "server/api/plain.ts":
          "export default defineEventHandler((event) => getHeader(event, 'x-tenant'))\n",
        "server/api/local.ts": `import { defineCachedEventHandler } from '../utils/my-cache'
export default defineCachedEventHandler((event) => getHeader(event, 'x-tenant'))
`,
      }),
    ).toEqual([]);
  });

  test.each([
    ["dynamic varies", "{ varies: tenantHeaders }"],
    ["a spread options object", "{ ...cacheOptions, maxAge: 60 }"],
    ["a dynamic header name", "{}", "getHeader(event, headerName)"],
  ])(
    "records an evidence gap for %s",
    async (_name, options, read = "getHeader(event, 'x-tenant')") => {
      expect(
        await codes({
          "server/api/tenant.ts": `export default defineCachedEventHandler((event) => ${read}, ${options})\n`,
        }),
      ).toEqual([]);
    },
  );
});

describe("NITRO0029 Nitro 3 cached handlers", () => {
  test("reports a stripped header and a cookie that allowCookies filters out", async () => {
    const diagnostics = await run(
      {
        "nitro.config.ts": nitro3Config,
        "server/routes/page.ts": `import { defineCachedHandler } from 'nitro/cache'
import { getCookie } from 'nitro/h3'

export default defineCachedHandler((event) => {
  const tenant = event.req.headers.get('x-tenant')
  const theme = getCookie(event, 'theme')
  return { tenant, theme }
}, { varies: ['cookie'], allowCookies: ['session'] })
`,
      },
      "nitro",
      nitro3,
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "NITRO0029", line: 5 }),
      expect.objectContaining({
        code: "NITRO0029",
        line: 6,
        why: expect.stringContaining("allowCookies does not list it"),
      }),
    ]);
  });

  test("stays quiet for headers Nitro 3 keeps and for non-GET routes", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts": nitro3Config,
          "server/routes/kept.ts": `import { defineCachedHandler } from 'nitro/cache'
export default defineCachedHandler((event) => [
  event.req.headers.get('host'),
  event.req.headers.get('authorization'),
  getCookie(event, 'session'),
], { allowAuthorization: true, allowCookies: ['session'] })
`,
          "server/routes/submit.post.ts": `import { defineCachedHandler } from 'nitro/cache'
export default defineCachedHandler((event) => event.req.headers.get('x-tenant'))
`,
        },
        "nitro",
        nitro3,
      ),
    ).toEqual([]);
  });

  test("records an evidence gap when cache defaults are configured", async () => {
    expect(
      await codes(
        {
          "nitro.config.ts":
            "export default defineConfig({ serverDir: true, cache: { defaults: { varies: ['x-tenant'] } } })\n",
          "server/routes/page.ts": `import { defineCachedHandler } from 'nitro/cache'
export default defineCachedHandler((event) => event.req.headers.get('x-tenant'))
`,
        },
        "nitro",
        nitro3,
      ),
    ).toEqual([]);
  });

  test("stays quiet for QUERY, POST TSX, and Range on GET", async () => {
    const cachedRead = (header: string) => `import { defineCachedHandler } from 'nitro/cache'
export default defineCachedHandler((event) => event.req.headers.get('${header}'))`;
    expect(
      await codes(
        {
          "nitro.config.ts": nitro3Config,
          "server/routes/page.query.ts": cachedRead("x-tenant"),
          "server/routes/page.post.tsx": cachedRead("x-tenant"),
          "server/routes/page.get.ts": cachedRead("Range"),
        },
        "nitro",
        nitro3,
      ),
    ).toEqual([]);
  });

  test.each([
    ["routesDir", "routes", "api"],
    ["apiDir", "api", "routes"],
  ])("reports an explicit GET handler outside the configured %s", async (option, dir, otherDir) => {
    const cachedRead = `import { defineCachedHandler } from 'nitro/cache'
export default defineCachedHandler((event) => event.req.headers.get('x-locale'))`;
    const handler = `server/${dir}/page.post.ts`;
    expect(
      await run(
        {
          "vite.config.ts": `import { nitro } from 'nitro/vite'
export default { plugins: [nitro({
  serverDir: true,
  ${option}: 'pages',
  ${otherDir}Dir: './${otherDir}',
  routes: { '/preview': { method: 'get', handler: './${handler}' } },
})] }`,
          [handler]: cachedRead,
          [`server/${otherDir}/page.post.ts`]: cachedRead.replace("x-locale", "x-post"),
        },
        "nitro",
        nitro3,
      ),
    ).toEqual([
      expect.objectContaining({ code: "NITRO0029", why: expect.stringContaining("x-locale") }),
    ]);
  });

  test.each(["...viteSettings", "clearScreen: false"])(
    "keeps POST bypass evidence for a custom route suffix with %s",
    async (settings) => {
      const cachedRead = `import { defineCachedHandler } from 'nitro/cache'
export default defineCachedHandler((event) => event.req.headers.get('x-locale'))`;
      const diagnostics = await run(
        {
          "vite.config.ts": `import { nitro } from 'nitro/vite'
const viteSettings = { clearScreen: false }
export default { plugins: [nitro({ serverDir: true, scanSuffixes: ['custom'] })], ${settings} }`,
          "server/routes/page.custom.post.ts": cachedRead,
          "server/routes/page.custom.get.ts": cachedRead.replace("x-locale", "x-get"),
          "server/utils/page.custom.post.ts": cachedRead.replace("x-locale", "x-util"),
        },
        "nitro",
        nitro3,
      );
      expect(diagnostics).toHaveLength(2);
      for (const header of ["x-get", "x-util"]) {
        expect(diagnostics).toContainEqual(
          expect.objectContaining({ code: "NITRO0029", why: expect.stringContaining(header) }),
        );
      }
    },
  );

  test.each([
    "extends: './base'",
    "$production: { cache: { defaults: { varies: ['x-tenant'] } } }",
  ])("does not assume cache defaults with %s", async (config) => {
    expect(
      await codes(
        {
          "nitro.config.ts": `export default defineConfig({ serverDir: true, ${config} })`,
          "base/nitro.config.ts":
            "export default defineConfig({ cache: { defaults: { varies: ['x-tenant'] } } })",
          "server/routes/page.ts":
            "import { defineCachedHandler } from 'nitro/cache'\nexport default defineCachedHandler(event => event.req.headers.get('x-tenant'))",
        },
        "nitro",
        nitro3,
      ),
    ).toEqual([]);
  });
});
