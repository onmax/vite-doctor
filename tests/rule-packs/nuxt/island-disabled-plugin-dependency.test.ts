import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import { noIslandDisabledPluginDependency } from "../../../src/rule-packs/nuxt/rules/nuxt/no-island-disabled-plugin-dependency.ts";

async function run(files: Record<string, string>) {
  const result = await runProjectFixture({
    rules: [noIslandDisabledPluginDependency],
    framework: "nuxt",
    files,
  });
  return result.diagnostics;
}

const plugin = (body: string) => `export default defineNuxtPlugin({\n${body}\n  setup() {},\n})\n`;
const auth = plugin("  name: 'auth',\n  env: { islands: false },");
const api = plugin("  name: 'api',\n  dependsOn: ['auth'],");
const island = { "app/components/Chart.server.vue": "<template><div /></template>\n" };

describe("nuxt/plugins/no-island-disabled-dependency", () => {
  test("reports a plugin that depends on an island-disabled plugin when the app renders islands", async () => {
    const diagnostics = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("NUXT0104");
    expect(diagnostics[0]?.severity).toBe("warn");
    expect(diagnostics[0]?.file).toMatch(/app\/plugins\/api\.ts$/);
    expect(diagnostics[0]?.range?.line).toBe(3);
    expect(diagnostics[0]?.why).toContain("'auth'");
    expect(diagnostics[0]?.why).toContain("islands: false");
    expect(diagnostics[0]?.related?.[0]?.file).toMatch(/app\/plugins\/auth\.ts$/);
    expect(diagnostics[0]?.related?.[0]?.range?.line).toBe(3);
  });

  test("reports island components and index plugins with explicitly enabled islands", async () => {
    const diagnostics = await run({
      "nuxt.config.ts":
        "export default defineNuxtConfig({ experimental: { componentIslands: true } })\n",
      "app/components/Feed.island.vue": "<template><div /></template>\n",
      "app/plugins/auth/index.ts": auth,
      "app/plugins/02.api.server.ts": api,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toMatch(/02\.api\.server\.ts$/);
  });

  test("stays quiet when islands are off or nothing renders as an island", async () => {
    const off = await run({
      ...island,
      "nuxt.config.ts":
        "export default defineNuxtConfig({ experimental: { componentIslands: false } })\n",
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });
    const noIslands = await run({
      "app/components/Chart.server.vue": "<template><div /></template>\n",
      "app/components/Chart.client.vue": "<template><div /></template>\n",
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });

    expect(off).toEqual([]);
    expect(noIslands).toEqual([]);
  });

  test("stays quiet when the dependent also opts out, or either side is client-only", async () => {
    const both = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": plugin(
        "  name: 'api',\n  dependsOn: ['auth'],\n  env: { islands: false },",
      ),
    });
    const clientDependency = await run({
      ...island,
      "app/plugins/auth.client.ts": auth,
      "app/plugins/api.ts": api,
    });
    const clientDependent = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/api.client.ts": api,
    });

    expect(both).toEqual([]);
    expect(clientDependency).toEqual([]);
    expect(clientDependent).toEqual([]);
  });

  test("stays quiet when names or config cannot be resolved", async () => {
    const duplicate = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/auth-fallback.ts": plugin("  name: 'auth',"),
      "app/plugins/api.ts": api,
    });
    const computedName = await run({
      ...island,
      "app/plugins/auth.ts": auth,
      "app/plugins/other.ts": plugin("  name: pluginName,"),
      "app/plugins/api.ts": api,
    });
    const computedEnv = await run({
      ...island,
      "app/plugins/auth.ts": plugin("  name: 'auth',\n  env: { islands: !import.meta.dev },"),
      "app/plugins/api.ts": api,
    });
    const spreadConfig = await run({
      ...island,
      "nuxt.config.ts": "export default defineNuxtConfig({ ...base })\n",
      "app/plugins/auth.ts": auth,
      "app/plugins/api.ts": api,
    });
    const unknownDependency = await run({
      ...island,
      "app/plugins/api.ts": plugin("  name: 'api',\n  dependsOn: ['nuxt-auth'],"),
    });

    expect(duplicate).toEqual([]);
    expect(computedName).toEqual([]);
    expect(computedEnv).toEqual([]);
    expect(spreadConfig).toEqual([]);
    expect(unknownDependency).toEqual([]);
  });
});
