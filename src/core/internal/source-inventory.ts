import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { glob } from "node:fs/promises";
import { relative, resolve } from "pathe";
import type { DoctorConfig } from "../config.js";
import type { DoctorRunOptions } from "../config.js";
import type { ProjectInfo, SourceFileHandle } from "../primitives.js";

const DEFAULT_INCLUDE = [
  "**/*.{vue,ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "vite.config.{ts,js,mjs,cjs,mts,cts}",
  "vitest.config.{ts,js,mjs,cjs,mts,cts}",
];
const CONTENT_INCLUDE = ["content/**/*.{md,mdc}"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.nuxt/**",
  "**/.next/**",
  "**/.output/**",
  "**/dist/**",
  "**/coverage/**",
  "**/public/**",
  "**/generated/**",
  "**/*.min.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "**/{test,tests,__tests__,fixtures}/**",
  "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}",
  "doctor.config.*",
];

export interface ScanFileEntry {
  path: string;
  displayPath: string;
  sourceKind: SourceFileHandle["sourceKind"];
  moduleName?: string;
}

export async function selectScanFiles(
  root: string,
  config: DoctorConfig,
  options: DoctorRunOptions,
  project: ProjectInfo,
): Promise<ScanFileEntry[]> {
  if (options.changed || options.since) {
    const changed = await gitChangedFiles(root, options.since);
    const includeContent = hasContentFiles(project);
    return changed
      .filter((file) =>
        includeContent
          ? /\.(vue|[cm]?[jt]sx?|mdc?)$/.test(file)
          : /\.(vue|[cm]?[jt]sx?)$/.test(file),
      )
      .filter((file) => statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile())
      .map((file) => createAppFileEntry(root, file));
  }

  const files = new Map<string, ScanFileEntry>();
  const exclude = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])];
  const include = config.include ?? defaultIncludeForProject(project);
  for (const pattern of include) {
    for await (const entry of glob(pattern, { cwd: root, exclude })) {
      if (typeof entry !== "string") continue;
      const absolute = resolve(root, entry);
      if (statSync(absolute, { throwIfNoEntry: false })?.isFile())
        files.set(absolute, createAppFileEntry(root, entry));
    }
  }

  for (const source of project.nuxt?.moduleSources ?? []) {
    const include = source.include?.length ? source.include : DEFAULT_INCLUDE;
    const moduleExclude = [...DEFAULT_EXCLUDE, ...(source.exclude ?? [])];
    for (const pattern of include) {
      for await (const entry of glob(pattern, { cwd: source.root, exclude: moduleExclude })) {
        if (typeof entry !== "string") continue;
        const absolute = resolve(source.root, entry);
        if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
        files.set(absolute, {
          path: absolute,
          displayPath: `${source.module}:${relative(source.root, absolute)}`,
          sourceKind: "module",
          moduleName: source.module,
        });
      }
    }
  }

  return [...files.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function defaultIncludeForProject(project: ProjectInfo): string[] {
  if (hasContentFiles(project)) return [...DEFAULT_INCLUDE, ...CONTENT_INCLUDE];
  return DEFAULT_INCLUDE;
}

function hasContentFiles(project: ProjectInfo): boolean {
  const moduleNames = new Set((project.nuxt?.modules ?? []).map((module) => module.name));
  return moduleNames.has("@nuxt/content") || moduleNames.has("docus");
}

function createAppFileEntry(root: string, file: string): ScanFileEntry {
  const absolute = resolve(root, file);
  return {
    path: absolute,
    displayPath: relative(root, absolute),
    sourceKind: detectAppSourceKind(root, absolute),
  };
}

function detectAppSourceKind(root: string, file: string): SourceFileHandle["sourceKind"] {
  const relativePath = relative(root, file);
  return relativePath.startsWith("layers/") ? "layer" : "app";
}

async function gitChangedFiles(root: string, since?: string): Promise<string[]> {
  const args = since
    ? ["diff", "--name-only", "--diff-filter=ACMR", since, "--"]
    : ["diff", "--name-only", "--diff-filter=ACMR", "--cached", "--"];
  const stdout = await execFileText("git", args, root);
  return stdout.split(/\r?\n/).filter(Boolean);
}

function execFileText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout);
    });
  });
}
