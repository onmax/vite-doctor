import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "./doctor-api.mjs";
import { oxlintRuleId, portedRules } from "./rule-map.mjs";

/** oxlint ships through vite-plus; `node_modules/.bin/oxlint` is the vite-plus LSP wrapper. */
export function resolveOxlint() {
  const fromRoot = createRequire(join(repoRoot, "package.json"));
  const fromVitePlus = createRequire(fromRoot.resolve("vite-plus/package.json"));
  const packageJson = fromVitePlus.resolve("oxlint/package.json");
  return {
    bin: join(dirname(packageJson), "bin/oxlint"),
    version: fromVitePlus(packageJson).version,
  };
}

/**
 * Writes an oxlint config that disables every built-in rule and enables only the ported Doctor
 * Rules that Doctor itself activated for the corpus. The config lives in a temp dir so repo
 * linting never loads it as a nested config.
 */
export function writeOxlintConfig({ inventory, doctorRules, noop = false, rust = false }) {
  const dir = mkdtempSync(join(tmpdir(), "vd-oxlint-host-"));
  const inventoryFile = join(dir, "inventory.json");
  writeFileSync(inventoryFile, JSON.stringify({ projects: inventory.settings.doctor.projects }));
  const rules = noop
    ? { "doctor/noop": "warn" }
    : Object.fromEntries(
        portedRules
          .filter((rule) => doctorRules.includes(rule.doctor))
          .map((rule) => [oxlintRuleId(rule), "warn"]),
      );
  const config = join(dir, ".oxlintrc.json");
  // Reference point from #197: oxlint's default native plugins with `correctness`, no JS plugins.
  if (rust) {
    writeFileSync(config, JSON.stringify({ categories: { correctness: "warn" } }));
    return config;
  }
  writeFileSync(
    config,
    JSON.stringify(
      {
        plugins: [],
        jsPlugins: [join(import.meta.dirname, "plugin.mjs")],
        categories: { correctness: "off" },
        settings: { doctor: { inventoryFile } },
        rules,
      },
      null,
      2,
    ),
  );
  return config;
}
