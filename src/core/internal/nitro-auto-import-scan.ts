import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Import, UnimportOptions } from "unimport";
import type { NuxtDoctorManifest } from "../primitives.js";

type Scan = NonNullable<NuxtDoctorManifest["nitroAutoImportScan"]>;
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
  nitroVersion: string,
  options: Partial<UnimportOptions>,
  map: Map<string, Import>,
): Promise<Scan | undefined> {
  try {
    const { createUnimport, version } = await import("unimport");
    if (nitroVersion !== version) return;
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

export async function isNitroAutoImportScanCurrent(scan: Scan): Promise<boolean> {
  try {
    const { scanDirExports, version } = await import("unimport");
    if (scan.version !== version) return false;
    const decisions = scan.decisions && new Map(scan.decisions);
    const entries = scan.dirs.length
      ? await scanDirExports(scan.dirs, {
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
    return scanFingerprint(entries) === scan.fingerprint;
  } catch {
    return false;
  }
}
