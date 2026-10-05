import { createRequire, registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const output = process.env.PERF_LAB_PROBE_OUT;
const tracing = process.env.PERF_LAB_TRACE_PARSERS === "1";
const parsers = {};

function record(parser, file, ms) {
  const entry = (parsers[parser] ??= { count: 0, ms: 0, files: {} });
  entry.count++;
  entry.ms += ms;
  if (typeof file === "string" && file) {
    const key = isAbsolute(file) ? file : resolve(process.env.PERF_LAB_CORPUS ?? ".", file);
    entry.files[key] = (entry.files[key] ?? 0) + 1;
  }
}

if (tracing) {
  globalThis.__perfLabRecord = record;
  globalThis.__perfLabTs = (ts) =>
    function createSourceFile(...args) {
      const started = performance.now();
      try {
        return ts.createSourceFile(...args);
      } finally {
        record("typescript", args[0], performance.now() - started);
      }
    };

  // oxc-parser and the TypeScript call sites are ESM or getter-only exports, so they are
  // rewritten at load time instead of patched after import.
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.includes("/oxc-parser/") && url.endsWith("/src-js/index.js")) {
        const source = String(result.source).replace(
          "export function parseSync(",
          "function __perfLabParseSync(",
        );
        return {
          ...result,
          source: `${source}
export function parseSync(filename, text, options) {
  const started = performance.now();
  try { return __perfLabParseSync(filename, text, options); }
  finally { globalThis.__perfLabRecord("oxc", filename, performance.now() - started); }
}`,
        };
      }
      if (
        (url.includes("/typescript-estree/") ||
          url.includes("/vite-doctor/dist/") ||
          url.includes(process.env.PERF_LAB_DOCTOR_DIST ?? "\0")) &&
        result.source &&
        String(result.source).includes("ts.createSourceFile(")
      ) {
        return {
          ...result,
          source: String(result.source).replaceAll(
            "ts.createSourceFile(",
            "globalThis.__perfLabTs(ts)(",
          ),
        };
      }
      return result;
    },
  });

  const require = createRequire(`${process.env.PERF_LAB_DOCTOR}/package.json`);
  const wrap = (target, key, parser, fileOf) => {
    const original = target?.[key];
    if (typeof original !== "function") return;
    target[key] = function (...args) {
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        record(parser, fileOf(args), performance.now() - started);
      }
    };
  };
  const tryRequire = (name) => {
    try {
      return require(name);
    } catch {
      return undefined;
    }
  };
  wrap(tryRequire("@vue/compiler-sfc"), "parse", "compiler-sfc", (args) => args[1]?.filename);
  wrap(
    tryRequire("vue-eslint-parser"),
    "parseForESLint",
    "vue-eslint-parser",
    (args) => args[1]?.filePath,
  );
  wrap(tryRequire("eslint")?.Linter?.prototype, "verify", "eslint", (args) => args[2]?.filename);
}

if (output) {
  process.on("exit", () => {
    const usage = process.resourceUsage();
    writeFileSync(
      output,
      JSON.stringify({
        maxRssMb: Math.round(usage.maxRSS / 1024),
        userMs: Math.round(usage.userCPUTime / 1000),
        systemMs: Math.round(usage.systemCPUTime / 1000),
        parsers: tracing ? parsers : undefined,
      }),
    );
  });
}
