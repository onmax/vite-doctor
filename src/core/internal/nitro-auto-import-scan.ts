import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Import, UnimportOptions } from "unimport";
import type { NuxtDoctorManifest } from "../primitives.js";

type Scan = NonNullable<NuxtDoctorManifest["nitroAutoImportScan"]>;
type Scanner = Pick<typeof import("unimport"), "createUnimport" | "scanDirExports" | "version">;

export function resolveNitroScanner(nitroPackage: string | undefined) {
  if (!nitroPackage) return;
  try {
    const require = createRequire(nitroPackage);
    const { name, version } = JSON.parse(
      readFileSync(require.resolve("unimport/package.json"), "utf8"),
    );
    if (name === "unimport" && typeof version === "string")
      return { entry: pathToFileURL(require.resolve("unimport")).href, version };
  } catch {
    return undefined;
  }
}

export async function loadNitroScanner(entry: string): Promise<Scanner | undefined> {
  try {
    return await import(entry);
  } catch {
    return undefined;
  }
}

async function loadBundledScanner(version: string): Promise<Scanner> {
  const scanner = await import("unimport");
  return scanner.version === version ? scanner : import("unimport-nitro-v6");
}

function fingerprint(entries: unknown) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function scanFingerprint(entries: Import[]) {
  return fingerprint(entries.map(({ name, as, from, type }) => [name, as, from, type === true]));
}

function runtimeFingerprint(map: Map<string, Import>) {
  return fingerprint(
    [...map.keys()].sort().map((key) => {
      const { name, from } = map.get(key)!;
      return [key, name, from];
    }),
  );
}

export async function captureNitroAutoImportScan(
  scanner: Scanner | undefined,
  nitroVersion: string,
  options: Partial<UnimportOptions>,
  map: Map<string, Import>,
): Promise<Scan | undefined> {
  try {
    if (!scanner || nitroVersion !== scanner.version) return;
    const { createUnimport, version } = scanner;
    const dirs = options.dirs?.map((dir) => (typeof dir === "string" ? dir : { ...dir })) ?? [];
    const { cwd = process.cwd(), types, filePatterns, fileFilter } = options.dirsScanOptions ?? {};
    const scanOptions = { cwd: resolve(cwd), types, filePatterns: filePatterns?.slice() };
    const decisions = new Map<string, boolean>();
    const fresh = createUnimport({
      ...options,
      dirs,
      warn: () => {},
      dirsScanOptions: {
        ...scanOptions,
        fileFilter:
          fileFilter &&
          ((file) => {
            const included = Boolean(fileFilter(file));
            decisions.set(file, included);
            return included;
          }),
      },
    });
    const entries = dirs.length ? await fresh.scanImportsFromDir() : [];
    if (runtimeFingerprint(await fresh.getImportMap()) !== runtimeFingerprint(map)) return;
    return {
      version,
      dirs,
      options: scanOptions,
      decisions: fileFilter ? [...decisions] : undefined,
      fingerprint: scanFingerprint(entries),
    };
  } catch {
    return undefined;
  }
}

export async function verifyNitroAutoImportScan(
  scan: Scan,
  nitroPackage: string | undefined,
  trustHost: boolean,
): Promise<"current" | "stale" | "requires-trust"> {
  try {
    const installed = resolveNitroScanner(nitroPackage);
    if (nitroPackage && installed?.version !== scan.version) return "stale";
    const scanner =
      installed && trustHost
        ? await loadNitroScanner(installed.entry)
        : await loadBundledScanner(scan.version);
    if (scanner?.version !== scan.version)
      return installed && !trustHost ? "requires-trust" : "stale";
    const decisions = scan.decisions && new Map(scan.decisions);
    const entries = scan.dirs.length
      ? await scanner.scanDirExports(scan.dirs, {
          ...scan.options,
          fileFilter:
            decisions &&
            ((file) => {
              const included = decisions.get(file);
              if (included === undefined) throw new Error("No Nitro scan decision for this file");
              return included;
            }),
        })
      : [];
    return scanFingerprint(entries) === scan.fingerprint ? "current" : "stale";
  } catch {
    return "stale";
  }
}
