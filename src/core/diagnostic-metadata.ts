import type { DoctorSeverity } from "./primitives.js";

export type WorkspaceDiagnosticAnalysis = "graph" | "dead-code" | "dupes" | "health";

interface DiagnosticMetadata {
  code: string;
  title: string;
  description: string;
  why: string;
  fix: string;
  ruleId: string;
  severity: Exclude<DoctorSeverity, "blocker">;
  category: string;
}

interface WorkspaceDiagnosticMetadata extends DiagnosticMetadata {
  analysis: WorkspaceDiagnosticAnalysis;
}

export const defaultConfigDiagnosticMetadata = {
  code: "DOC0038",
  ruleId: "doctor/config/default-config-file",
  title: "Review the default doctor.config.json",
  description: "This automatically discovered doctor.config.json only restates Doctor's defaults.",
  why: "Doctor activates Rule Packs from project dependencies and does not require a config file. This Diagnostic is only reported when this run's settings are the same without the file. It cannot see scripts or CI jobs that pass the file with --config.",
  fix: "doctor.config.json restates Doctor's defaults; delete it unless a script or CI job passes it with --config. Add a Doctor config only when it changes rules, per-path overrides, suppressions, include or exclude globs, or Config Extends presets.",
  severity: "info",
  category: "config",
} as const satisfies DiagnosticMetadata;

export const resolvedBaselineDiagnosticMetadata = {
  code: "DOC0039",
  ruleId: "doctor/baseline/resolved-entries",
  title: "Remove resolved baseline entries",
  description:
    "A full `--new-only` run found baseline entries whose file Rule no longer reports their fingerprint.",
  why: "A resolved entry hides nothing today, but if the same finding comes back, `--new-only` hides it again. Doctor requires Rule and file metadata and a full run covering that file (or proof the file no longer exists). Changed-file runs, Rule selections, analyses-only runs, baseline updates, and severity thresholds above `info` never report this Diagnostic. Entries from project-scoped Rules, workspace Rules and analyses, and Rules that are disabled, partial, or inactive are not reported.",
  fix: "Delete only the fingerprints listed in the Diagnostic's evidence from the baseline. Leave the other entries in place and commit the updated baseline.",
  severity: "info",
  category: "baseline",
} as const satisfies DiagnosticMetadata;

export const workspaceDiagnosticMetadata = [
  {
    code: "DOC0001",
    title: "Break a circular dependency",
    description: "Two or more source files belong to a cycle in the workspace dependency graph.",
    why: "Doctor found a strongly connected group of files through static imports or re-exports. A change to one cycle member can affect the others, and module initialization may depend on evaluation order. Dynamic imports do not create a cycle for this analysis.",
    fix: "Inspect the primary file and related cycle members. Move shared declarations into a module that does not import its consumers, or remove an unnecessary dependency. Rerun the graph analysis to confirm the cycle is gone.",
    ruleId: "workspace/dead-code/circular-dependency",
    severity: "warn",
    category: "architecture",
    analysis: "graph",
  },
  {
    code: "DOC0002",
    title: "Review a repeated export name",
    description: "The same named export appears in two or more workspace files.",
    why: "Doctor's workspace export index contains multiple owners for one name. Default exports and export-star markers are excluded. This is a name-level review signal; separate modules can legally export the same name, so it does not prove an ambiguous JavaScript import.",
    fix: "Review the files listed in the diagnostic. Consolidate duplicate implementations or choose more specific export names when they represent different concepts. If the repeated name is intentional, keep the exports and configure a scoped suppression.",
    ruleId: "workspace/dead-code/duplicate-export",
    severity: "warn",
    category: "architecture",
    analysis: "graph",
  },
  {
    code: "DOC0003",
    title: "Declare an imported dependency",
    description:
      "A scanned import, re-export, or literal dynamic import names an undeclared package.",
    why: "Doctor compares package references with dependencies, devDependencies, peerDependencies, and optionalDependencies in discovered package.json files. Recognized Node built-ins, hash-prefixed imports, and known tooling exclusions do not require a dependency declaration.",
    fix: "Add the package to the appropriate dependency field in package.json, or remove the unused import. Check the owning package when running in a workspace, and verify that custom aliases are represented correctly before treating them as external packages.",
    ruleId: "workspace/dead-code/unlisted-dependency",
    severity: "warn",
    category: "dead-code",
    analysis: "dead-code",
  },
  {
    code: "DOC0004",
    title: "Resolve a local source import",
    description: "A local source import has no matching file in Doctor's workspace graph.",
    why: "Doctor could not match a local import, re-export, or literal dynamic import to a scanned source file. Recognized asset and generated imports are excluded. This diagnosis reflects Doctor's source inventory and resolution rules; custom host resolution can require additional evidence.",
    fix: "Correct the import path or add the missing source file. If the host resolves the import successfully, check source exclusions, generated files, and aliases before changing working application code. Run Doctor with the project's Plugin Surface when host inventory is needed.",
    ruleId: "workspace/dead-code/unresolved-import",
    severity: "error",
    category: "dead-code",
    analysis: "dead-code",
  },
  {
    code: "DOC0005",
    title: "Review an apparently unused dependency",
    description: "A runtime dependency has no package reference in scanned source files.",
    why: "Doctor found no static import, re-export, or literal dynamic import for this runtime dependency. This is a heuristic: package scripts, runtime loading, host configuration, or source outside the scan can still use the package.",
    fix: "Check package scripts, configuration, dynamic loading, and excluded source before removing the dependency. Remove it from package.json only if it is unused. Keep a required dependency and configure a scoped suppression when its use cannot be represented in the source graph.",
    ruleId: "workspace/dead-code/unused-dependency",
    severity: "info",
    category: "dead-code",
    analysis: "dead-code",
  },
  {
    code: "DOC0006",
    title: "Review an unreachable value export",
    description: "A named value export has no known reverse reference and its file is unreachable.",
    why: "Doctor found neither a name-level import or call reference for this export nor a path from a recognized project entrypoint to its file. Default exports, export-star markers, and recognized type surfaces are excluded. Consumers outside the analyzed project are not evidence of reachability.",
    fix: "Remove an unused export, import it from reachable code, or expose its file through the correct package entrypoint. Check external consumers and host conventions before removing public APIs. Use a scoped suppression when the known use is outside Doctor's inventory.",
    ruleId: "workspace/dead-code/unused-export",
    severity: "info",
    category: "dead-code",
    analysis: "dead-code",
  },
  {
    code: "DOC0007",
    title: "Review an unreachable source file",
    description: "Doctor found no path to a source file from recognized project entrypoints.",
    why: "Doctor follows imports and re-exports from package entrypoints, framework conventions, and available manifest roots. The file is outside that reachable graph. Recognized tests, config files, type surfaces, and excluded foreign-framework files are skipped. Unrecognized host conventions or computed runtime imports can hide real uses.",
    fix: "Remove the file only after checking runtime loading and external consumers. Otherwise import it from a reachable entrypoint or correct the package entrypoint or host inventory. Use a scoped suppression for an intentional entrypoint that Doctor cannot yet identify.",
    ruleId: "workspace/dead-code/unused-file",
    severity: "info",
    category: "dead-code",
    analysis: "dead-code",
  },
  {
    code: "DOC0008",
    title: "Review an unreachable type export",
    description: "A named type export has no known reverse reference and its file is unreachable.",
    why: "Doctor found an exported type in a source file that is not reachable from recognized roots, with no name-level reverse reference. Recognized type surfaces, including .d.ts files and types directories, are excluded. The analysis does not prove that consumers outside the project have stopped using a public type.",
    fix: "Remove a private unused type, import it from reachable code, or expose its source through the appropriate package type entrypoint. Check downstream consumers before removing a public type. Use a scoped suppression when its intended use is outside the analyzed project.",
    ruleId: "workspace/dead-code/unused-type-export",
    severity: "info",
    category: "dead-code",
    analysis: "dead-code",
  },
  {
    code: "DOC0009",
    title: "Review repeated token sequences",
    description: "Two or more source files contain a matching normalized token window.",
    why: "Doctor hashes windows of 30 tokens at 10-token intervals after normalizing numeric values. A shared hash identifies a possible clone across files. This heuristic does not establish equivalent behavior or require the entire files to match.",
    fix: "Compare the primary file with the related files. Extract shared behavior when the copies should evolve together. Keep independent implementations when their duplication is intentional and configure a scoped suppression if needed.",
    ruleId: "workspace/duplication/exact-clone",
    severity: "info",
    category: "duplication",
    analysis: "dupes",
  },
  {
    code: "DOC0010",
    title: "Review file-level branch complexity",
    description: "A source file has a cyclomatic complexity score of at least 15.",
    why: "Doctor starts the file score at one and counts branch syntax such as conditionals, loops, logical expressions, switch cases, and catch clauses. The threshold applies to the whole file, not an individual function. It is a maintenance heuristic, not a runtime performance measurement.",
    fix: "Inspect the branches and their tests. Split independent responsibilities into smaller modules or simplify unnecessary branching while preserving behavior. Retain complex logic when it is justified, with focused tests and a scoped suppression if needed.",
    ruleId: "workspace/health/high-cyclomatic-complexity",
    severity: "warn",
    category: "health",
    analysis: "health",
  },
  {
    code: "DOC0011",
    title: "Review a file with many imports",
    description: "A source file contains at least 20 static import declarations.",
    why: "Doctor counts static import declarations in a file, including type imports. This is not a count of unique packages or runtime dependencies; repeated declarations from the same source count separately. A high count is a coupling heuristic, not a build-size or performance result.",
    fix: "Review whether the file combines unrelated responsibilities. Consolidate repeated imports and move cohesive behavior into smaller modules where that clarifies ownership. Keep necessary imports when the file's role justifies them, and configure a scoped suppression if needed.",
    ruleId: "workspace/health/high-fan-out",
    severity: "info",
    category: "health",
    analysis: "health",
  },
] as const satisfies readonly WorkspaceDiagnosticMetadata[];

const explainableMetadata: Array<DiagnosticMetadata & { analysis?: WorkspaceDiagnosticAnalysis }> =
  [
    ...workspaceDiagnosticMetadata,
    defaultConfigDiagnosticMetadata,
    resolvedBaselineDiagnosticMetadata,
  ];

export const diagnosticMetadataByCode = new Map(
  explainableMetadata.map((metadata) => [metadata.code, metadata] as const),
);

export const diagnosticMetadataByRuleId = new Map(
  explainableMetadata.map((metadata) => [metadata.ruleId, metadata] as const),
);
