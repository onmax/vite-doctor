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
  "%s reports a range-less manifest finding when the file it is anchored to changed",
  async (mode) => {
    await withProject(async (root) => {
      const options = {
        root,
        framework: "nuxt" as const,
        runtimeTarget,
        cache: false,
        extensions: [extension(requireStandardAuthHandlerMount)],
      };
      const changed = {
        ...options,
        ...(mode === "changed" ? { changed: true } : { since: "HEAD" }),
      };
      const initial = await runDoctor(options);
      expect(initial.diagnostics.map((item) => item.code)).toEqual(["NUXT0003"]);
      expect(initial.diagnostics[0]?.range).toBeUndefined();
      // Manifest Rules anchor project findings to the first source file, as in a full run.
      const anchor = initial.diagnostics[0]!.file;
      expect(anchor).toBe(join(root, "app/other.ts"));
      writeFileSync(
        join(root, "nuxt.config.ts"),
        "export default defineNuxtConfig({ devtools: { enabled: true } })\n",
      );
      expect((await runDoctor(changed)).diagnostics).toEqual([]);

      writeFileSync(anchor, "export const value = false;\n");
      const result = await runDoctor(changed);

      expect(result.diagnostics.map((item) => item.code)).toEqual(["NUXT0003"]);
      expect(result.diagnostics[0]?.file).toBe(anchor);
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

test("a range-less related file cannot bypass a non-overlapping primary range", async () => {
  await withProject(async (root) => {
    const rule = createRule({
      meta: {
        id: "test/mixed-locations",
        title: "Review mixed locations",
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
                ruleId: "test/mixed-locations",
                severity: "warn",
                category: "configuration",
                file: join(ctx.project.root, "app/other.ts"),
                range: { start: 0, end: 1, line: 2, column: 1 },
                related: [
                  {
                    file: join(ctx.project.root, "nuxt.config.ts"),
                    message: "Related configuration file.",
                  },
                ],
              },
            );
          },
        };
      },
    });
    writeFileSync(
      join(root, "nuxt.config.ts"),
      "export default defineNuxtConfig({ devtools: { enabled: true } })\n",
    );
    const result = await runDoctor({
      root,
      framework: "nuxt",
      runtimeTarget,
      cache: false,
      changed: true,
      extensions: [extension(rule)],
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual([]);
  });
});
