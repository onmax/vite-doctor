import { relative } from "pathe";
import pc from "picocolors";
import { formatDiagnostic } from "nostics";
import type {
  Confidence,
  Diagnostic,
  DoctorReportFormat,
  DoctorRunResult,
  RulePack,
} from "./primitives.js";
import { allDiagnosticCodesByRuleId } from "./diagnostic-code-map.js";
import { DOCTOR_DIAGNOSTICS_DOCS_BASE } from "./diagnostic-constants.js";
import { codeForRuleId } from "./diagnostics.js";

export function createTextReport(result: DoctorRunResult): string {
  const lines: string[] = [];
  const status = reportStatus(result);
  lines.push(`Detected: ${frameworkLabel(result)}`);
  lines.push(`Project: ${result.root}`);
  if (status === "incomplete") {
    lines.push("Status: incomplete, runtime evidence could not be resolved");
  }
  for (const edge of result.project.runtimeGraph?.edges ?? []) {
    const runtime = result.project.runtimeGraph?.packages[edge.to];
    const identity =
      runtime?.state === "resolved"
        ? `${runtime.name}@${runtime.version}`
        : `unknown${runtime?.reason ? ` (${runtime.reason})` : ""}`;
    lines.push(`Runtime: ${edge.from} -> ${edge.to} ${identity}`);
  }
  if (result.project.nuxtCompatibility) {
    lines.push(
      `Nuxt compatibility: ${result.project.nuxtCompatibility.state === "resolved" ? result.project.nuxtCompatibility.version : "unknown"} (${result.project.nuxtCompatibility.provenance})`,
    );
  }
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
  if (result.fixes?.edits) {
    lines.push(
      `Fixes applied: ${result.fixes.edits} edits in ${result.fixes.files} files${result.fixes.skipped ? `, ${result.fixes.skipped} skipped` : ""}`,
    );
  }
  lines.push("");
  for (const severity of ["blocker", "error", "warn", "info"] as const) {
    const items = result.diagnostics.filter((diagnostic) => diagnostic.severity === severity);
    if (!items.length) continue;
    lines.push(pc.bold(labelSeverity(severity)));
    for (const diagnostic of items) {
      const path = relative(result.root, diagnostic.file) || ".";
      const loc = diagnostic.range
        ? `${path}:${diagnostic.range.line}:${diagnostic.range.column}`
        : path;
      lines.push(indent(formatDiagnostic(diagnostic.diagnostic), "  "));
      lines.push(`    rule: ${diagnostic.ruleId}`);
      lines.push(`    source: ${loc}`);
      lines.push(`    confidence: ${diagnostic.confidence ?? "heuristic-medium"}`);
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
  for (const diagnostic of result.diagnostics) {
    const confidence = diagnostic.confidence ?? "heuristic-medium";
    if (isEvidenceBacked(confidence)) mix.proven++;
    else if (confidence === "heuristic-high") mix.probable++;
    else mix.sourceOnly++;
  }
  return mix;
}

function isEvidenceBacked(confidence: Confidence) {
  return (
    confidence === "proven" ||
    confidence === "type-backed" ||
    confidence === "manifest-backed" ||
    confidence === "runtime-backed"
  );
}

export function createJsonReport(result: DoctorRunResult): string {
  return `${JSON.stringify(
    {
      version: result.version,
      reportVersion: result.reportVersion ?? 3,
      status: reportStatus(result),
      framework: result.framework,
      root: result.root,
      scope: result.scope,
      summary: result.summary,
      diagnostics: result.diagnostics.map((diagnostic) => serializeDiagnostic(result, diagnostic)),
      suppressedDiagnostics: result.suppressedDiagnostics?.map((diagnostic) =>
        serializeDiagnostic(result, diagnostic),
      ),
      fixes: result.fixes,
      score: result.score,
      categoryScores: result.categoryScores,
      timings: result.timings,
      phases: result.phases,
      graph: result.graph,
      runtimeGraph: result.project.runtimeGraph,
      nuxtCompatibility: result.project.nuxtCompatibility,
    },
    null,
    2,
  )}\n`;
}

export function createAgentReport(result: DoctorRunResult): string {
  const status = reportStatus(result);
  return `${JSON.stringify({
    schema: "vite-doctor.agent/v1",
    status,
    project: {
      cwd: result.root,
      framework: result.framework,
    },
    scope: result.scope,
    summary: result.summary,
    diagnostics: result.diagnostics.map((diagnostic) =>
      serializeAgentDiagnostic(result, diagnostic),
    ),
    fixes: result.fixes,
    commands: {
      explain: "vite-doctor explain <code> --format agent",
      verify: "vite-doctor . --rules <rule> --format agent",
      rerun: "vite-doctor . --format agent",
    },
    next:
      status === "clean"
        ? { action: "none" }
        : status === "incomplete"
          ? {
              action: "restore-evidence",
              instruction:
                "Install project dependencies and run Doctor from the target package before relying on version-specific results.",
              cwd: result.root,
              rerun: "vite-doctor . --format agent",
            }
          : {
              action: "remediate",
              instruction:
                "Apply the smallest remediation that resolves each owned diagnostic, run its focused verification, then rerun Doctor.",
              cwd: result.root,
              rerun: "vite-doctor . --format agent",
            },
  })}\n`;
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
              name: "Vite Doctor",
              semanticVersion: result.version,
              rules: [...rules.values()].map((diagnostic) => ({
                id: diagnostic.ruleId,
                name: diagnostic.code,
                shortDescription: { text: diagnostic.code },
                helpUri: diagnosticReferenceUrl(diagnostic.code),
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
              "vite-doctor/v1": diagnostic.fingerprint,
            },
            properties: {
              confidence: diagnostic.confidence,
              diagnosticCode: diagnostic.code,
              docs: diagnosticReferenceUrl(diagnostic.code),
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

export function createReport(result: DoctorRunResult, format: DoctorReportFormat = "text"): string {
  if (format === "json") return createJsonReport(result);
  if (format === "sarif") return createSarifReport(result);
  if (format === "agent") return createAgentReport(result);
  return `${createTextReport(result)}\n`;
}

export function createRulesReport(packs: RulePack[], format: DoctorReportFormat = "text"): string {
  const rules = packs.flatMap((pack) =>
    pack.rules.map((rule) => ({
      pack: pack.name,
      version: pack.version,
      diagnosticCodes: rule.meta.diagnosticCodes ?? codeListForRule(rule.meta.id),
      ...rule.meta,
    })),
  );
  if (format === "json") return `${JSON.stringify({ rules }, null, 2)}\n`;
  if (format === "agent") {
    return `${JSON.stringify({ schema: "vite-doctor.rules/v1", status: "ready", rules })}\n`;
  }
  const lines: string[] = [];
  for (const pack of packs) {
    lines.push(pack.name);
    for (const rule of pack.rules) lines.push(`  ${rule.meta.id} ${rule.meta.severity}`);
  }
  return `${lines.join("\n")}\n`;
}

export function explainRule(
  packs: RulePack[],
  ruleId: string,
  format: DoctorReportFormat = "text",
): string {
  const match = packs
    .flatMap((pack) => pack.rules.map((rule) => ({ pack: pack.name, rule })))
    .find(
      (item) =>
        item.rule.meta.id === ruleId ||
        item.rule.meta.diagnosticCodes?.includes(ruleId) ||
        codeListForRule(item.rule.meta.id).includes(ruleId),
    );
  if (!match) return "";
  const diagnosticCodes = match.rule.meta.diagnosticCodes ?? codeListForRule(match.rule.meta.id);
  const payload = {
    pack: match.pack,
    diagnosticCodes,
    diagnostics: diagnosticCodes.map((code) => ({ code, docs: diagnosticReferenceUrl(code) })),
    ...match.rule.meta,
  };
  if (format === "json") return `${JSON.stringify(payload, null, 2)}\n`;
  if (format === "agent") {
    return `${JSON.stringify({ schema: "vite-doctor.explain/v1", status: "ready", ...payload })}\n`;
  }
  const meta = match.rule.meta;
  return (
    [
      `${meta.id} (${meta.severity})`,
      meta.title,
      meta.description,
      meta.why ? `Why: ${meta.why}` : undefined,
      meta.recommendedReplacement ? `Prefer: ${meta.recommendedReplacement}` : undefined,
      `Diagnostics: ${diagnosticCodes.join(", ")}`,
      ...diagnosticCodes.map((code) => `Docs: ${diagnosticReferenceUrl(code)}`),
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

export function reportStatus(result: DoctorRunResult): "clean" | "findings" | "incomplete" {
  const expectedRuntimes =
    result.framework === "nuxt"
      ? (["nuxt", "nitro", "h3"] as const)
      : result.framework === "nitro"
        ? (["nitro", "h3"] as const)
        : result.framework === "vue"
          ? (["vue"] as const)
          : [];
  const unresolvedRuntime = expectedRuntimes.some(
    (runtime) => result.project.runtimeGraph?.packages[runtime]?.state === "unknown",
  );
  if (unresolvedRuntime || result.project.nuxtCompatibility?.state === "unknown") {
    return "incomplete";
  }
  return result.diagnostics.length > 0 ? "findings" : "clean";
}

function serializeDiagnostic(result: DoctorRunResult, diagnostic: Diagnostic) {
  return {
    fingerprint: diagnostic.fingerprint,
    code: diagnostic.code,
    rule: diagnostic.ruleId,
    severity: diagnostic.severity,
    confidence: diagnostic.confidence ?? "heuristic-medium",
    category: diagnostic.category,
    message: diagnostic.why,
    remediation: diagnostic.diagnostic.fix,
    docs: diagnosticReferenceUrl(diagnostic.code),
    location: {
      path: relative(result.root, diagnostic.file),
      ...(diagnostic.range
        ? {
            line: diagnostic.range.line,
            column: diagnostic.range.column,
            start: diagnostic.range.start,
            end: diagnostic.range.end,
          }
        : {}),
    },
    evidence: diagnostic.evidence?.map((item) => ({
      kind: item.kind,
      summary: item.summary,
      path: item.file ? relative(result.root, item.file) : undefined,
      range: item.range,
      relatedId: item.relatedId,
    })),
    editPlan: diagnostic.fix,
    related: diagnostic.related?.map((item) => ({
      path: relative(result.root, item.file),
      range: item.range,
      message: item.message,
    })),
    suppression: diagnostic.suppressed
      ? { suppressed: true, reason: diagnostic.suppressionReason }
      : undefined,
    analysis: diagnostic.analysisPhase,
  };
}

function serializeAgentDiagnostic(result: DoctorRunResult, diagnostic: Diagnostic) {
  const evidence = diagnostic.evidence
    ?.filter((item) => item.summary !== "file analysis")
    .map((item) => ({
      kind: item.kind,
      summary: item.summary,
      path: item.file ? relative(result.root, item.file) : undefined,
      range: item.range,
      relatedId: item.relatedId,
    }));
  return {
    fingerprint: diagnostic.fingerprint,
    code: diagnostic.code,
    rule: diagnostic.ruleId,
    severity: diagnostic.severity,
    confidence: diagnostic.confidence ?? "heuristic-medium",
    location: {
      path: relative(result.root, diagnostic.file),
      line: diagnostic.range?.line,
      column: diagnostic.range?.column,
    },
    message: diagnostic.why,
    remediation: diagnostic.diagnostic.fix,
    docs: diagnosticReferenceUrl(diagnostic.code),
    evidence: evidence?.length ? evidence : undefined,
    editPlan: diagnostic.fix,
  };
}

function diagnosticReferenceUrl(code: string) {
  return `${DOCTOR_DIAGNOSTICS_DOCS_BASE}/${code}`;
}

function frameworkLabel(result: DoctorRunResult): string {
  if (result.project.framework === "nuxt")
    return `Nuxt ${result.project.nuxtVersion ?? "4"} + Vue ${result.project.vueVersion}`;
  if (result.project.framework === "vite") return "Vite";
  if (result.project.framework === "nitro") return "Nitro";
  return `Vue ${result.project.vueVersion}`;
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
