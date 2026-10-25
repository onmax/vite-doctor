import { expect, test } from "vite-plus/test";
import {
  diffStates,
  formatDelta,
  mergeAffectedRun,
  stateFromRun,
  type SurfaceDiagnostic,
  type SurfaceEvidenceGap,
  type SurfaceRunReport,
} from "../../src/plugin-delta.ts";

const root = "/project";

function diagnostic(
  id: string,
  severity: SurfaceDiagnostic["severity"],
  files: string[],
): SurfaceDiagnostic {
  return {
    id,
    severity,
    files: files.map((file) => `${root}/${file}`),
    summary: `${id} ${files[0]}:1:1 ${id} message`,
    detail: `  ${id} detail`,
  };
}

function gap(id: string, files: string[]): SurfaceEvidenceGap {
  return {
    id,
    source: "script-parser",
    message: `${id} unparsed`,
    files: files.map((file) => `${root}/${file}`),
  };
}

function run(report: Partial<SurfaceRunReport>): SurfaceRunReport {
  return { diagnostics: [], evidenceGaps: [], runtimeIncomplete: false, ...report };
}

const affected = (...files: string[]) => new Set(files.map((file) => `${root}/${file}`));
const options = { root, changed: [`${root}/a.ts`], mode: "error" as const };

test("an affected-files run replaces only Diagnostics that touch its files", () => {
  const previous = stateFromRun(
    run({
      diagnostics: [
        diagnostic("A1", "error", ["a.ts"]),
        diagnostic("B1", "warn", ["b.ts"]),
        diagnostic("C1", "info", ["c.ts", "a.ts"]),
      ],
      evidenceGaps: [gap("GA", ["a.ts"]), gap("GB", ["b.ts"])],
    }),
  );
  const next = mergeAffectedRun(
    previous,
    affected("a.ts"),
    run({ diagnostics: [diagnostic("A2", "warn", ["a.ts"])] }),
  );

  expect([...next.diagnostics.keys()]).toEqual(["B1", "A2"]);
  expect([...next.evidenceGaps.keys()]).toEqual(["GB"]);
  const delta = diffStates(previous, next);
  expect(delta.added.map((item) => item.id)).toEqual(["A2"]);
  expect(delta.resolved.map((item) => item.id)).toEqual(["A1", "C1"]);
  expect(delta.resolvedGaps.map((item) => item.id)).toEqual(["GA"]);
});

test("the delta log lists new Diagnostics in full, resolved ones in one line, and the totals", () => {
  const previous = stateFromRun(run({ diagnostics: [diagnostic("A1", "warn", ["a.ts"])] }));
  const next = stateFromRun(run({ diagnostics: [diagnostic("A2", "error", ["a.ts"])] }));

  expect(formatDelta(diffStates(previous, next), next, options)).toEqual({
    level: "error",
    message: [
      "Vite Doctor: 1 new Diagnostic, 1 resolved after changes to a.ts",
      "  A2 detail",
      "  resolved: A1 a.ts:1:1 A1 message",
      "Now: 0 blockers, 1 error, 0 warnings, 0 info",
    ].join("\n"),
  });
});

test("an unchanged run logs nothing", () => {
  const state = stateFromRun(run({ diagnostics: [diagnostic("A1", "error", ["a.ts"])] }));
  const next = mergeAffectedRun(
    state,
    affected("a.ts"),
    run({ diagnostics: [diagnostic("A1", "error", ["a.ts"])] }),
  );
  expect(formatDelta(diffStates(state, next), next, options)).toBeUndefined();
});

test("the log level follows what the run added and the fail mode", () => {
  const failing = stateFromRun(run({ diagnostics: [diagnostic("B1", "error", ["b.ts"])] }));
  const level = (
    next: SurfaceRunReport,
    overrides: Partial<Parameters<typeof formatDelta>[2]> = {},
    previous = failing,
  ) => {
    const state = mergeAffectedRun(previous, affected("a.ts"), next);
    return formatDelta(diffStates(previous, state), state, { ...options, ...overrides })?.level;
  };

  expect(level(run({ diagnostics: [diagnostic("A1", "error", ["a.ts"])] }))).toBe("error");
  expect(level(run({ diagnostics: [diagnostic("A1", "error", ["a.ts"])] }), { mode: "warn" })).toBe(
    "warn",
  );
  // An info Diagnostic does not fail the run, even while an older error still does.
  expect(level(run({ diagnostics: [diagnostic("A1", "info", ["a.ts"])] }))).toBe("info");
  expect(level(run({ diagnostics: [diagnostic("A1", "warn", ["a.ts"])] }))).toBe("warn");
  expect(
    level(run({ diagnostics: [diagnostic("A1", "warn", ["a.ts"])] }), { maxWarnings: 0 }),
  ).toBe("error");
  expect(level(run({ evidenceGaps: [gap("GA", ["a.ts"])] }))).toBe("error");
  const withA = stateFromRun(run({ diagnostics: [diagnostic("A1", "error", ["a.ts"])] }));
  expect(level(run({}), {}, withA)).toBe("info");
});

test("evidence that goes missing or returns is logged with the incomplete status", () => {
  const previous = stateFromRun(run({}));
  const next = mergeAffectedRun(
    previous,
    affected("a.ts"),
    run({ evidenceGaps: [gap("GA", ["a.ts"])], runtimeIncomplete: true }),
  );
  expect(formatDelta(diffStates(previous, next), next, options)?.message).toBe(
    [
      "Vite Doctor: evidence changed after changes to a.ts",
      "Evidence missing: GA unparsed a.ts",
      "Runtime Evidence missing: a required framework runtime is unresolved",
      "Now: 0 blockers, 0 errors, 0 warnings, 0 info, status incomplete",
    ].join("\n"),
  );

  const restored = mergeAffectedRun(next, affected("a.ts"), run({}));
  expect(formatDelta(diffStates(next, restored), restored, options)).toEqual({
    level: "info",
    message: [
      "Vite Doctor: evidence changed after changes to a.ts",
      "Evidence restored: GA unparsed a.ts",
      "Runtime Evidence restored",
      "Now: 0 blockers, 0 errors, 0 warnings, 0 info",
    ].join("\n"),
  });
});

test("the log header names at most three changed files", () => {
  const previous = stateFromRun(run({}));
  const next = stateFromRun(run({ diagnostics: [diagnostic("A1", "info", ["a.ts"])] }));
  const changed = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((file) => `${root}/${file}`);
  expect(
    formatDelta(diffStates(previous, next), next, { ...options, changed })?.message.split("\n")[0],
  ).toBe("Vite Doctor: 1 new Diagnostic after changes to a.ts, b.ts, c.ts and 2 more");
});
