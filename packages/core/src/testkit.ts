import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import {
  defineDoctorExtension,
  defineRulePack,
  runDoctor,
  type DoctorConfig,
  type DoctorRule,
  type DoctorRunOptions,
  type DoctorRunResult,
} from "./index.js";

export interface RuleFixtureOptions {
  rule: DoctorRule;
  files: Record<string, string>;
  framework?: "vue" | "nuxt" | "vite" | "nitro";
  dependencies?: Record<string, string>;
}

export interface ProjectFixtureOptions {
  files: Record<string, string>;
  framework?: "vue" | "nuxt" | "vite" | "nitro";
  dependencies?: Record<string, string>;
  rules?: DoctorRule[];
  config?: DoctorConfig;
  run?: Omit<DoctorRunOptions, "root" | "framework" | "extensions">;
}

export async function runRuleFixture(options: RuleFixtureOptions): Promise<DoctorRunResult> {
  return runProjectFixture({
    files: options.files,
    framework: options.framework,
    dependencies: options.dependencies,
    rules: [options.rule],
  });
}

export async function runVueSfcRuleFixture(
  rule: DoctorRule,
  source: string,
): Promise<DoctorRunResult> {
  return runRuleFixture({ rule, framework: "vue", files: { "app.vue": source } });
}

export async function runNuxtAppRuleFixture(
  rule: DoctorRule,
  source: string,
  file = "app/pages/index.vue",
): Promise<DoctorRunResult> {
  return runRuleFixture({ rule, framework: "nuxt", files: { [file]: source } });
}

export async function runNuxtManifestRuleFixture(
  rule: DoctorRule,
  files: Record<string, string>,
): Promise<DoctorRunResult> {
  return runRuleFixture({ rule, framework: "nuxt", files });
}

export async function runProjectFixture(options: ProjectFixtureOptions): Promise<DoctorRunResult> {
  const root = await mkdtemp(join(tmpdir(), "vue-doctor-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies:
          options.framework === "nuxt"
            ? { vue: "^3.5.0", nuxt: "^4.0.0", ...options.dependencies }
            : options.framework === "vite"
              ? { vite: "^8.0.0", ...options.dependencies }
              : options.framework === "nitro"
                ? { nitropack: "^2.0.0", ...options.dependencies }
                : { vue: "^3.5.0", ...options.dependencies },
      }),
    );
    for (const [file, text] of Object.entries(options.files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    if (options.config)
      writeFileSync(
        join(root, "doctor.config.ts"),
        `export default ${JSON.stringify(options.config, null, 2)}\n`,
      );
    return await runDoctor({
      ...options.run,
      config: options.config ?? options.run?.config,
      root,
      framework: options.framework ?? "vue",
      extensions: [
        defineDoctorExtension({
          name: "fixture",
          rulePacks: [
            defineRulePack({
              name: "fixture",
              version: "0.0.0",
              rules: options.rules ?? [],
              presets: { recommended: (options.rules ?? []).map((rule) => rule.meta.id) },
            }),
          ],
        }),
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
