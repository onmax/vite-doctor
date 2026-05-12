import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "pnpm" | "bun" | "yarn" | "npm";

export interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
}

export interface PlannedCommand {
  packageManager: PackageManager;
  script: string;
  command: string;
  args: string[];
  display: string;
}

export interface CiPlan {
  packageManager: PackageManager;
  commands: PlannedCommand[];
}

export function readPackageJson(root: string): PackageJson {
  const file = join(root, "package.json");
  if (!existsSync(file)) throw new Error(`No package.json found at ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  } catch (error) {
    throw new Error(`Could not read package.json at ${file}: ${(error as Error).message}`);
  }
}

export function detectPackageManager(root: string, packageJson: PackageJson): PackageManager {
  const fromPackageManager = parsePackageManager(packageJson.packageManager);
  if (fromPackageManager) return fromPackageManager;
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json")) || existsSync(join(root, "npm-shrinkwrap.json")))
    return "npm";
  return "npm";
}

export function planCi(root: string): CiPlan {
  const packageJson = readPackageJson(root);
  const packageManager = detectPackageManager(root, packageJson);
  const scripts = packageJson.scripts ?? {};
  const selectedScripts = selectScripts(scripts);
  if (!selectedScripts.length) {
    throw new Error(
      "No project scripts found. Add one of: ci, ready, check, lint, typecheck, type:check, test, build.",
    );
  }
  return {
    packageManager,
    commands: selectedScripts.map((script) => createCommand(packageManager, script)),
  };
}

export function selectScripts(scripts: Record<string, string>): string[] {
  if (scripts.ci && !isSelfReferential(scripts.ci)) return ["ci"];
  if (scripts.ready) return ["ready"];

  const selected: string[] = [];
  if (scripts.check) selected.push("check");
  if (scripts.lint) selected.push("lint");
  if (scripts.typecheck) selected.push("typecheck");
  else if (scripts["type:check"]) selected.push("type:check");
  if (scripts.test) selected.push("test");
  if (scripts.build) selected.push("build");

  return selected;
}

export function parsePackageManager(value: string | undefined): PackageManager | undefined {
  const name = value?.split("@")[0];
  return name === "pnpm" || name === "bun" || name === "yarn" || name === "npm" ? name : undefined;
}

export function createCommand(packageManager: PackageManager, script: string): PlannedCommand {
  const command = packageManager;
  const args = ["run", script];
  return {
    packageManager,
    script,
    command,
    args,
    display: [command, ...args].join(" "),
  };
}

function isSelfReferential(script: string): boolean {
  return /\bvite-doctor\b/.test(script);
}
