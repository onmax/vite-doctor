import { relative } from "pathe";
import pc from "picocolors";
import type { Diagnostic, DoctorRunResult, RulePack } from "./primitives.js";

export function createTextReport(result: DoctorRunResult): string {
  const lines: string[] = [];
  lines.push(`Detected: ${frameworkLabel(result)}`);
  lines.push(`Workspace: ${result.root}`);
  lines.push(`Health score: ${result.score}/100`);
  if (result.project.nuxt?.manifest) {
    const evidence = result.project.nuxt.manifest.evidence;
    lines.push(
      `Evidence used: manifest ${result.project.nuxt.manifest.hasManifest ? "present" : "missing"}, route graph ${evidence?.routeGraph ? "present" : "missing"}, build manifest ${evidence?.buildManifest ? "present" : "missing"}, ${evidence?.prerenderRoutes ?? 0} prerender routes, ${evidence?.serverRoutes ?? 0} server routes`,
    );
  }
  const confidence = confidenceMix(result);
  lines.push(
    `Confidence mix: ${confidence.proven} proven, ${confidence.probable} probable, ${confidence.sourceOnly} source-only`,
  );
  lines.push("");
  for (const severity of ["blocker", "error", "warn", "info"] as const) {
    const items = result.diagnostics.filter((d) => d.severity === severity);
    if (!items.length) continue;
    lines.push(pc.bold(labelSeverity(severity)));
    for (const diagnostic of items) {
      const loc = diagnostic.range
        ? `${diagnostic.file}:${diagnostic.range.line}:${diagnostic.range.column}`
        : diagnostic.file;
      lines.push(`  ${diagnostic.ruleId}`);
      lines.push(`    ${loc}`);
      lines.push(`    ${diagnostic.message}`);
      if (diagnostic.suggestion) lines.push(`    Fix: ${diagnostic.suggestion}`);
    }
    lines.push("");
  }
  lines.push("Summary");
  lines.push(
    `  ${result.summary.blocker} blockers, ${result.summary.error} errors, ${result.summary.warn} warnings, ${result.summary.info} info`,
  );
  lines.push(`  ${result.summary.fixable} safe fixes available`);
  if (result.timings) {
    lines.push("");
    lines.push("Timings");
    for (const [name, ms] of Object.entries(result.timings)) lines.push(`  ${name}: ${ms}ms`);
  }
  if (result.graph) {
    lines.push("");
    lines.push("Graph");
    lines.push(
      `  ${result.graph.files} files, ${result.graph.importEdges} imports, ${result.graph.exportEdges} exports, ${result.graph.virtualRoots} roots, ${result.graph.cycles} cycles`,
    );
  }
  return lines.join("\n");
}

function confidenceMix(result: DoctorRunResult) {
  const mix = { proven: 0, probable: 0, sourceOnly: 0 };
  const hasBuildEvidence = Boolean(result.project.nuxt?.manifest?.evidence?.buildManifest);
  for (const diagnostic of result.diagnostics) {
    if (
      diagnostic.severity === "info" ||
      (!hasBuildEvidence &&
        diagnostic.severity === "warn" &&
        /(?:browser-global|time-dependent|random-or-local-time)/.test(diagnostic.ruleId))
    )
      mix.sourceOnly++;
    else if (diagnostic.severity === "blocker" || diagnostic.severity === "error") mix.proven++;
    else mix.probable++;
  }
  return mix;
}

export function createJsonReport(result: DoctorRunResult): string {
  return `${JSON.stringify(
    {
      version: result.version,
      reportVersion: result.reportVersion ?? 2,
      framework: result.framework,
      root: result.root,
      score: result.score,
      categoryScores: result.categoryScores,
      summary: result.summary,
      diagnostics: result.diagnostics,
      suppressedDiagnostics: result.suppressedDiagnostics,
      timings: result.timings,
      phases: result.phases,
      graph: result.graph,
    },
    null,
    2,
  )}\n`;
}

export function createSarifReport(result: DoctorRunResult): string {
  const rules = new Map<string, Diagnostic>();
  for (const diagnostic of result.diagnostics) rules.set(diagnostic.ruleId, diagnostic);
  return `${JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: doctorName(result),
              semanticVersion: result.version,
              rules: [...rules.values()].map((diagnostic) => ({
                id: diagnostic.ruleId,
                name: diagnostic.ruleId,
                shortDescription: { text: diagnostic.ruleId },
                properties: {
                  category: diagnostic.category,
                  confidence: diagnostic.confidence,
                  analysisPhase: diagnostic.analysisPhase,
                },
              })),
            },
          },
          results: result.diagnostics.map((diagnostic) => ({
            ruleId: diagnostic.ruleId,
            level: sarifLevel(diagnostic.severity),
            message: { text: diagnostic.message },
            partialFingerprints: {
              "vue-doctor/v1": diagnostic.fingerprint,
              "vue-doctor/v2": diagnostic.fingerprint,
            },
            properties: {
              confidence: diagnostic.confidence,
              evidenceKinds: diagnostic.evidence?.map((item) => item.kind),
              analysisPhase: diagnostic.analysisPhase,
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: relative(result.root, diagnostic.file) },
                  region: diagnostic.range
                    ? {
                        startLine: diagnostic.range.line,
                        startColumn: diagnostic.range.column,
                      }
                    : undefined,
                },
              },
            ],
            relatedLocations: diagnostic.related?.map((item) => ({
              physicalLocation: {
                artifactLocation: { uri: relative(result.root, item.file) },
                region: item.range
                  ? { startLine: item.range.line, startColumn: item.range.column }
                  : undefined,
              },
              message: { text: item.message },
            })),
          })),
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function frameworkLabel(result: DoctorRunResult): string {
  if (result.project.framework === "nuxt")
    return `Nuxt ${result.project.nuxtVersion ?? "4"} + Vue ${result.project.vueVersion}`;
  if (result.project.framework === "vite") return "Vite";
  if (result.project.framework === "nitro") return "Nitro";
  return `Vue ${result.project.vueVersion}`;
}

function doctorName(result: DoctorRunResult): string {
  if (result.framework === "nuxt") return "Nuxt Doctor";
  if (result.framework === "vite") return "Vite Doctor";
  if (result.framework === "nitro") return "Nitro Doctor";
  return "Vue Doctor";
}

export function createReport(result: DoctorRunResult, format = "text"): string {
  if (format === "json") return createJsonReport(result);
  if (format === "sarif") return createSarifReport(result);
  return `${createTextReport(result)}\n`;
}

export function createRulesReport(packs: RulePack[], format = "text"): string {
  const rules = packs.flatMap((pack) =>
    pack.rules.map((rule) => ({ pack: pack.name, version: pack.version, ...rule.meta })),
  );
  if (format === "json") return `${JSON.stringify({ rules }, null, 2)}\n`;
  const lines: string[] = [];
  for (const pack of packs) {
    lines.push(pack.name);
    for (const rule of pack.rules) lines.push(`  ${rule.meta.id} ${rule.meta.severity}`);
  }
  return `${lines.join("\n")}\n`;
}

export function explainRule(packs: RulePack[], ruleId: string, format = "text"): string {
  const match = packs
    .flatMap((pack) => pack.rules.map((rule) => ({ pack: pack.name, rule })))
    .find((item) => item.rule.meta.id === ruleId);
  if (!match) return format === "json" ? `${JSON.stringify({ rule: null }, null, 2)}\n` : "";
  const payload = { pack: match.pack, ...match.rule.meta };
  if (format === "json") return `${JSON.stringify(payload, null, 2)}\n`;
  const meta = match.rule.meta;
  return (
    [
      `${meta.id} (${meta.severity})`,
      meta.title,
      meta.description,
      meta.why ? `Why: ${meta.why}` : undefined,
      meta.recommendedReplacement ? `Prefer: ${meta.recommendedReplacement}` : undefined,
      meta.docsUrl ? `Docs: ${meta.docsUrl}` : undefined,
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

function sarifLevel(severity: Diagnostic["severity"]) {
  if (severity === "blocker" || severity === "error") return "error";
  if (severity === "warn") return "warning";
  return "note";
}

function labelSeverity(severity: string): string {
  return severity === "blocker"
    ? "Blockers"
    : severity === "error"
      ? "Errors"
      : severity === "warn"
        ? "Warnings"
        : "Info";
}
