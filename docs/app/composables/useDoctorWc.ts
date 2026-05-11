import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import { detectFramework, type Framework } from "~/utils/detectFramework";
import { parseGhUrl, GhUrlError } from "~/utils/parseGhUrl";
import {
  fetchAndUnpackTarball,
  PrivateOrMissingError,
  TarballTooLargeError,
} from "~/utils/tarball";
import { fixtureToTree, mergeRuntimeTree, type FixtureEntry } from "~/utils/wcTree";

export type WcStatus =
  | "idle"
  | "booting"
  | "fetching"
  | "mounting"
  | "detecting"
  | "scanning"
  | "done"
  | "error";

export interface DoctorDiagnostic {
  ruleId: string;
  severity: "blocker" | "error" | "warn" | "info";
  message: string;
  file: string;
  range?: { line: number; column: number };
  suggestion?: string;
  category?: string;
  confidence?: string;
}

export interface DoctorRunResult {
  version?: string;
  framework: "vue" | "nuxt";
  root: string;
  score: number;
  summary: { blocker: number; error: number; warn: number; info: number; fixable: number };
  diagnostics: DoctorDiagnostic[];
  timings?: Record<string, number>;
}

interface LoadedFixture {
  fixture: Record<string, FixtureEntry>;
  binPath: string;
}

interface ScanRun {
  id: number;
  framework: Framework;
  tree: FileSystemTree;
  binPath: string;
}

let wcPromise: Promise<WebContainer> | null = null;
let activeRunId = 0;
const WC_BOOT_TIMEOUT_MS = 45_000;

async function getWc(): Promise<WebContainer> {
  if (!wcPromise) wcPromise = import("@webcontainer/api").then((m) => m.WebContainer.boot());
  return withTimeout(
    wcPromise,
    WC_BOOT_TIMEOUT_MS,
    "WebContainer boot timed out. Reload the page and try again.",
  );
}

async function loadFixture(framework: Framework): Promise<LoadedFixture> {
  return fetchFixture<LoadedFixture>(`/__wc-fixtures/${framework}.json`);
}

async function loadDemo(): Promise<Record<string, FixtureEntry>> {
  const payload = await fetchFixture<{ demo: Record<string, FixtureEntry> }>(
    "/__wc-fixtures/demo.json",
  );
  return payload.demo;
}

async function fetchFixture<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fixture load failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function useDoctorWc() {
  const status = useState<WcStatus>("doctor-wc-status", () => "idle");
  const errorMsg = useState<string | null>("doctor-wc-error", () => null);
  const result = useState<DoctorRunResult | null>("doctor-wc-result", () => null);
  const framework = useState<Framework>("doctor-wc-framework", () => "nuxt");
  const phaseLabel = useState<string>("doctor-wc-phase", () => "");
  const logSink = useState<((data: string) => void) | null>("doctor-wc-log", () => null);

  function setStatus(next: WcStatus, label = "") {
    status.value = next;
    phaseLabel.value = label;
  }

  function setLogSink(fn: ((data: string) => void) | null) {
    logSink.value = fn;
  }

  function beginRun() {
    activeRunId += 1;
    errorMsg.value = null;
    result.value = null;
    setStatus("idle");
    return activeRunId;
  }

  function isActive(run: ScanRun | number) {
    return (typeof run === "number" ? run : run.id) === activeRunId;
  }

  async function prepareRun(
    id: number,
    fw: Framework,
    targetTree: FileSystemTree,
  ): Promise<ScanRun> {
    const { fixture, binPath } = await loadFixture(fw);
    return {
      id,
      framework: fw,
      tree: mergeRuntimeTree(targetTree, fixtureToTree(fixture)),
      binPath,
    };
  }

  async function runScan(wc: WebContainer, run: ScanRun) {
    if (!isActive(run)) return;

    await wc.mount(run.tree);
    if (!isActive(run)) return;

    setStatus("scanning", `Running ${run.framework}-doctor`);
    const relBin = run.binPath.replace(/^\/+/, "");
    const proc = await wc.spawn("node", [relBin, "scan", "--format", "json"], { cwd: wc.workdir });
    let stdout = "";
    const outputDone = proc.output.pipeTo(
      new WritableStream({
        write(chunk) {
          stdout += chunk;
          if (isActive(run)) logSink.value?.(chunk);
        },
      }),
    );

    const exit = await proc.exit;
    await outputDone.catch(() => {});
    if (!isActive(run)) return;

    const parsed = extractJson(stdout);
    if (!parsed) {
      errorMsg.value = `Scan failed (exit ${exit}). See logs.`;
      setStatus("error");
      return;
    }

    result.value = parsed;
    if (exit === 0) {
      setStatus("done", "Scan complete");
    } else {
      errorMsg.value = `${run.framework}-doctor exited ${exit}. Partial results are shown.`;
      setStatus("error", "Scan completed with errors");
    }
  }

  async function scan(input: string) {
    const runId = beginRun();

    let ref;
    try {
      ref = parseGhUrl(input);
    } catch (e) {
      errorMsg.value = (e as Error).message;
      setStatus("error");
      return;
    }

    try {
      setStatus("booting", "Booting WebContainer");
      const wc = await getWc();
      if (!isActive(runId)) return;

      setStatus("fetching", `Fetching ${ref.owner}/${ref.repo}`);
      const userTree = await fetchAndUnpackTarball(ref);
      if (!isActive(runId)) return;

      setStatus("detecting", "Detecting framework");
      framework.value = detectFramework(readTreeText(userTree, "package.json") ?? "{}");
      const run = await prepareRun(runId, framework.value, userTree);
      if (!isActive(run)) return;

      setStatus("mounting", "Mounting files");
      await runScan(wc, run);
    } catch (e) {
      if (!isActive(runId)) return;
      if (e instanceof PrivateOrMissingError) errorMsg.value = e.message;
      else if (e instanceof TarballTooLargeError) errorMsg.value = e.message;
      else if (e instanceof GhUrlError) errorMsg.value = e.message;
      else errorMsg.value = (e as Error).message ?? "Unexpected error";
      setStatus("error");
    }
  }

  async function scanDemo() {
    const runId = beginRun();
    try {
      setStatus("booting", "Booting WebContainer");
      const wc = await getWc();
      if (!isActive(runId)) return;

      setStatus("mounting", "Mounting demo");
      const demoTree = fixtureToTree(await loadDemo());
      framework.value = "nuxt";
      const run = await prepareRun(runId, "nuxt", demoTree);
      await runScan(wc, run);
    } catch (e) {
      if (!isActive(runId)) return;
      errorMsg.value = (e as Error).message ?? "Unexpected error";
      setStatus("error");
    }
  }

  function reset() {
    activeRunId += 1;
    result.value = null;
    errorMsg.value = null;
    setStatus("idle");
  }

  return { status, errorMsg, result, framework, phaseLabel, scan, scanDemo, reset, setLogSink };
}

function readTreeText(tree: FileSystemTree, path: string): string | null {
  const parts = path.split("/");
  let node: FileSystemTree | undefined = tree;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const child = node?.[parts[i]!] as { directory?: FileSystemTree } | undefined;
    if (!child || !("directory" in child)) return null;
    node = child.directory;
  }
  const file = node?.[parts[parts.length - 1]!] as
    | { file?: { contents?: string | Uint8Array } }
    | undefined;
  if (!file || !("file" in file)) return null;
  const contents = file.file.contents;
  if (!contents) return null;
  return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
}

function extractJson(buffer: string): DoctorRunResult | null {
  const end = buffer.lastIndexOf("}");
  if (end < 0) return null;

  for (
    let start = buffer.lastIndexOf("{", end);
    start >= 0;
    start = buffer.lastIndexOf("{", start - 1)
  ) {
    try {
      return JSON.parse(buffer.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
