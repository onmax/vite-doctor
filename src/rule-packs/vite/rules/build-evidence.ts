import { isAbsolute, resolve } from "pathe";

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
  /**
   * Bundled modules whose rendered chunk code still reads Vite's empty browser stub, the module
   * Vite substitutes in client builds for a Node built-in or a `browser: false` package mapping.
   * Code that the bundler removed, such as an `import.meta.env.SSR` branch, does not count.
   */
  browserStubReads: string[];
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
    isStrings(value.browserStubReads)
  );
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
