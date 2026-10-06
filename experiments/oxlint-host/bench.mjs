#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { repoRoot } from "./doctor-api.mjs";
import { writeFixtureCorpus } from "./fixtures.mjs";
import { captureInventory } from "./inventory.mjs";
import { resolveOxlint, writeOxlintConfig } from "./oxlint.mjs";
import { portedRules } from "./rule-map.mjs";

const corpora = {
  fixtures: { framework: "auto", generate: writeFixtureCorpus },
  medium: { framework: "auto" },
  // Since #218 the vitehub root is a multi-Nuxt workspace; Doctor only runs it with an explicit
  // framework. `nitro` matches how vitehub ran before (#225).
  large: { framework: "nitro" },
};

const { values } = parseArgs({
  options: {
    corpus: { type: "string", default: "fixtures,medium,large" },
    runs: { type: "string", default: "5" },
    threads: { type: "string", default: String(availableParallelism()) },
    out: { type: "string", default: join(import.meta.dirname, "results") },
  },
});

const labDir = resolve(process.env.PERF_LAB_DIR ?? join(repoRoot, ".perf-lab"));
const probe = join(repoRoot, "scripts/perf-lab/probe.mjs");
const cli = join(repoRoot, "dist/cli.mjs");
const oxlint = resolveOxlint();
const runs = Number(values.runs);
const scratch = mkdtempSync(join(tmpdir(), "vd-oxlint-bench-"));
mkdirSync(values.out, { recursive: true });

await acquireLabLock();

for (const name of values.corpus.split(",")) {
  const { framework, generate } = corpora[name];
  const root = generate ? generate() : join(labDir, "corpora", name);
  console.error(`[${name}] capturing Project Inventory through Doctor...`);
  const inventory = await captureInventory(root, { framework });
  const doctorRules = inventory.activeRules;
  const config = writeOxlintConfig({ inventory, doctorRules });
  const noopConfig = writeOxlintConfig({ inventory, doctorRules, noop: true });
  const rustConfig = writeOxlintConfig({ inventory, doctorRules, rust: true });
  const doctorArgs = [
    cli,
    root,
    "--no-cache",
    "--format",
    "json",
    "--rules",
    doctorRules.join(","),
  ];
  if (framework !== "auto") doctorArgs.push("--framework", framework);

  // oxlint's own discovery lints tests, fixtures and scripts Doctor skips; the `-files` engines
  // pass Doctor's exact file list so both engines do the same work.
  const doctorFiles = inventory.files.map((file) => relative(root, file));
  const engines = {
    doctor: () => measure(doctorArgs, root),
    oxlint: () => measure(oxlintArgs(config, values.threads), root),
    "oxlint-files": () => measure(oxlintArgs(config, values.threads, doctorFiles), root),
    "oxlint-files-1t": () => measure(oxlintArgs(config, "1", doctorFiles), root),
    "oxlint-files-noop": () => measure(oxlintArgs(noopConfig, values.threads, doctorFiles), root),
    "oxlint-rust-correctness": () =>
      measure(oxlintArgs(rustConfig, values.threads, doctorFiles), root),
  };
  const samples = Object.fromEntries(Object.keys(engines).map((key) => [key, []]));
  const order = Object.keys(engines);
  for (let run = 0; run < runs; run++) {
    // Alternate the order every run so drift on the shared machine hits every engine.
    for (const key of run % 2 ? [...order].reverse() : order) {
      const sample = engines[key]();
      samples[key].push(sample);
      console.error(
        `[${name}] run ${run + 1}/${runs} ${key}: wall ${sample.wallMs} ms, cpu ${sample.cpuMs} ms, load ${sample.load}`,
      );
    }
  }

  console.error(`[${name}] one Doctor --profile run for the phase breakdown...`);
  const profile = JSON.parse(measure([...doctorArgs, "--profile"], root).stdout);
  const doctorReport = JSON.parse(samples.doctor.at(-1).stdout);
  const oxlintReport = JSON.parse(samples.oxlint.at(-1).stdout);
  const filesReport = JSON.parse(samples["oxlint-files"].at(-1).stdout);
  const parity = compareDiagnostics(root, inventory.files, doctorReport, oxlintReport);
  const filesParity = compareDiagnostics(root, inventory.files, doctorReport, filesReport);
  const summary = {
    corpus: name,
    root,
    framework,
    node: process.version,
    oxlint: oxlint.version,
    threads: oxlintReport.threads_count,
    cpus: availableParallelism(),
    runs,
    doctorRules,
    files: {
      doctor: inventory.files.length,
      oxlint: oxlintReport.number_of_files,
      oxlintFiles: filesReport.number_of_files,
    },
    inventory: { captureMs: inventory.inventoryMs, projectPhaseMs: inventory.projectPhaseMs },
    doctorProfile: {
      timings: profile.timings,
      phases: profile.phases,
      ruleTimings: profile.ruleTimings,
    },
    timings: Object.fromEntries(
      Object.entries(samples).map(([key, list]) => [key, summarize(list)]),
    ),
    parity,
    filesParitySameAsDirectory:
      JSON.stringify({ ...filesParity, outsideDoctorScope: [], oxlintOutsideDoctorScope: 0 }) ===
      JSON.stringify({ ...parity, outsideDoctorScope: [], oxlintOutsideDoctorScope: 0 }),
  };
  writeFileSync(join(values.out, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  printSummary(summary);
}

/** Shares the perf lab's lock so concurrent measurements queue instead of skewing each other. */
async function acquireLabLock() {
  const lock = join(labDir, "lock");
  mkdirSync(labDir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      process.on("exit", () => rmSync(lock, { recursive: true, force: true }));
      return;
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(join(lock, "pid"), "utf8").trim());
      } catch {}
      if (owner && !isAlive(owner)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      console.error(`Waiting for another perf-lab run (pid ${owner})...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function oxlintArgs(config, threads, files = ["."]) {
  return [
    oxlint.bin,
    "-c",
    config,
    "--disable-nested-config",
    "--format",
    "json",
    "--threads",
    threads,
    ...files,
  ];
}

function measure(args, cwd) {
  const probeOut = join(scratch, `probe-${process.hrtime.bigint()}.json`);
  const load = loadavg()[0].toFixed(1);
  const started = performance.now();
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
    env: { ...process.env, PERF_LAB_PROBE_OUT: probeOut, NO_COLOR: "1" },
  });
  const wallMs = Math.round(performance.now() - started);
  if (child.status !== 0 && !child.stdout.trimStart().startsWith("{"))
    throw new Error(`${args.join(" ")} failed (${child.status}):\n${child.stderr}`);
  const usage = JSON.parse(readFileSync(probeOut, "utf8"));
  return {
    wallMs,
    cpuMs: usage.userMs + usage.systemMs,
    userMs: usage.userMs,
    maxRssMb: usage.maxRssMb,
    load,
    stdout: child.stdout,
  };
}

function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summarize(list) {
  return {
    wallMs: median(list.map((sample) => sample.wallMs)),
    cpuMs: median(list.map((sample) => sample.cpuMs)),
    maxRssMb: median(list.map((sample) => sample.maxRssMb)),
    wallMsAll: list.map((sample) => sample.wallMs),
    cpuMsAll: list.map((sample) => sample.cpuMs),
    loadAll: list.map((sample) => sample.load),
  };
}

/**
 * Compares Diagnostics for the ported codes, keyed on `path:code:start:end` in UTF-16 offsets.
 * oxlint maps `.vue` script-block spans back to file positions but reports UTF-8 byte offsets,
 * so they are converted. Doctor drops Diagnostics whose fingerprints collide (same Rule, file,
 * nearest declaration name and message), so oxlint output is compared both raw and after the
 * same fingerprint dedupe.
 */
function compareDiagnostics(root, doctorFiles, doctorReport, oxlintReport) {
  const codes = new Set(portedRules.map((rule) => rule.code));
  const ruleByCode = new Map(portedRules.map((rule) => [rule.code, rule.doctor]));
  const inDoctorScope = new Set(doctorFiles.map((file) => relative(root, file)));
  const sources = new Map();
  const sourceOf = (path) => {
    if (!sources.has(path)) sources.set(path, readFileSync(join(root, path)));
    return sources.get(path);
  };
  const utf16 = (path, byteOffset) =>
    sourceOf(path).subarray(0, byteOffset).toString("utf8").length;
  const doctor = new Map();
  for (const diagnostic of doctorReport.diagnostics ?? []) {
    if (!codes.has(diagnostic.code)) continue;
    const { path, start, end, line, column } = diagnostic.location;
    doctor.set(`${path}:${diagnostic.code}:${start}:${end}`, {
      path,
      code: diagnostic.code,
      start,
      end,
      line,
      column,
      message: diagnostic.message,
    });
  }
  // Doctor applies `doctor-disable` comments and config suppressions at the report boundary.
  const suppressed = new Set(
    (doctorReport.suppressedDiagnostics ?? [])
      .filter((diagnostic) => codes.has(diagnostic.code))
      .map(({ code, location }) => `${location.path}:${code}:${location.start}:${location.end}`),
  );
  const oxlintAll = new Map();
  for (const diagnostic of oxlintReport.diagnostics ?? []) {
    const [, code, message] = diagnostic.message.match(/^(\S+) ([\s\S]*)$/) ?? [];
    const span = diagnostic.labels?.[0]?.span ?? {};
    const path = diagnostic.filename.replaceAll("\\", "/");
    const start = utf16(path, span.offset);
    const end = utf16(path, span.offset + span.length);
    oxlintAll.set(`${path}:${code}:${start}:${end}`, {
      path,
      code,
      start,
      end,
      line: span.line,
      column: span.column,
      message,
    });
  }
  const inScope = [...oxlintAll]
    .filter(([, item]) => inDoctorScope.has(item.path))
    .sort(([, a], [, b]) => a.path.localeCompare(b.path) || a.start - b.start);
  const oxlintRaw = new Map(inScope);
  const fingerprints = new Set();
  const oxlint = new Map(
    inScope.filter(([, item]) => {
      const source = sourceOf(item.path).toString("utf8");
      const fingerprint = `${ruleByCode.get(item.code)}:${item.path}:${nearestAnchor(source, item.start)}:${item.message.replace(/\s+/g, " ")}`;
      if (fingerprints.has(fingerprint)) return false;
      fingerprints.add(fingerprint);
      return true;
    }),
  );
  const droppedByFingerprint = [...oxlintRaw]
    .filter(([key]) => !oxlint.has(key))
    .map(([, item]) => item);
  const matched = [...doctor.keys()].filter((key) => oxlint.has(key));
  const messageMismatches = matched.filter(
    (key) => doctor.get(key).message !== oxlint.get(key).message,
  );
  const lineColumnMismatches = matched.filter((key) => {
    const a = doctor.get(key);
    const b = oxlint.get(key);
    return a.line !== b.line || a.column !== b.column;
  });
  const countByCode = (map) => {
    const counts = {};
    for (const item of map.values()) counts[item.code] = (counts[item.code] ?? 0) + 1;
    return counts;
  };
  return {
    doctor: doctor.size,
    oxlintRaw: oxlintRaw.size,
    oxlint: oxlint.size,
    oxlintOutsideDoctorScope: oxlintAll.size - oxlintRaw.size,
    droppedByFingerprint,
    matched: matched.length,
    byCode: { doctor: countByCode(doctor), oxlint: countByCode(oxlint) },
    messageMismatches: messageMismatches.map((key) => ({
      key,
      doctor: doctor.get(key).message,
      oxlint: oxlint.get(key).message,
    })),
    lineColumnMismatches: lineColumnMismatches.map((key) => ({
      key,
      doctor: [doctor.get(key).line, doctor.get(key).column],
      oxlint: [oxlint.get(key).line, oxlint.get(key).column],
    })),
    doctorOnly: [...doctor].filter(([key]) => !oxlint.has(key)).map(([, item]) => item),
    suppressedByDoctor: [...oxlint]
      .filter(([key]) => !doctor.has(key) && suppressed.has(key))
      .map(([, item]) => item),
    oxlintOnly: [...oxlint]
      .filter(([key]) => !doctor.has(key) && !suppressed.has(key))
      .map(([, item]) => item),
    outsideDoctorScope: [...oxlintAll]
      .filter(([, item]) => !inDoctorScope.has(item.path))
      .map(([, item]) => item),
  };
}

/** Same anchor as Doctor's `createDiagnosticFingerprint`. */
function nearestAnchor(source, offset) {
  const matches = [
    ...source
      .slice(0, offset)
      .matchAll(
        /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|(\{[^}\n]*\}|\[[^\]\n]*\]))|<([A-Z][\w.-]*)\b/g,
      ),
  ];
  const last = matches.at(-1);
  return last ? (last[1] ?? last[2] ?? last[3] ?? last[4] ?? "file") : "file";
}

function printSummary(summary) {
  const rows = Object.entries(summary.timings).map(
    ([key, t]) => `| ${key} | ${t.wallMs} | ${t.cpuMs} | ${t.maxRssMb} |`,
  );
  const p = summary.parity;
  console.log(
    [
      `\n### ${summary.corpus} (${summary.files.doctor} Doctor files, ${summary.files.oxlint} oxlint files, ${summary.threads} oxlint threads, ${summary.runs} runs)`,
      "",
      "| Engine | Wall ms (median) | CPU ms (median) | Max RSS MB |",
      "| --- | ---: | ---: | ---: |",
      ...rows,
      "",
      `Parity: Doctor ${p.doctor}, oxlint ${p.oxlintRaw} raw / ${p.oxlint} after Doctor fingerprint dedupe (in Doctor's file scope), matched ${p.matched}, Doctor-only ${p.doctorOnly.length}, oxlint-only ${p.oxlintOnly.length}, suppressed by a Doctor directive ${p.suppressedByDoctor.length}, message mismatches ${p.messageMismatches.length}, line/column mismatches ${p.lineColumnMismatches.length}, oxlint outside Doctor scope ${p.oxlintOutsideDoctorScope}.`,
    ].join("\n"),
  );
}
