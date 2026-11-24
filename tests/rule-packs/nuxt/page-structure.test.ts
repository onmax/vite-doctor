import { describe, expect, test } from "vite-plus/test";
import type { DoctorRule } from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import nuxtRulePack from "../../../src/rule-packs/nuxt/rules/nuxt/index.ts";

const rule = (id: string) => nuxtRulePack.rules.find((candidate) => candidate.meta.id === id)!;

async function run(ruleId: string, files: Record<string, string>) {
  const result = await runProjectFixture({
    rules: [rule(ruleId) as DoctorRule],
    framework: "nuxt",
    files,
  });
  return result.diagnostics;
}

const template = (body: string, script = "") =>
  `${script ? `<script setup lang="ts">\n${script}\n</script>\n` : ""}<template>${body}</template>\n`;

describe("nuxt/routing/parent-page-requires-nuxtpage", () => {
  const id = "nuxt/routing/parent-page-requires-nuxtpage";

  test("reports a parent page that never renders NuxtPage", async () => {
    const diagnostics = await run(id, {
      "app/app.vue": template("<NuxtPage />"),
      "app/pages/users.vue": template("<div><h1>Users</h1></div>"),
      "app/pages/users/[id].vue": template("<div>User</div>"),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("NUXT0098");
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0]?.file).toMatch(/app\/pages\/users\.vue$/);
    expect(diagnostics[0]?.why).toContain("NUXT_E4016");
    expect(diagnostics[0]?.related?.[0]?.file).toMatch(/users\/\[id\]\.vue$/);
  });

  test("reports when a component the page imports does not render NuxtPage", async () => {
    const diagnostics = await run(id, {
      "app/pages/users.vue": template(
        "<UsersHeader />",
        "import UsersHeader from '../components/UsersHeader.vue'",
      ),
      "app/pages/users/index.vue": template("<div>All users</div>"),
      "app/components/UsersHeader.vue": template("<header>Users</header>"),
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0098"]);
  });

  test("stays quiet when the page renders NuxtPage or RouterView", async () => {
    for (const body of ["<div><NuxtPage /></div>", "<div><nuxt-page /></div>", "<RouterView />"]) {
      const diagnostics = await run(id, {
        "app/pages/users.vue": template(body),
        "app/pages/users/[id].vue": template("<div>User</div>"),
      });
      expect(diagnostics).toEqual([]);
    }
  });

  test("stays quiet when an imported child component renders NuxtPage", async () => {
    const diagnostics = await run(id, {
      "app/pages/users.vue": template(
        "<UsersShell />",
        "import UsersShell from '~/components/UsersShell.vue'",
      ),
      "app/pages/users/[id].vue": template("<div>User</div>"),
      "app/components/UsersShell.vue": template("<div><NuxtPage /></div>"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet when an auto-imported component may render NuxtPage", async () => {
    const diagnostics = await run(id, {
      "app/pages/users.vue": template("<UsersShell />"),
      "app/pages/users/[id].vue": template("<div>User</div>"),
      "app/components/users/Shell.vue": template("<div><NuxtPage /></div>"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet for render functions and dynamic components", async () => {
    const renderFunction = await run(id, {
      "app/pages/users.vue":
        "<script setup lang=\"ts\">\nimport { NuxtPage } from '#components'\nconst render = () => h(NuxtPage)\n</script>\n",
      "app/pages/users/[id].vue": template("<div>User</div>"),
    });
    const dynamic = await run(id, {
      "app/pages/users.vue": template('<component :is="outlet" />', "const outlet = 'NuxtPage'"),
      "app/pages/users/[id].vue": template("<div>User</div>"),
    });

    expect(renderFunction).toEqual([]);
    expect(dynamic).toEqual([]);
  });

  test("stays quiet for pages without a child directory and ignored child files", async () => {
    const diagnostics = await run(id, {
      "app/pages/users.vue": template("<div>Users</div>"),
      "app/pages/users/-helpers.ts": "export const x = 1\n",
      "app/pages/about.vue": template("<div>About</div>"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet when the config changes which files are pages", async () => {
    const diagnostics = await run(id, {
      "nuxt.config.ts": "export default defineNuxtConfig({ ignore: ['pages/users/**'] })\n",
      "app/pages/users.vue": template("<div>Users</div>"),
      "app/pages/users/[id].vue": template("<div>User</div>"),
    });

    expect(diagnostics).toEqual([]);
  });
});

describe("nuxt/layouts/app-renders-nuxtlayout", () => {
  const id = "nuxt/layouts/app-renders-nuxtlayout";

  test("reports an app.vue that ignores the layouts directory", async () => {
    const diagnostics = await run(id, {
      "app/app.vue": template("<div><NuxtPage /></div>"),
      "app/layouts/default.vue": template("<div><slot /></div>"),
      "app/pages/index.vue": template("<div>Home</div>"),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("NUXT0099");
    expect(diagnostics[0]?.file).toMatch(/app\/app\.vue$/);
    expect(diagnostics[0]?.why).toContain("NUXT_E4007");
    expect(diagnostics[0]?.related?.[0]?.file).toMatch(/layouts\/default\.vue$/);
  });

  test("stays quiet when app.vue renders NuxtLayout directly or through a component", async () => {
    const direct = await run(id, {
      "app/app.vue": template("<NuxtLayout><NuxtPage /></NuxtLayout>"),
      "app/layouts/default.vue": template("<div><slot /></div>"),
    });
    const nested = await run(id, {
      "app/app.vue": template("<AppShell />", "import AppShell from './components/AppShell.vue'"),
      "app/components/AppShell.vue": template("<NuxtLayout><NuxtPage /></NuxtLayout>"),
      "app/layouts/default.vue": template("<div><slot /></div>"),
    });

    expect(direct).toEqual([]);
    expect(nested).toEqual([]);
  });

  test("stays quiet without app.vue, without layouts, or when a page renders NuxtLayout", async () => {
    const noApp = await run(id, {
      "app/layouts/default.vue": template("<div><slot /></div>"),
      "app/pages/index.vue": template("<div>Home</div>"),
    });
    const noLayouts = await run(id, {
      "app/app.vue": template("<NuxtPage />"),
    });
    const pageLayout = await run(id, {
      "app/app.vue": template("<NuxtPage />"),
      "app/layouts/custom.vue": template("<div><slot /></div>"),
      "app/pages/index.vue": template('<NuxtLayout name="custom"><div>Home</div></NuxtLayout>'),
    });

    expect(noApp).toEqual([]);
    expect(noLayouts).toEqual([]);
    expect(pageLayout).toEqual([]);
  });

  test("stays quiet when app.vue renders a component Doctor cannot resolve", async () => {
    const diagnostics = await run(id, {
      "app/app.vue": template('<component :is="shell" />', "const shell = 'AppShell'"),
      "app/layouts/default.vue": template("<div><slot /></div>"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet when an auto-imported component may render NuxtLayout", async () => {
    const diagnostics = await run(id, {
      "app/app.vue": template("<AppShell />"),
      "app/components/AppShell.vue": template("<NuxtLayout><NuxtPage /></NuxtLayout>"),
      "app/layouts/default.vue": template("<div><slot /></div>"),
    });

    expect(diagnostics).toEqual([]);
  });
});

describe("nuxt/pages/single-root-node", () => {
  const id = "nuxt/pages/single-root-node";
  const pageTransition =
    "export default defineNuxtConfig({ app: { pageTransition: { name: 'page', mode: 'out-in' } } })\n";

  test("reports a multi-root page when app.pageTransition is on", async () => {
    const diagnostics = await run(id, {
      "nuxt.config.ts": pageTransition,
      "app/pages/index.vue": template("\n  <h1>Home</h1>\n  <p>Welcome</p>\n"),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("NUXT0100");
    expect(diagnostics[0]?.severity).toBe("warn");
    expect(diagnostics[0]?.why).toContain("NUXT_E4004");
    expect(diagnostics[0]?.why).toContain("2 root nodes");
    expect(diagnostics[0]?.range?.line).toBe(3);
  });

  test("reports text and comment roots, and pages that turn the transition on", async () => {
    const text = await run(id, {
      "nuxt.config.ts": pageTransition,
      "app/pages/index.vue": template("Hello"),
    });
    const comment = await run(id, {
      "app/pages/index.vue": template(
        "<!-- hero --><div>Home</div>",
        "definePageMeta({ pageTransition: { name: 'fade' } })",
      ),
    });

    expect(text.map((diagnostic) => diagnostic.why)).toEqual([
      expect.stringContaining("text at its root"),
    ]);
    expect(comment.map((diagnostic) => diagnostic.why)).toEqual([
      expect.stringContaining("a comment at its root"),
    ]);
  });

  test("reports a multi-root layout when app.layoutTransition is on", async () => {
    const diagnostics = await run(id, {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ app: { layoutTransition: { name: 'layout' } } })\n",
      "app/app.vue": template("<NuxtLayout><NuxtPage /></NuxtLayout>"),
      "app/layouts/default.vue": template("<header /><slot />"),
    });

    expect(diagnostics.map((diagnostic) => diagnostic.why)).toEqual([
      expect.stringContaining("NUXT_E4002"),
    ]);
  });

  test("treats a v-if chain as one root", async () => {
    const diagnostics = await run(id, {
      "nuxt.config.ts": pageTransition,
      "app/pages/index.vue": template(
        '<div v-if="a">A</div><!-- b --><div v-else-if="b">B</div><div v-else>C</div>',
        "const a = true; const b = false",
      ),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet without a proven page transition", async () => {
    const off = await run(id, {
      "app/pages/index.vue": template("<h1>Home</h1><p>Welcome</p>"),
    });
    const pageOptOut = await run(id, {
      "nuxt.config.ts": pageTransition,
      "app/pages/index.vue": template(
        "<h1>Home</h1><p>Welcome</p>",
        "definePageMeta({ pageTransition: false })",
      ),
    });
    const outletOff = await run(id, {
      "nuxt.config.ts": pageTransition,
      "app/app.vue": template('<NuxtPage :transition="false" />'),
      "app/pages/index.vue": template("<h1>Home</h1><p>Welcome</p>"),
    });
    const computed = await run(id, {
      "nuxt.config.ts":
        "export default defineNuxtConfig({ app: { pageTransition: process.env.FADE ? { name: 'fade' } : false } })\n",
      "app/pages/index.vue": template("<h1>Home</h1><p>Welcome</p>"),
    });
    const layoutWithoutTransition = await run(id, {
      "nuxt.config.ts": pageTransition,
      "app/layouts/default.vue": template("<header /><slot />"),
    });

    expect(off).toEqual([]);
    expect(pageOptOut).toEqual([]);
    expect(outletOff).toEqual([]);
    expect(computed).toEqual([]);
    expect(layoutWithoutTransition).toEqual([]);
  });

  test("stays quiet for single roots and slot roots", async () => {
    const diagnostics = await run(id, {
      "nuxt.config.ts": pageTransition,
      "app/pages/index.vue": template("\n  <div>\n    <h1>Home</h1>\n  </div>\n"),
      "app/pages/about.vue": template("<slot />"),
    });

    expect(diagnostics).toEqual([]);
  });
});

describe("nuxt/routing/navigate-to-external", () => {
  const id = "nuxt/routing/navigate-to-external";
  const page = (script: string, body = "<div />") => template(body, script);

  test("reports external literals without external: true", async () => {
    const diagnostics = await run(id, {
      "app/pages/a.vue": page("await navigateTo('https://example.com/login')"),
      "app/pages/b.vue": page("await navigateTo('//cdn.example.com/x', { replace: true })"),
      "app/pages/c.vue": page("await navigateTo(`https://${host}/x`)\nconst host = 'a.dev'"),
      "app/middleware/auth.ts":
        "export default defineNuxtRouteMiddleware(() => navigateTo('mailto:help@example.com', { external: false }))\n",
      "app/pages/d.vue": page("", `<button @click="navigateTo('https://example.com')">Go</button>`),
      "app/pages/e.vue": page(
        "import { navigateTo } from '#app'\nawait navigateTo('https://' + host)\nconst host = 'a.dev'",
      ),
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(Array(6).fill("NUXT0101"));
    expect(diagnostics[0]?.why).toContain("NUXT_E2001");
    expect(diagnostics[0]?.suggestion).toContain("{ external: true }");
  });

  test("stays quiet for allowed, relative, or unprovable targets", async () => {
    const diagnostics = await run(id, {
      "app/pages/a.vue": page("await navigateTo('https://example.com', { external: true })"),
      "app/pages/b.vue": page("await navigateTo('/login')"),
      "app/pages/c.vue": page("await navigateTo(url)\nconst url = 'https://example.com'"),
      "app/pages/d.vue": page("await navigateTo(`${base}/x`)\nconst base = 'https://a.dev'"),
      "app/pages/e.vue": page(
        "await navigateTo('https://example.com', { open: { target: '_blank' } })",
      ),
      "app/pages/f.vue": page(
        "await navigateTo('https://example.com', options)\nconst options = {}",
      ),
      "app/pages/g.vue": page(
        "await navigateTo('https://example.com', { ...options })\nconst options = {}",
      ),
      "app/pages/h.vue": page("await navigateTo('javascript:alert(1)')"),
    });

    expect(diagnostics).toEqual([]);
  });

  test("stays quiet for navigateTo bindings that are not Nuxt's", async () => {
    const diagnostics = await run(id, {
      "app/pages/a.vue": page(
        "import { navigateTo } from '~/utils/nav'\nawait navigateTo('https://example.com')",
      ),
      "app/pages/b.vue": page(
        "const navigateTo = (url: string) => location.assign(url)\nnavigateTo('https://example.com')",
      ),
      "app/pages/c.vue": page(
        "function go(navigateTo: (url: string) => void) { navigateTo('https://example.com') }",
      ),
      "app/pages/d.vue": page(
        "import { navigateTo } from '~/utils/nav'",
        `<button @click="navigateTo('https://example.com')">Go</button>`,
      ),
      "server/api/x.ts":
        "export default defineEventHandler(() => navigateTo('https://example.com'))\n",
    });

    expect(diagnostics).toEqual([]);
  });
});
