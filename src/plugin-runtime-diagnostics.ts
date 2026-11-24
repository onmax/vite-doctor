import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import type { ViteDevServer } from "vite";
import type { RuntimeFrameworkDiagnostic } from "./core/index.js";

/** The event `nostics/reporters/dev` sends from the browser with `import.meta.hot.send()`. */
const NOSTICS_REPORT = "nostics:report";
// A page that reports in a loop must not grow the dev server's memory or every Doctor Run.
const MAX_REPORTS = 200;
const CODE = /^[A-Za-z][\w-]{0,63}$/;
const CALL_SITE = /^(.+):(\d+):(\d+)$/;

/**
 * Collects the framework diagnostics a dev server's browser clients report, one per code,
 * message, and call site, until the dev server closes or the reported file is saved.
 */
export class RuntimeDiagnosticReports {
  private readonly reports = new Map<string, RuntimeFrameworkDiagnostic>();
  private readonly onReport = (payload: unknown) => void this.receive(payload);

  constructor(
    private readonly server: ViteDevServer,
    private readonly reported: (report: RuntimeFrameworkDiagnostic) => void,
  ) {}

  listen() {
    this.server.ws.on(NOSTICS_REPORT, this.onReport);
  }

  close() {
    this.server.ws.off(NOSTICS_REPORT, this.onReport);
  }

  list(): RuntimeFrameworkDiagnostic[] {
    return [...this.reports.values()];
  }

  /** Drops reports located in `file`, since the saved code may no longer report them. */
  forget(file: string): boolean {
    let forgot = false;
    for (const [key, report] of this.reports) {
      if (report.location?.file !== file) continue;
      this.reports.delete(key);
      forgot = true;
    }
    return forgot;
  }

  private async receive(payload: unknown) {
    const parsed = parseReport(payload);
    if (!parsed) return;
    const report = { ...parsed, ...(await locate(this.server, parsed.sources)) };
    const where = report.location?.line
      ? `${report.location.file}:${report.location.line}:${report.location.column}`
      : (report.location?.file ?? report.sources.map(withoutQuery).join("\n"));
    const key = `${report.code}\0${report.why}\0${where}`;
    if (this.reports.has(key) || this.reports.size >= MAX_REPORTS) return;
    this.reports.set(key, report);
    this.reported(report);
  }
}

/** Accepts only the fields of nostics' `Diagnostic.toJSON()` that Doctor reports. */
function parseReport(payload: unknown): RuntimeFrameworkDiagnostic | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { name, why, fix, docs, sources } = payload as Record<string, unknown>;
  if (typeof name !== "string" || !CODE.test(name)) return undefined;
  if (typeof why !== "string" || !why.trim()) return undefined;
  if (fix !== undefined && typeof fix !== "string") return undefined;
  if (docs !== undefined && (typeof docs !== "string" || !/^https?:\/\//.test(docs)))
    return undefined;
  if (
    sources !== undefined &&
    !(Array.isArray(sources) && sources.every((source) => typeof source === "string"))
  )
    return undefined;
  return {
    code: name,
    why,
    fix: fix?.trim() || undefined,
    docs,
    sources: (sources as string[] | undefined) ?? [],
  };
}

/**
 * Maps the first reported call site, a position in the code the dev server served, back to its
 * source file through the client module graph and the module's source map.
 */
async function locate(
  server: ViteDevServer,
  sources: string[],
): Promise<Pick<RuntimeFrameworkDiagnostic, "location" | "locationGap">> {
  const [source] = sources;
  if (!source) return { locationGap: "The runtime reported no call site." };
  const unmapped = `Doctor did not map the call site ${withoutQuery(source)} to a source file in the dev server's module graph.`;
  const [, at, line, column] = CALL_SITE.exec(source) ?? [];
  const url = at && servedUrl(at, server.config.base);
  if (!url) return { locationGap: unmapped };
  const graph = server.environments?.client?.moduleGraph ?? server.moduleGraph;
  const module = await graph.getModuleByUrl(url).catch(() => undefined);
  const file = module?.file;
  if (!file) return { locationGap: unmapped };
  const map = module.transformResult?.map;
  const partial = {
    location: { file },
    locationGap: `The dev server's source map for ${url} does not map line ${line}, column ${column} back to ${file}.`,
  };
  if (!map || !map.mappings) return partial;
  const original = originalPositionFor(new TraceMap(map as SourceMapInput, file), {
    line: Number(line),
    column: Number(column) - 1,
  });
  if (original.line === null || !original.source || withoutQuery(original.source) !== file)
    return partial;
  return { location: { file, line: original.line, column: original.column + 1 } };
}

/** The dev server URL of a reported call site, without the origin and the Vite `base`. */
function servedUrl(at: string, base: string): string | undefined {
  let path: string;
  if (/^https?:\/\//.test(at)) {
    const url = URL.parse(at);
    if (!url) return undefined;
    path = url.pathname + url.search;
  } else if (at.startsWith("/")) path = at;
  else return undefined;
  if (base !== "/" && path.startsWith(base)) path = `/${path.slice(base.length)}`;
  return path;
}

function withoutQuery(source: string): string {
  return source.replace(/\?[^:]*(?=(?::\d+:\d+)?$)/, "");
}
