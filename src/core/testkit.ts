import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import {
  defineDoctorExtension,
  defineRulePack,
  detectProject,
  runDoctor,
  type DoctorConfig,
  type DoctorExtensionInput,
  type DoctorRule,
  type DoctorRunOptions,
  type DoctorRunResult,
  type ProjectInfo,
  type RuntimeTarget,
} from "./index.js";

type FixtureFramework = "vue" | "nuxt" | "vite" | "nitro";

export interface RuleFixtureOptions {
  rule: DoctorRule;
  /** Project files keyed by root-relative path. `package.json` is generated from `framework` and `dependencies`. */
  files: Record<string, string>;
  /** Defaults to `"vue"`. */
  framework?: FixtureFramework;
  dependencies?: Record<string, string>;
}

export interface ProjectFixtureOptions {
  files: Record<string, string>;
  framework?: FixtureFramework;
  dependencies?: Record<string, string>;
  /** Rules registered in an always-active `fixture` Rule Pack. */
  rules?: DoctorRule[];
  /** Doctor Extensions registered for the run, such as a library's published extension. */
  extensions?: DoctorExtensionInput[];
  config?: DoctorConfig;
  run?: Omit<DoctorRunOptions, "root" | "framework" | "extensions" | "project">;
}

export interface CreateProjectFixtureOptions {
  /** Files present in every run. Project Inventory is detected from them once. */
  files?: Record<string, string>;
  /** Defaults to `"vue"`. */
  framework?: FixtureFramework;
  dependencies?: Record<string, string>;
  runtimeTarget?: RuntimeTarget;
}

export interface ProjectFixtureRunOptions {
  rule?: DoctorRule;
  /** Rules registered in an always-active `fixture` Rule Pack, together with `rule`. */
  rules?: DoctorRule[];
  /** Files added for this run only. Doctor analyzes them with the shared Project Inventory. */
  files?: Record<string, string>;
  extensions?: DoctorExtensionInput[];
  config?: DoctorConfig;
  run?: Omit<DoctorRunOptions, "root" | "framework" | "extensions" | "project" | "runtimeTarget">;
}

/** A fixture project on disk whose Project Inventory is detected once and shared by every run. */
export interface ProjectFixture {
  run(options: ProjectFixtureRunOptions): Promise<DoctorRunResult>;
  /** Deletes the fixture project, for example in `afterAll`. */
  dispose(): Promise<void>;
}

export async function runRuleFixture(options: RuleFixtureOptions): Promise<DoctorRunResult> {
  return runProjectFixture({
    files: options.files,
    framework: options.framework,
    dependencies: options.dependencies,
    rules: [options.rule],
  });
}

export async function runNuxtManifestRuleFixture(
  rule: DoctorRule,
  files: Record<string, string>,
): Promise<DoctorRunResult> {
  return runRuleFixture({ rule, framework: "nuxt", files });
}

export async function runProjectFixture(options: ProjectFixtureOptions): Promise<DoctorRunResult> {
  const root = await createFixtureRoot(options);
  try {
    writeFixtureFiles(root, options.files, options.config);
    return await runFixtureDoctor(root, options, {
      framework: options.framework ?? "vue",
      runtimeTarget: options.run?.runtimeTarget ?? fixtureRuntimeTarget(options),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function createProjectFixture(options: CreateProjectFixtureOptions = {}): ProjectFixture {
  let setup: Promise<{ root: string; project: ProjectInfo }> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const prepare = () =>
    (setup ??= (async () => {
      let root: string | undefined;
      try {
        root = await createFixtureRoot(options);
        writeFixtureFiles(root, options.files ?? {});
        const project = await detectProject(
          root,
          options.framework ?? "vue",
          options.runtimeTarget ?? fixtureRuntimeTarget(options),
        );
        return { root, project };
      } catch (error) {
        if (root) await rm(root, { recursive: true, force: true });
        throw error;
      }
    })());
  return {
    run(runOptions) {
      const result = queue.then(async () => {
        const { root, project } = await prepare();
        const before = new Set(readdirSync(root));
        for (const file of [
          ...Object.keys(runOptions.files ?? {}),
          ...(runOptions.config ? ["doctor.config.ts"] : []),
        ]) {
          if (existsSync(join(root, file))) {
            throw new Error(`Run file ${file} replaces a project fixture file.`);
          }
        }
        let created: string[] = [];
        try {
          created = writeFixtureFiles(root, runOptions.files ?? {}, runOptions.config);
          return await runFixtureDoctor(
            root,
            {
              ...runOptions,
              rules: [...(runOptions.rule ? [runOptions.rule] : []), ...(runOptions.rules ?? [])],
            },
            { project },
          );
        } finally {
          for (const path of created.reverse()) rmSync(path, { recursive: true, force: true });
          for (const entry of readdirSync(root)) {
            if (!before.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
          }
        }
      });
      queue = result.catch(() => {});
      return result;
    },
    async dispose() {
      await queue;
      const prepared = await setup?.catch(() => undefined);
      setup = undefined;
      if (!prepared) return;
      await rm(prepared.root, { recursive: true, force: true });
    },
  };
}

async function createFixtureRoot(
  options: Pick<ProjectFixtureOptions, "framework" | "dependencies">,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vite-doctor-fixture-"));
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
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Returns the paths it created, outermost first, so a run can remove exactly its own files. */
function writeFixtureFiles(
  root: string,
  files: Record<string, string>,
  config?: DoctorConfig,
): string[] {
  const created: string[] = [];
  const entries = Object.entries(files);
  if (config) {
    entries.push(["doctor.config.ts", `export default ${JSON.stringify(config, null, 2)}\n`]);
  }
  for (const [file, text] of entries) {
    const path = join(root, file);
    const directory = mkdirSync(dirname(path), { recursive: true });
    if (directory) created.push(directory);
    writeFileSync(path, text);
    created.push(path);
  }
  return created;
}

function runFixtureDoctor(
  root: string,
  options: Pick<ProjectFixtureOptions, "rules" | "extensions" | "config" | "run">,
  detection: Pick<DoctorRunOptions, "framework" | "runtimeTarget" | "project">,
): Promise<DoctorRunResult> {
  return runDoctor({
    ...options.run,
    ...detection,
    cache: options.run?.cache ?? false,
    config: options.config ?? options.run?.config,
    root,
    extensions: [
      ...(options.rules?.length
        ? [
            defineDoctorExtension({
              name: "fixture",
              rulePacks: [
                defineRulePack({
                  name: "fixture",
                  version: "0.0.0",
                  rules: options.rules,
                  presets: { recommended: options.rules.map((rule) => rule.meta.id) },
                }),
              ],
            }),
          ]
        : []),
      ...(options.extensions ?? []),
    ],
  });
}

function fixtureRuntimeTarget(options: Pick<ProjectFixtureOptions, "framework" | "dependencies">) {
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
