import { isAbsolute, resolve } from "pathe";
import { nativeMatch, sha256 } from "../../../core/internal/utils.js";

export const BUILD_EVIDENCE_RULE = "vite/build/no-node-builtin-in-client-chunk";

export function wantsBuildEvidence(rules?: string): boolean {
  const patterns = rules
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return !patterns?.length || patterns.some((pattern) => nativeMatch(BUILD_EVIDENCE_RULE, pattern));
}

export function buildDiagnosticFingerprint(path: string, environment: string): string {
  return sha256(`${BUILD_EVIDENCE_RULE}:${path}:${environment}`);
}

/**
 * Build Evidence: what one `vite build` put in each output chunk, per Vite environment. The Vite
 * Plugin Surface collects it in `generateBundle` and passes it as `runtimeEvidence.vite.build`.
 * Module ids are relative to `root` when they are files inside it, absolute otherwise, and keep
 * their query, such as Nuxt's `?nuxt_component=server` stubs. Virtual ids keep their `\0` prefix.
 */
export interface ViteBuildEvidence {
  /** The absolute Vite root that relative module ids resolve against. */
  root: string;
  environments: ViteBuildEnvironment[];
}

export interface ViteBuildEnvironment {
  name: string;
  /** `consumer` from the Vite Environment API; unset when the host build exposes no environment. */
  consumer?: "client" | "server";
  chunks: Array<{ fileName: string; isEntry: boolean; modules: string[] }>;
  /** The facade module of each entry chunk. */
  entries: string[];
  /** Static and dynamic importers of each bundled module, from Vite's module graph. */
  importers: Record<string, string[]>;
  /** Source import offsets tied to surviving reads in a final output chunk. */
  browserStubReads: Array<{
    id: string;
    chunk: string;
    specifier: string;
    start: number;
  }>;
}

/** Build Evidence for the Doctor Run, or undefined when the run has none or it is malformed. */
export function readBuildEvidence(runtime: unknown): ViteBuildEvidence | undefined {
  if (!isRecord(runtime) || !isRecord(runtime.build)) return undefined;
  const { root, environments } = runtime.build;
  if (typeof root !== "string" || !isAbsolute(root) || !Array.isArray(environments))
    return undefined;
  if (!environments.every(isEnvironment)) return undefined;
  return { root, environments };
}

/** The absolute file a module id names, or undefined for a virtual id. */
export function buildModuleFile(evidence: ViteBuildEvidence, id: string): string | undefined {
  if (id.startsWith("\0")) return undefined;
  const path = id.replace(/[?#].*$/, "");
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(evidence.root, path);
}

/** The shortest importer path from an entry module of the environment to `id`, entry first. */
export function buildImportChain(
  environment: ViteBuildEnvironment,
  id: string,
): string[] | undefined {
  const entries = new Set(environment.entries);
  const via = new Map<string, string>();
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const current of frontier) {
      if (entries.has(current)) {
        const chain = [current];
        for (let at = current; at !== id;) {
          at = via.get(at)!;
          chain.push(at);
        }
        return chain;
      }
      for (const importer of environment.importers[current] ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        via.set(importer, current);
        next.push(importer);
      }
    }
    frontier = next;
  }
  return undefined;
}

function isEnvironment(value: unknown): value is ViteBuildEnvironment {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (value.consumer !== undefined && value.consumer !== "client" && value.consumer !== "server")
    return false;
  return (
    Array.isArray(value.chunks) &&
    value.chunks.every(
      (chunk) =>
        isRecord(chunk) &&
        typeof chunk.fileName === "string" &&
        typeof chunk.isEntry === "boolean" &&
        isStrings(chunk.modules),
    ) &&
    isStrings(value.entries) &&
    isRecord(value.importers) &&
    Object.values(value.importers).every(isStrings) &&
    Array.isArray(value.browserStubReads) &&
    value.browserStubReads.every(
      (read) =>
        isRecord(read) &&
        typeof read.id === "string" &&
        typeof read.chunk === "string" &&
        typeof read.specifier === "string" &&
        Number.isSafeInteger(read.start),
    )
  );
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
