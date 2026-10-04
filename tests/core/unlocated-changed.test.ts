import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, runDoctor, type DoctorRule } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";
import { requireStandardAuthHandlerMount } from "../../src/rule-packs/nuxt/rules/nuxt-better-auth.ts";

function extension(rule: DoctorRule) {
  return defineDoctorExtension({
    name: "test/unlocated",
    rulePacks: [
      defineRulePack({
        name: "test/unlocated",
        version: "0.0.0",
        rules: [rule],
        presets: { recommended: [rule.meta.id] },
      }),
    ],
  });
}

async function withProject(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "doctor-unlocated-changed-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { nuxt: "^4.0.0" } }),
    );
    writeFileSync(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n");
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app/other.ts"), "export const value = true;\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Doctor",
      "-c",
      "user.email=doctor@example.test",
      "commit",
      "-m",
      "fixture",
    );
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const runtimeTarget = {
  nuxt: "4.0.0",
  vue: "3.5.18",
  nitro: "2.11.0",
  h3: "1.15.0",
  nuxtCompatibility: 4,
};

test.each(["changed", "since"])(
  "%s preserves a range-less manifest finding on a changed file",
  async (mode) => {
    await withProject(async (root) => {
      const options = {
        root,
        framework: "nuxt" as const,
        runtimeTarget,
        cache: false,
        extensions: [extension(requireStandardAuthHandlerMount)],
      };
      const initial = await runDoctor(options);
      expect(initial.diagnostics.map((item) => item.code)).toEqual(["NUXT0003"]);
      expect(initial.diagnostics[0]?.range).toBeUndefined();
      writeFileSync(
        join(root, "nuxt.config.ts"),
        "export default defineNuxtConfig({ devtools: { enabled: true } })\n",
      );

      const result = await runDoctor({
        ...options,
        ...(mode === "changed" ? { changed: true } : { since: "HEAD" }),
      });

      expect(result.diagnostics.map((item) => item.code)).toEqual(["NUXT0003"]);
      expect(result.diagnostics[0]?.file).toBe(join(root, "nuxt.config.ts"));
      expect(result.diagnostics[0]?.range).toBeUndefined();
    });
  },
);

test.each([false, true])(
  "range-less findings respect the owning file's changed eligibility: %s",
  async (ownerChanged) => {
    await withProject(async (root) => {
      const rule = createRule({
        meta: {
          id: "test/project-config",
          title: "Review project configuration",
          category: "configuration",
          severity: "warn",
          execution: "manifest",
        },
        create(ctx) {
          return {
            onProjectStart() {
              ctx.report(
                allDiagnostics.DOC9999({
                  why: "Configuration needs review.",
                  fix: "Review project configuration.",
                }),
                {
                  ruleId: "test/project-config",
                  severity: "warn",
                  category: "configuration",
                  file: join(ctx.project.root, "nuxt.config.ts"),
                },
              );
            },
          };
        },
      });
      writeFileSync(
        join(root, ownerChanged ? "nuxt.config.ts" : "app/other.ts"),
        "export default {};\n",
      );
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget,
        cache: false,
        changed: true,
        extensions: [extension(rule)],
      });
      expect(result.diagnostics.map((item) => item.code)).toEqual(ownerChanged ? ["DOC9999"] : []);
    });
  },
);
