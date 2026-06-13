import { relative } from "pathe";
import pc from "picocolors";
import { formatDiagnostic } from "nostics";
import type { Diagnostic, DoctorRunResult, RulePack } from "./primitives.js";
import { allDiagnosticCodesByRuleId } from "./diagnostic-code-map.js";
import { codeForRuleId } from "./diagnostics.js";

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
      lines.push(indent(formatDiagnostic(diagnostic.diagnostic), "  "));
      lines.push(`    rule: ${diagnostic.ruleId}`);
      lines.push(`    source: ${loc}`);
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
      diagnostics: result.diagnostics.map(serializeDiagnostic),
      suppressedDiagnostics: result.suppressedDiagnostics?.map(serializeDiagnostic),
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
                name: diagnostic.code,
                shortDescription: { text: diagnostic.code },
                properties: {
                  diagnosticCode: diagnostic.code,
                  category: diagnostic.category,
                  confidence: diagnostic.confidence,
                  analysisPhase: diagnostic.analysisPhase,
                },
              })),
            },
          },
          results: result.diagnostics.map((diagnostic) => ({
            ruleId: diagnostic.ruleId,
            rule: { id: diagnostic.ruleId },
            level: sarifLevel(diagnostic.severity),
            message: { text: diagnostic.why },
            partialFingerprints: {
              "vue-doctor/v1": diagnostic.fingerprint,
              "vue-doctor/v2": diagnostic.fingerprint,
            },
            properties: {
              confidence: diagnostic.confidence,
              diagnosticCode: diagnostic.code,
              docs: diagnostic.docs,
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
    pack.rules.map((rule) => ({
      pack: pack.name,
      version: pack.version,
      diagnosticCodes: rule.meta.diagnosticCodes ?? codeListForRule(rule.meta.id),
      ...rule.meta,
    })),
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
    .find(
      (item) =>
        item.rule.meta.id === ruleId ||
        item.rule.meta.diagnosticCodes?.includes(ruleId) ||
        codeListForRule(item.rule.meta.id).includes(ruleId),
    );
  if (!match) return format === "json" ? `${JSON.stringify({ rule: null }, null, 2)}\n` : "";
  const payload = {
    pack: match.pack,
    diagnosticCodes: match.rule.meta.diagnosticCodes ?? codeListForRule(match.rule.meta.id),
    ...match.rule.meta,
  };
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
      `Diagnostics: ${(meta.diagnosticCodes ?? codeListForRule(meta.id)).join(", ")}`,
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

function codeListForRule(ruleId: string): string[] {
  const code = codeForRuleId(allDiagnosticCodesByRuleId, ruleId);
  return code ? [code] : [];
}

function indent(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function serializeDiagnostic(diagnostic: Diagnostic) {
  return {
    code: diagnostic.code,
    name: diagnostic.diagnostic.name,
    why: diagnostic.why,
    fix: diagnostic.diagnostic.fix,
    docs: diagnostic.docs,
    sources: diagnostic.sources,
    ruleId: diagnostic.ruleId,
    severity: diagnostic.severity,
    category: diagnostic.category,
    file: diagnostic.file,
    range: diagnostic.range,
    suggestion: diagnostic.suggestion,
    fixPlan: diagnostic.fix,
    related: diagnostic.related,
    tags: diagnostic.tags,
    fingerprint: diagnostic.fingerprint,
    suppressed: diagnostic.suppressed,
    suppressionReason: diagnostic.suppressionReason,
    confidence: diagnostic.confidence,
    evidence: diagnostic.evidence,
    fixGroupId: diagnostic.fixGroupId,
    analysisPhase: diagnostic.analysisPhase,
    cacheHit: diagnostic.cacheHit,
  };
}
