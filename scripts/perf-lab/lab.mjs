#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const labDir = resolve(process.env.PERF_LAB_DIR ?? join(repoRoot, ".perf-lab"));
const corporaDir = join(labDir, "corpora");
const resultsDir = join(labDir, "results");
const probe = join(here, "probe.mjs");
const corpora = JSON.parse(readFileSync(join(here, "corpora.json"), "utf8"));
const allScenarios = ["nocache", "cold", "warm", "changed", "profile", "startup"];

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    doctor: { type: "string", default: repoRoot },
    label: { type: "string" },
    corpus: { type: "string" },
    "corpus-path": { type: "string", multiple: true },
    runs: { type: "string", default: "3" },
    scenarios: { type: "string", default: allScenarios.join(",") },
    markdown: { type: "boolean", default: false },
    "allow-diff": { type: "boolean", default: false },
  },
});

const commands = { prepare, run: locked(run), compare, trace: locked(trace), report };
if (!commands[command]) {
  console.error(
    "Usage: node scripts/perf-lab/lab.mjs <prepare|run|compare|trace|report> [options]\nSee scripts/perf-lab/README.md.",
  );
  process.exit(1);
}
await commands[command]();

// Measurements edit corpus files and compete for CPU, so concurrent agents queue here.
function locked(fn) {
  return async () => {
    const lock = join(labDir, "lock");
    mkdirSync(labDir, { recursive: true });
    let waited = false;
    for (;;) {
      try {
        mkdirSync(lock);
        writeFileSync(join(lock, "pid"), String(process.pid));
        break;
      } catch {
        let owner = 0;
        try {
          owner = Number(readFileSync(join(lock, "pid"), "utf8").trim());
        } catch {}
        if (owner && !isAlive(owner)) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (!waited) console.error(`Waiting for another perf-lab run (pid ${owner})...`);
        waited = true;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    try {
      await fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function selectedCorpora() {
  const local = (values["corpus-path"] ?? []).map((entry) => {
    const [name, path, changeFile] = entry.split("=")[1]
      ? [entry.split("=")[0], ...entry.split("=")[1].split(":")]
      : [];
    if (!name || !path)
      throw new Error(`Expected --corpus-path name=/abs/path[:change/file.ts], got ${entry}`);
    return { name, local: resolve(path), changeFile };
  });
  const all = [...corpora, ...local];
  const wanted = values.corpus?.split(",").filter(Boolean);
  return wanted ? all.filter((corpus) => wanted.includes(corpus.name)) : all;
}

function corpusRoot(corpus) {
  return corpus.local ?? join(corporaDir, corpus.name);
}

async function prepare() {
  mkdirSync(corporaDir, { recursive: true });
  for (const corpus of selectedCorpora()) {
    if (corpus.local) continue;
    const root = corpusRoot(corpus);
    if (existsSync(join(root, ".git"))) {
      const head = git(root, ["rev-parse", "HEAD"]).trim();
      if (head === corpus.sha) {
        git(root, ["checkout", "--quiet", "--", "."]);
        git(root, ["clean", "-fdxq"]);
        console.log(`${corpus.name}: ready at ${corpus.sha.slice(0, 12)}`);
        continue;
      }
      rmSync(root, { recursive: true, force: true });
    }
    mkdirSync(root, { recursive: true });
    git(root, ["init", "--quiet"]);
    git(root, ["remote", "add", "origin", corpus.repo]);
    git(root, ["fetch", "--quiet", "--depth", "1", "origin", corpus.sha]);
    git(root, ["checkout", "--quiet", "FETCH_HEAD"]);
    console.log(`${corpus.name}: cloned ${corpus.repo} at ${corpus.sha.slice(0, 12)}`);
  }
}

async function run() {
  const doctor = resolve(values.doctor);
  const cli = join(doctor, "dist/cli.mjs");
  if (!existsSync(cli)) throw new Error(`No built CLI at ${cli}. Run pnpm build first.`);
  const label = values.label ?? `${git(doctor, ["rev-parse", "--short", "HEAD"]).trim()}`;
  const runs = Number(values.runs);
  const scenarios = values.scenarios.split(",");
  const results = {
    label,
    doctor,
    commit: git(doctor, ["rev-parse", "HEAD"]).trim(),
    node: process.version,
    date: new Date().toISOString(),
    corpora: {},
  };

  if (scenarios.includes("startup")) results.startup = measureStartup(doctor, runs);

  for (const corpus of selectedCorpora()) {
    const root = corpusRoot(corpus);
    if (!existsSync(root))
      throw new Error(`Missing corpus ${corpus.name}. Run the prepare command.`);
    const entry = (results.corpora[corpus.name] = {});
    for (const scenario of scenarios) {
      if (scenario === "startup") continue;
      if (scenario === "changed" && !corpus.changeFile) continue;
      const samples = [];
      const count = scenario === "profile" || scenario === "cold" ? 1 : runs;
      if (scenario === "warm") runDoctor(cli, doctor, root, []);
      for (let index = 0; index < count; index++) {
        if (scenario === "cold") clearCache(root);
        samples.push(runScenario(scenario, cli, doctor, root, corpus));
      }
      entry[scenario] = summarize(samples);
      log(corpus.name, scenario, entry[scenario]);
    }
  }

  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${label}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nWrote ${relative(process.cwd(), file)}`);
}

function runScenario(scenario, cli, doctor, root, corpus) {
  if (scenario === "nocache") return runDoctor(cli, doctor, root, ["--no-cache"]);
  if (scenario === "cold" || scenario === "warm") return runDoctor(cli, doctor, root, []);
  if (scenario === "profile") return runDoctor(cli, doctor, root, ["--no-cache", "--profile"]);
  if (scenario === "changed") {
    const target = join(root, corpus.changeFile);
    const original = readFileSync(target, "utf8");
    try {
      appendFileSync(target, "\nexport const __perfLabEdit = 1\n");
      return runDoctor(cli, doctor, root, ["--changed"]);
    } finally {
      writeFileSync(target, original);
    }
  }
  throw new Error(`Unknown scenario ${scenario}`);
}

function runDoctor(cli, doctor, root, args, extraEnv = {}) {
  const probeOut = join(labDir, `probe-${process.pid}.json`);
  mkdirSync(labDir, { recursive: true });
  rmSync(probeOut, { force: true });
  const started = performance.now();
  const child = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(probe).href, cli, root, "--format", "json", ...args],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 512,
      env: {
        ...process.env,
        NO_COLOR: "1",
        PERF_LAB_PROBE_OUT: probeOut,
        PERF_LAB_DOCTOR: doctor,
        PERF_LAB_DOCTOR_DIST: pathToFileURL(join(doctor, "dist")).href,
        PERF_LAB_CORPUS: root,
        ...extraEnv,
      },
    },
  );
  const wallMs = Math.round(performance.now() - started);
  const usage = existsSync(probeOut) ? JSON.parse(readFileSync(probeOut, "utf8")) : {};
  rmSync(probeOut, { force: true });
  let report;
  try {
    report = JSON.parse(child.stdout);
  } catch {
    throw new Error(
      `Doctor did not print a JSON report for ${root} (exit ${child.status}).\n${child.stderr.slice(0, 2000)}`,
    );
  }
  const diagnostics = normalizeDiagnostics(report, root);
  return {
    wallMs,
    ...usage,
    exitCode: child.status,
    files: report.scope?.files,
    diagnostics: diagnostics.length,
    digest: createHash("sha256").update(JSON.stringify(diagnostics)).digest("hex").slice(0, 16),
    normalized: diagnostics,
    timings: report.timings,
    phases: report.phases,
    ruleTimings: report.ruleTimings,
  };
}

function normalizeDiagnostics(report, root) {
  const rel = (file) => (typeof file === "string" ? relative(root, resolve(root, file)) : file);
  return [
    ...(report.diagnostics ?? []),
    ...(report.suppressedDiagnostics ?? []).map((d) => ({ ...d, suppressed: true })),
  ]
    .map((diagnostic) =>
      JSON.stringify([
        diagnostic.code,
        diagnostic.ruleId ?? diagnostic.rule,
        rel(diagnostic.file ?? diagnostic.location?.file),
        diagnostic.range ?? diagnostic.location,
        diagnostic.fingerprint,
        diagnostic.severity,
        Boolean(diagnostic.suppressed),
      ]),
    )
    .sort();
}

function summarize(samples) {
  const pick = (key) => samples.map((sample) => sample[key]).filter((value) => value !== undefined);
  const digests = new Set(pick("digest"));
  const last = samples.at(-1);
  return {
    runs: samples.length,
    wallMs: median(pick("wallMs")),
    wallMsAll: pick("wallMs"),
    userMs: median(pick("userMs")),
    maxRssMb: Math.max(...pick("maxRssMb")),
    exitCode: last.exitCode,
    files: last.files,
    diagnostics: last.diagnostics,
    digest: digests.size === 1 ? last.digest : `unstable:${[...digests].join(",")}`,
    normalized: last.normalized,
    timings: last.timings,
    phases: last.phases,
    ruleTimings: last.ruleTimings,
    parsers: last.parsers,
  };
}

function measureStartup(doctor, runs) {
  const time = (args) => {
    const samples = [];
    for (let index = 0; index < Math.max(runs, 5); index++) {
      const started = performance.now();
      const child = spawnSync(process.execPath, args, { encoding: "utf8" });
      if (child.status !== 0) throw new Error(child.stderr);
      samples.push(Math.round(performance.now() - started));
    }
    return median(samples);
  };
  const startup = {
    cliVersionMs: time([join(doctor, "dist/cli.mjs"), "--version"]),
    pluginImportMs: time([
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(doctor, "dist/plugin.mjs")).href)})`,
    ]),
    nodeBaselineMs: time(["-e", "0"]),
  };
  log("startup", "", startup);
  return startup;
}

function clearCache(root) {
  for (const dir of [".vite-doctor/cache", ".nuxt/doctor/cache"])
    rmSync(join(root, dir), { recursive: true, force: true });
}

async function trace() {
  const doctor = resolve(values.doctor);
  const cli = join(doctor, "dist/cli.mjs");
  for (const corpus of selectedCorpora()) {
    const root = corpusRoot(corpus);
    const sample = runDoctor(cli, doctor, root, ["--no-cache"], { PERF_LAB_TRACE_PARSERS: "1" });
    console.log(`\n## ${corpus.name} (${sample.files} files, ${sample.wallMs}ms traced)`);
    console.log("| Parser | Calls | ms | Max calls on one file |");
    console.log("|---|---:|---:|---|");
    for (const [parser, entry] of Object.entries(sample.parsers ?? {})) {
      const [worst, count] = Object.entries(entry.files).sort((a, b) => b[1] - a[1])[0] ?? [];
      console.log(
        `| ${parser} | ${entry.count} | ${Math.round(entry.ms)} | ${count ?? 0} ${worst ? relative(root, worst) : ""} |`,
      );
    }
  }
}

function report() {
  const result = loadResult(positionals[0]);
  for (const [name, entry] of Object.entries(result.corpora)) {
    const profile = entry.profile;
    console.log(`\n## ${name}`);
    for (const [scenario, value] of Object.entries(entry))
      console.log(
        `${scenario.padEnd(8)} ${value.wallMs}ms  ${value.maxRssMb}MB  ${value.diagnostics} diagnostics`,
      );
    if (!profile) continue;
    console.log("phases", JSON.stringify(profile.phases));
    const rules = profile.ruleTimings ?? [];
    const packs = {};
    for (const timing of rules) {
      const pack = timing.rule.split("/")[0];
      packs[pack] = (packs[pack] ?? 0) + timing.ms;
    }
    console.log(
      "rule packs",
      JSON.stringify(Object.fromEntries(Object.entries(packs).sort((a, b) => b[1] - a[1]))),
    );
    console.log("slowest rules:");
    for (const timing of rules.slice(0, 20))
      console.log(`  ${String(timing.ms).padStart(7)}ms  ${timing.rule}`);
  }
}

function compare() {
  const [baseName, headName] = positionals;
  const base = loadResult(baseName);
  const head = loadResult(headName);
  const rows = [];
  const mismatches = [];
  for (const [name, entry] of Object.entries(head.corpora)) {
    for (const [scenario, value] of Object.entries(entry)) {
      const before = base.corpora[name]?.[scenario];
      if (!before) continue;
      const same = before.digest === value.digest;
      if (!same) mismatches.push({ name, scenario, before, value });
      rows.push([
        name,
        scenario,
        `${before.wallMs} → ${value.wallMs}ms`,
        delta(before.wallMs, value.wallMs),
        `${before.maxRssMb} → ${value.maxRssMb}MB`,
        `${before.diagnostics} → ${value.diagnostics}`,
        same ? "identical" : "DIFFERENT",
      ]);
    }
  }
  if (base.startup && head.startup) {
    for (const key of ["cliVersionMs", "pluginImportMs"])
      rows.push([
        "startup",
        key,
        `${base.startup[key]} → ${head.startup[key]}ms`,
        delta(base.startup[key], head.startup[key]),
        "",
        "",
        "",
      ]);
  }
  console.log(
    `Base \`${base.label}\` (${base.commit.slice(0, 7)}) vs head \`${head.label}\` (${head.commit.slice(0, 7)}), Node ${head.node}\n`,
  );
  console.log("| Corpus | Scenario | Wall (median) | Δ | Peak RSS | Diagnostics | Output |");
  console.log("|---|---|---|---:|---|---|---|");
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
  for (const mismatch of mismatches) {
    const before = new Set(mismatch.before.normalized);
    const after = new Set(mismatch.value.normalized);
    console.log(`\n${mismatch.name}/${mismatch.scenario} diagnostics differ:`);
    for (const item of before) if (!after.has(item)) console.log(`  - ${item}`);
    for (const item of after) if (!before.has(item)) console.log(`  + ${item}`);
  }
  if (mismatches.length && !values["allow-diff"]) process.exitCode = 1;
}

function loadResult(name) {
  if (!name) throw new Error("Expected a result label or path");
  const file = existsSync(name) ? name : join(resultsDir, `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function delta(before, after) {
  if (!before) return "";
  const percent = ((after - before) / before) * 100;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(0)}%`;
}

function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function log(name, scenario, value) {
  const {
    normalized: _normalized,
    ruleTimings: _rules,
    timings: _timings,
    phases,
    parsers: _parsers,
    ...rest
  } = value;
  console.log(
    `${name} ${scenario}`.trim(),
    JSON.stringify(rest),
    phases ? JSON.stringify(phases) : "",
  );
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
