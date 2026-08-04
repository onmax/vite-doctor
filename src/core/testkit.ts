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
      runtimeTarget: options.run?.runtimeTarget ?? fixtureRuntimeTarget(options),
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

function fixtureRuntimeTarget(options: ProjectFixtureOptions) {
  const framework = options.framework ?? "vue";
  const dependency = (name: string, fallback: string) =>
    exactFixtureVersion(options.dependencies?.[name] ?? fallback);
  if (framework === "nuxt") {
    return {
      nuxt: dependency("nuxt", "4.0.0"),
      nitro: dependency("nitro", dependency("nitropack", "2.0.0")),
      h3: dependency("h3", "1.0.0"),
      vue: dependency("vue", "3.5.0"),
      nuxtCompatibility: 4,
    };
  }
  if (framework === "nitro") {
    return {
      nitro: dependency("nitro", dependency("nitropack", "2.0.0")),
      h3: dependency("h3", "1.0.0"),
    };
  }
  if (framework === "vue") return { vue: dependency("vue", "3.5.0") };
  return undefined;
}

function exactFixtureVersion(version: string): string {
  return version.match(/\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? version;
}
