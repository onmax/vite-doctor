import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noFragmentInVirtualId } from "../../src/rules.ts";

function run(files: Record<string, string>) {
  return runProjectFixture({ framework: "vite", rules: [noFragmentInVirtualId], files });
}

// vitehub 0cc4498bd3^ packages/auth/src/vite.ts, trimmed.
const authPlugin = `import type { Plugin } from "vite"

export const AUTH_ABILITIES_ID = "#vitehub/auth/abilities"
export const AUTH_CLIENT_ID = "#vitehub/auth/client"
export const AUTH_SERVER_ID = "#vitehub/auth/server"

const RESOLVED_AUTH_ABILITIES_ID = \`\\0\${AUTH_ABILITIES_ID}\`
const RESOLVED_AUTH_CLIENT_ID = \`\\0\${AUTH_CLIENT_ID}\`
const RESOLVED_AUTH_SERVER_ID = \`\\0\${AUTH_SERVER_ID}\`

export function hubAuth(clientFile?: string): Plugin {
  return {
    name: "@vite-hub/auth/vite",
    resolveId: {
      filter: { id: /^#vitehub\\/auth\\/(?:abilities|client|server)$/ },
      handler(id) {
        if (id === AUTH_ABILITIES_ID) return RESOLVED_AUTH_ABILITIES_ID
        if (id === AUTH_CLIENT_ID) return clientFile ?? RESOLVED_AUTH_CLIENT_ID
        if (id === AUTH_SERVER_ID) return RESOLVED_AUTH_SERVER_ID
      },
    },
    load: {
      filter: { id: /^\\0#vitehub\\/auth\\/(?:abilities|client|server)$/ },
      handler(id) {
        if (id === RESOLVED_AUTH_ABILITIES_ID) return "export default {}"
        if (id === RESOLVED_AUTH_CLIENT_ID) return "export default undefined"
        if (id === RESOLVED_AUTH_SERVER_ID) return "export const server = true"
      },
    },
  }
}
`;

const authVue = `import abilities from "#vitehub/auth/abilities"
import { computed } from "vue"

export function useAuth() {
  return computed(() => abilities)
}

export async function loadClient() {
  const { default: options } = await import("#vitehub/auth/client")
  return options
}
`;

const authServer = `import abilities from "#vitehub/auth/abilities"
import { server } from "#vitehub/auth/server"

export function check() {
  return [abilities, server]
}
`;

describe("vite/plugin/no-fragment-in-virtual-id", () => {
  test("reports browser-loaded \\0# ids and leaves the server-only one (vitehub 0cc4498bd3^ auth)", async () => {
    const result = await run({
      "src/vite.ts": authPlugin,
      "src/vue.ts": authVue,
      "src/internal/server.ts": authServer,
    });
    expect(
      result.diagnostics.map(({ code, ruleId, severity, range }) => ({
        code,
        ruleId,
        severity,
        line: range?.line,
      })),
    ).toEqual([
      {
        code: "VITE0028",
        ruleId: "vite/plugin/no-fragment-in-virtual-id",
        severity: "error",
        line: 7,
      },
      {
        code: "VITE0028",
        ruleId: "vite/plugin/no-fragment-in-virtual-id",
        severity: "error",
        line: 8,
      },
    ]);
    const [abilities, client] = result.diagnostics;
    expect(abilities?.message).toContain("#vitehub/auth/abilities");
    expect(abilities?.message).toContain("/@id/__x00__#vitehub/auth/abilities");
    expect(abilities?.message).toContain("src/vue.ts");
    expect(client?.message).toContain("#vitehub/auth/client");
    expect(result.diagnostics.map((item) => item.message).join("\n")).not.toContain(
      "#vitehub/auth/server",
    );
  });

  test("reports an id imported from a module that an HTML entry loads, through a constant from another workspace package (vitehub 6138d0a80b^ env)", async () => {
    const result = await run({
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - packages/env/examples/*\n",
      "packages/internal/package.json": JSON.stringify({
        name: "@vite-hub/internal",
        exports: { "./build/vite": { import: "./dist/build/vite.js" } },
      }),
      "packages/internal/src/build/vite.ts": `export const VITEHUB_ENV_PUBLIC_ID = "#vitehub/env/public" as const
export const VITEHUB_ENV_SERVER_ID = "#vitehub/env/server" as const
`,
      "packages/env/package.json": JSON.stringify({
        name: "@vite-hub/env",
        dependencies: { "@vite-hub/internal": "workspace:*", vite: "^8.0.0" },
      }),
      "packages/env/src/vite.ts": `import type { Plugin } from "vite"
import { VITEHUB_ENV_PUBLIC_ID, VITEHUB_ENV_SERVER_ID } from "@vite-hub/internal/build/vite"

export const ENV_PUBLIC_ID: typeof VITEHUB_ENV_PUBLIC_ID = VITEHUB_ENV_PUBLIC_ID
export const ENV_SERVER_ID: typeof VITEHUB_ENV_SERVER_ID = VITEHUB_ENV_SERVER_ID
const RESOLVED_PUBLIC_ID = \`\\0\${ENV_PUBLIC_ID}\`
const RESOLVED_SERVER_ID = \`\\0\${ENV_SERVER_ID}\`

export function hubEnv(): Plugin {
  return {
    name: "@vite-hub/env/vite",
    resolveId: {
      filter: { id: /^#vitehub\\/env\\/(?:public|server)$/ },
      handler(id) {
        if (id === ENV_PUBLIC_ID) {
          return RESOLVED_PUBLIC_ID
        }
        if (id === ENV_SERVER_ID) {
          return RESOLVED_SERVER_ID
        }
      },
    },
  }
}
`,
      "packages/env/examples/schema-lab/package.json": JSON.stringify({
        name: "schema-lab",
        dependencies: { "@vite-hub/env": "workspace:*", vite: "^8.0.0" },
      }),
      "packages/env/examples/schema-lab/index.html":
        '<!doctype html>\n<html><body><pre id="public-config"></pre>\n<script type="module" src="/src/client.ts"></script>\n</body></html>\n',
      "packages/env/examples/schema-lab/src/client.ts": `import { render } from "./render"
render()
`,
      "packages/env/examples/schema-lab/src/render.ts": `import { usePublicEnv } from "#vitehub/env/public"

export function render() {
  const output = document.querySelector("#public-config")
  if (output) output.textContent = JSON.stringify(usePublicEnv())
}
`,
      "packages/env/examples/schema-lab/src/server.ts": `import { useServerEnv } from "#vitehub/env/server"
export default () => useServerEnv()
`,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "VITE0028",
      file: expect.stringMatching(/packages\/env\/src\/vite\.ts$/),
      range: { line: 6 },
    });
    expect(result.diagnostics[0]?.message).toContain(
      "packages/env/examples/schema-lab/src/render.ts",
    );
  });

  test("reports an id built from the resolveId argument and imported by a Vue SFC", async () => {
    const result = await run({
      "src/plugin.ts": `import type { Plugin } from "vite"
const PREFIX = "virtual:icons#"
export default function icons(): Plugin {
  return {
    name: "icons",
    resolveId(id) {
      if (!id.startsWith(PREFIX)) return
      return "\\0" + id
    },
    load(id) {
      if (id.startsWith("\\0" + PREFIX)) return "export default ''"
    },
  }
}
`,
      "src/App.vue": `<script setup lang="ts">
import arrow from "virtual:icons#arrow"
</script>
<template><img :src="arrow"></template>
`,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: "VITE0028", range: { line: 8 } });
    expect(result.diagnostics[0]?.message).toContain("/@id/__x00__virtual:icons#arrow");
  });

  test("reports an id imported by an inline HTML module script", async () => {
    const result = await run({
      "vite.config.ts": `import { defineConfig } from "vite"
export default defineConfig({
  plugins: [{
    name: "config",
    resolveId(id) {
      if (id === "#app/config") return { id: "\\0#app/config" }
    },
    load(id) {
      if (id === "\\0#app/config") return "export default {}"
    },
  }],
})
`,
      "index.html": `<script type="module">
import config from "#app/config"
console.log(config)
</script>
`,
    });
    expect(result.diagnostics.map(({ code, range }) => [code, range?.line])).toEqual([
      ["VITE0028", 6],
    ]);
  });

  test.each([
    [
      "a guard that returns early for other specifiers",
      `if (id !== "#app/config") return
      return "\\0#app/config"`,
    ],
    [
      "a branch with a condition unrelated to the environment",
      `if (id === "#app/config" && !options?.isEntry) return "\\0#app/config"`,
    ],
    [
      "a switch on the specifier",
      `switch (id) {
        case "#app/other": return "\\0virtual:other"
        case "#app/config": return "\\0#app/config"
      }`,
    ],
  ])("reports %s", async (_name, body) => {
    const result = await run({
      "src/vite.ts": `import type { Plugin } from "vite"
export default function plugin(): Plugin {
  return {
    name: "plugin",
    resolveId(id, importer, options) {
      ${body}
    },
  }
}
`,
      "src/App.vue": `<script setup lang="ts">\nimport config from "#app/config"\n</script>\n`,
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["VITE0028"]);
  });

  test.each([
    [
      "an id without #",
      `if (id === "#vitehub/auth/client") return "\\0virtual:vitehub/auth/client"`,
      `import "#vitehub/auth/client"\nimport { ref } from "vue"\nexport const state = ref()`,
    ],
    [
      "an id resolved only for server environments",
      `if (id === "#vitehub/auth/client" && this.environment.config.consumer === "server") return "\\0#vitehub/auth/client"`,
      `import "#vitehub/auth/client"\nimport { ref } from "vue"\nexport const state = ref()`,
    ],
    [
      "an id resolved only for SSR",
      `if (options?.ssr) {\n        if (id === "#vitehub/auth/client") return "\\0#vitehub/auth/client"\n      }`,
      `import "#vitehub/auth/client"\nimport { ref } from "vue"\nexport const state = ref()`,
    ],
    [
      "a type-only import",
      `if (id === "#vitehub/auth/client") return "\\0#vitehub/auth/client"`,
      `import type { Client } from "#vitehub/auth/client"\nimport { ref } from "vue"\nexport const state = ref<Client>()`,
    ],
    [
      "an id imported only by server code",
      `if (id === "#vitehub/auth/client") return "\\0#vitehub/auth/client"`,
      `import client from "#vitehub/auth/client"\nexport default client`,
    ],
    [
      "a different specifier",
      `if (id === "#vitehub/auth/other") return "\\0#vitehub/auth/other"`,
      `import "#vitehub/auth/client"\nimport { ref } from "vue"\nexport const state = ref()`,
    ],
  ])("does not report %s", async (_name, body, importer) => {
    const result = await run({
      "src/vite.ts": `import type { Plugin } from "vite"
export default function plugin(): Plugin {
  return {
    name: "plugin",
    resolveId(id, importer, options) {
      ${body}
    },
  }
}
`,
      "src/use-client.ts": importer,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("does not report a build-only plugin", async () => {
    const result = await run({
      "src/vite.ts": `import type { Plugin } from "vite"
export default function plugin(): Plugin {
  return {
    name: "plugin",
    apply: "build",
    resolveId(id) {
      if (id === "#app/config") return "\\0#app/config"
    },
  }
}
`,
      "src/App.vue": `<script setup lang="ts">\nimport config from "#app/config"\n</script>\n`,
    });
    expect(result.diagnostics).toEqual([]);
  });
});
