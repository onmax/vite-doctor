import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../../src/core/testkit.ts";
import nuxtDoctorModule from "../../../src/rule-packs/nuxt/module.ts";
import { noGlobalMiddlewareRedirectLoop } from "../../../src/rule-packs/nuxt/rules/nuxt/no-global-middleware-redirect-loop.ts";

const GLOBAL_FILE = "app/middleware/auth.global.ts";

function manifest(
  middleware: Array<{ name: string; path: string; global: boolean }>,
  generatedAt = "2100-01-01T00:00:00.000Z",
) {
  return JSON.stringify({ generatedAt, appDir: "app", middleware });
}

function middleware(body: string) {
  return `export default defineNuxtRouteMiddleware(${body})\n`;
}

async function run(
  source: string,
  options: { file?: string; global?: boolean; manifest?: string | null; config?: boolean } = {},
) {
  const file = options.file ?? GLOBAL_FILE;
  const files: Record<string, string> = { [file]: source };
  // Nuxt config edited after the manifest was generated makes the manifest stale.
  if (options.config) files["nuxt.config.ts"] = "export default defineNuxtConfig({})\n";
  if (options.manifest !== null)
    files[".nuxt/doctor.manifest.json"] =
      options.manifest ?? manifest([{ name: "auth", path: file, global: options.global ?? true }]);
  return runRuleFixture({ framework: "nuxt", rule: noGlobalMiddlewareRedirectLoop, files });
}

test("reports a global middleware that always redirects", async () => {
  const result = await run(middleware(`() => {\n  return navigateTo('/login')\n}`));

  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic?.code).toBe("NUXT0107");
  expect(diagnostic?.severity).toBe("error");
  expect(diagnostic?.confidence).toBe("manifest-backed");
  expect(diagnostic?.why).toContain("'/login'");
  expect(diagnostic?.suggestion).toContain("to.path");
  expect(diagnostic?.range?.line).toBe(2);
  expect(diagnostic?.evidence?.map((item) => item.kind)).toEqual(["manifest", "ast"]);
});

test.each([
  ["an arrow that returns navigateTo", "() => navigateTo('/login')"],
  [
    "a condition that never reads the destination",
    "() => { if (true) return navigateTo('/login') }",
  ],
  [
    "an early return that never reads the destination",
    "() => {\n  if (import.meta.server) return\n  return navigateTo('/login')\n}",
  ],
  ["a route location object", "() => navigateTo({ path: '/login' })"],
  ["a replace redirect", "() => navigateTo('/login', { replace: true })"],
  ["an else branch", "() => { if (false) { return } else { return navigateTo('/login') } }"],
  ["a function expression", "async function () {\n  return await navigateTo('/login')\n}"],
])("reports %s", async (_name, body) => {
  const result = await run(middleware(body));

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0107"]);
});

test("reports middleware that a module registers as global outside the middleware directory", async () => {
  const file = "modules/auth/runtime/redirect.ts";
  const result = await run(middleware("() => navigateTo('/login')"), { file });

  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["NUXT0107"]);
});

test.each([
  [
    "a guard on the destination path",
    "(to) => {\n  if (to.path !== '/login') return navigateTo('/login')\n}",
  ],
  [
    "a guard on route meta",
    "(to) => {\n  const user = useState('user')\n  if (to.meta.auth && !user.value) return navigateTo('/login')\n}",
  ],
  [
    "a guard derived from the destination",
    "(to) => {\n  const isLogin = to.path === '/login'\n  if (!isLogin) return navigateTo('/login')\n}",
  ],
  [
    "an early return on the destination",
    "(to) => {\n  if (to.path === '/login') return\n  return navigateTo('/login')\n}",
  ],
  [
    "a destructured destination",
    "({ path }) => {\n  if (path !== '/login') return navigateTo('/login')\n}",
  ],
  [
    "a guard that reads the current route",
    "() => {\n  if (useRoute().path !== '/login') return navigateTo('/login')\n}",
  ],
  [
    "a redirect that runs once",
    "() => {\n  const seen = useState('seen')\n  if (!seen.value) {\n    seen.value = true\n    return navigateTo('/welcome')\n  }\n}",
  ],
  ["a dynamic target", "() => navigateTo(loginPath)"],
  ["a template literal target", "() => navigateTo(`/login/${locale}`)"],
  ["a named route target", "() => navigateTo({ name: 'login' })"],
  ["an external redirect", "() => navigateTo('https://auth.example.com', { external: true })"],
  ["abortNavigation", "() => abortNavigation()"],
  ["a redirect inside a callback", "() => {\n  onNuxtReady(() => navigateTo('/login'))\n}"],
  [
    "a redirect inside a loop",
    "() => {\n  for (const item of items) return navigateTo('/login')\n}",
  ],
  ["a redirect inside try", "() => {\n  try {\n    return navigateTo('/login')\n  } catch {}\n}"],
  [
    "a condition that calls a helper",
    "() => {\n  if (shouldRedirect()) return navigateTo('/login')\n}",
  ],
])("does not report %s", async (_name, body) => {
  const result = await run(middleware(body));

  expect(result.diagnostics).toEqual([]);
});

test.each([
  ["an unreachable redirect", "() => { if (false) return navigateTo('/login') }"],
  [
    "a redirect after an unconditional exit",
    "() => { if (true) return; return navigateTo('/login') }",
  ],
  ["a shared guard flag", "() => { if (!useState('isLogin').value) return navigateTo('/login') }"],
  ["a mutable module flag", "() => { if (someFlag.value) return navigateTo('/login') }"],
  ["a side effect in options", "() => navigateTo('/login', { replace: (seen.value = true) })"],
  [
    "a side effect in the location",
    "() => navigateTo({ path: '/login', query: { seen: (seen.value = true) } })",
  ],
])("does not report %s", async (_name, body) => {
  expect((await run(middleware(body))).diagnostics).toEqual([]);
});

test("suggests comparing to.path with only the pathname", async () => {
  const result = await run(middleware(`(to) => navigateTo('/login?next=/#welcome')`));

  expect(result.diagnostics[0]?.suggestion).toContain(`to.path === "/login"`);
});

test("does not report a local navigateTo", async () => {
  const result = await run(
    `import { navigateTo } from './navigation'\n${middleware("() => navigateTo('/login')")}`,
  );

  expect(result.diagnostics).toEqual([]);
});

test("does not report named middleware", async () => {
  const result = await run(middleware("() => navigateTo('/login')"), {
    file: "app/middleware/auth.ts",
    global: false,
  });

  expect(result.diagnostics).toEqual([]);
});

test("a .global file without resolved middleware data is an evidence gap", async () => {
  const missing = await run(middleware("() => navigateTo('/login')"), { manifest: null });
  const stale = await run(middleware("() => navigateTo('/login')"), {
    manifest: manifest(
      [{ name: "auth", path: GLOBAL_FILE, global: true }],
      "2000-01-01T00:00:00.000Z",
    ),
    config: true,
  });
  const older = await run(middleware("() => navigateTo('/login')"), {
    manifest: JSON.stringify({ generatedAt: "2100-01-01T00:00:00.000Z", appDir: "app" }),
  });

  for (const result of [missing, stale, older]) {
    expect(result.diagnostics).toEqual([]);
    expect(result.project.evidenceGaps).toContainEqual(
      expect.objectContaining({
        source: "vite-doctor/nuxt-global-middleware",
        files: [".nuxt/doctor.manifest.json"],
      }),
    );
  }
});

test("the Nuxt manifest records the middleware Nuxt resolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-nuxt-middleware-manifest-"));
  try {
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    const hooks = new Map<string, Array<(...payload: any[]) => unknown>>();
    const nuxt = {
      _version: "4.5.2",
      options: { rootDir: root, srcDir: join(root, "app"), buildDir: ".nuxt", modules: [] },
      hook(name: string, callback: (...payload: any[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), callback]);
      },
      async callHook(name: string, ...payload: unknown[]) {
        for (const hook of hooks.get(name) ?? []) await hook(...payload);
      },
    };
    await nuxtDoctorModule({}, nuxt as any);
    await nuxt.callHook("app:templates", {
      middleware: [
        { name: "auth", path: join(root, "app/middleware/auth.global.ts"), global: true },
        { name: "admin", path: join(root, "app/middleware/admin.ts") },
      ],
    });
    await nuxt.callHook("close", nuxt);

    const written = JSON.parse(readFileSync(join(root, ".nuxt/doctor.manifest.json"), "utf8"));
    expect(written.middleware).toEqual([
      { name: "auth", path: join(root, "app/middleware/auth.global.ts"), global: true },
      { name: "admin", path: join(root, "app/middleware/admin.ts"), global: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
