import { relative } from "pathe";
import type {
  Diagnostic,
  DoctorFramework,
  DoctorReportFormat,
  ProjectInfo,
  RuntimePackageInstance,
  RuntimePackageName,
  RuntimeTarget,
} from "./core/index.js";
import { detectProject, evaluateRuleApplicability } from "./core/index.js";
import { runViteDoctor, viteDoctorRulePacks } from "./doctor.js";
import { viteDoctorVersion } from "./version.js";

export interface MigrationReport {
  version: string;
  reportVersion: 1;
  command: "migrate";
  root: string;
  framework: DoctorFramework;
  target: {
    source: "inferred" | "explicit";
    requested: string[];
    runtime: RuntimeTarget;
  };
  applicability: {
    activated: string[];
    retained: string[];
  };
  stages: [MigrationSourceStage, MigrationDependencyStage, MigrationDeferredStage];
  summary: {
    diagnostics: number;
    errors: number;
    warnings: number;
    dependencyChanges: number;
  };
}

interface MigrationSourceStage {
  id: "source";
  title: string;
  diagnostics: MigrationDiagnostic[];
}

interface MigrationDependencyStage {
  id: "dependencies";
  title: string;
  diagnostics: MigrationDiagnostic[];
  changes: Array<{
    kind: "dependency" | "config";
    package?: string;
    /** The package.json to change, relative to the workspace root. */
    file?: string;
    from?: string;
    to: string;
    instruction: string;
  }>;
}

interface MigrationDeferredStage {
  id: "deferred";
  title: string;
  checks: Array<{ id: string; instruction: string }>;
}

interface MigrationDiagnostic {
  code: string;
  ruleId: string;
  severity: Diagnostic["severity"];
  file: string;
  range?: Diagnostic["range"];
  why: string;
  fix: string;
}

export async function createMigrationReport(
  root: string,
  requestedTargets: string[] = [],
): Promise<MigrationReport> {
  const current = await detectProject(root);
  const targetSpec = requestedTargets.length
    ? parseExplicitTargets(requestedTargets)
    : inferTarget(current);
  validateTargets(current, targetSpec.requested);
  const targetProject = await detectProject(root, current.framework, targetSpec.runtime);
  const packs = await viteDoctorRulePacks({ root, framework: current.framework });
  const activated: string[] = [];
  const retained: string[] = [];
  const migrationRuleIds: string[] = [];

  for (const rule of packs.flatMap((pack) => pack.rules)) {
    const currentState = evaluateRuleApplicability(rule, current).state;
    const targetState = evaluateRuleApplicability(rule, targetProject).state;
    if (targetState !== "active") continue;
    if (currentState === "active") retained.push(rule.meta.id);
    else activated.push(rule.meta.id);
    if (
      currentState !== "active" ||
      rule.meta.category === "migration" ||
      rule.meta.applicability
    ) {
      migrationRuleIds.push(rule.meta.id);
    }
  }

  const result = await runViteDoctor({
    root,
    framework: current.framework,
    runtimeTarget: targetSpec.runtime,
    rules: migrationRuleIds.length ? migrationRuleIds.join(",") : "__doctor_no_rules__",
    cache: false,
  });
  const diagnostics = result.diagnostics
    .filter((item) => item.ruleId !== "doctor/inventory/unresolved-runtime")
    .map((item) => migrationDiagnostic(root, item));
  const activatedRules = new Set(activated);
  const sourceDiagnostics = diagnostics.filter((item) => !activatedRules.has(item.ruleId));
  const targetDiagnostics = diagnostics.filter((item) => activatedRules.has(item.ruleId));
  const changes = dependencyChanges(current, targetSpec.requested, targetSpec.runtime);
  return {
    version: viteDoctorVersion,
    reportVersion: 1,
    command: "migrate",
    root,
    framework: current.framework,
    target: targetSpec,
    applicability: {
      activated: activated.sort(),
      retained: retained.sort(),
    },
    stages: [
      {
        id: "source",
        title: "Safe source changes before the dependency upgrade",
        diagnostics: sourceDiagnostics,
      },
      {
        id: "dependencies",
        title: "Dependency, configuration, and coupled source changes",
        diagnostics: targetDiagnostics,
        changes,
      },
      {
        id: "deferred",
        title: "Checks after the target runtime is installed",
        checks: [
          {
            id: "install-target",
            instruction: "Install the target dependency graph with the project package manager.",
          },
          ...(targetSpec.requested.includes("h3@2")
            ? [
                {
                  id: "serve-h3-app",
                  instruction:
                    "Where the app is served with createServer(toNodeListener(app)), serve it with serve(app) from h3, which runs on srvx, or replace toNodeListener with toNodeHandler.",
                },
              ]
            : []),
          {
            id: "rerun-doctor",
            instruction:
              "Run vite-doctor again without migrate so Doctor verifies the runtime versions that were actually installed.",
          },
          {
            id: "run-project-checks",
            instruction:
              "Run the project's type checks, tests, and production build on the installed target.",
          },
        ],
      },
    ],
    summary: {
      diagnostics: diagnostics.length,
      errors: diagnostics.filter((item) => item.severity === "blocker" || item.severity === "error")
        .length,
      warnings: diagnostics.filter((item) => item.severity === "warn").length,
      dependencyChanges: changes.length,
    },
  };
}

export function formatMigrationReport(
  report: MigrationReport,
  format: Exclude<DoctorReportFormat, "sarif"> = "text",
): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "agent") {
    return `${JSON.stringify({
      schema: "vite-doctor.migration/v1",
      status: report.summary.diagnostics || report.summary.dependencyChanges ? "findings" : "clean",
      ...report,
    })}\n`;
  }
  const lines = [
    `Migration target: ${report.target.requested.join(", ")} (${report.target.source})`,
    `Workspace: ${report.root}`,
    "",
  ];
  for (const stage of report.stages) {
    lines.push(stage.title);
    if (stage.id === "source") {
      if (!stage.diagnostics.length) lines.push("  No source changes detected.");
      for (const diagnostic of stage.diagnostics) {
        const location = diagnostic.range
          ? `${diagnostic.file}:${diagnostic.range.line}:${diagnostic.range.column}`
          : diagnostic.file;
        lines.push(`  ${diagnostic.code} ${location}`);
        lines.push(`    ${diagnostic.why}`);
        lines.push(`    Fix: ${diagnostic.fix}`);
      }
    } else if (stage.id === "dependencies") {
      if (!stage.changes.length && !stage.diagnostics.length) {
        lines.push("  No dependency, config, or coupled source changes inferred.");
      }
      for (const change of stage.changes) lines.push(`  ${change.instruction}`);
      for (const diagnostic of stage.diagnostics) {
        const location = diagnostic.range
          ? `${diagnostic.file}:${diagnostic.range.line}:${diagnostic.range.column}`
          : diagnostic.file;
        lines.push(`  ${diagnostic.code} ${location}`);
        lines.push(`    ${diagnostic.why}`);
        lines.push(`    Fix with the target upgrade: ${diagnostic.fix}`);
      }
    } else {
      for (const check of stage.checks) lines.push(`  ${check.instruction}`);
    }
    lines.push("");
  }
  lines.push(
    `Summary: ${report.summary.diagnostics} diagnostics, ${report.summary.dependencyChanges} dependency/config changes`,
  );
  return `${lines.join("\n")}\n`;
}

function inferTarget(project: ProjectInfo): MigrationReport["target"] {
  const nuxt = project.runtimeGraph?.packages.nuxt;
  const nitro = project.runtimeGraph?.packages.nitro;
  if (project.framework === "nuxt" && nuxt?.state === "resolved" && major(nuxt.version) < 5) {
    return targetFromRequested(["nuxt@5"], "inferred");
  }
  if (
    (project.framework === "nuxt" || project.framework === "nitro") &&
    nitro?.state === "resolved" &&
    major(nitro.version) < 3
  ) {
    return targetFromRequested(["nitro@3"], "inferred");
  }
  if (
    (project.runtimeGraph?.packages.h3?.owner ?? "project") === "project" &&
    projectH3Packages(project).some(({ h3 }) => h3.state === "resolved" && major(h3.version) < 2)
  ) {
    return targetFromRequested(["h3@2"], "inferred");
  }
  throw new Error(
    "Doctor cannot infer one supported next runtime target from the installed graph. Pass --to nuxt@5, --to nitro@3, or --to h3@2.",
  );
}

function parseExplicitTargets(targets: string[]): MigrationReport["target"] {
  return targetFromRequested(
    targets
      .flatMap((target) => target.split(","))
      .map((target) => target.trim())
      .filter(Boolean),
    "explicit",
  );
}

function validateTargets(project: ProjectInfo, targets: string[]): void {
  const framework = project.framework;
  for (const target of targets) {
    if (target === "h3@2") {
      validateH3Target(project);
      continue;
    }
    const supported =
      target === "nuxt@5"
        ? framework === "nuxt"
        : target === "nitro@3" && (framework === "nuxt" || framework === "nitro");
    if (!supported) {
      throw new Error(`Migration target ${target} is not supported for ${framework} projects.`);
    }
  }
}

function validateH3Target(project: ProjectInfo): void {
  const runH3 = project.runtimeGraph?.packages.h3;
  // The target applies to the whole run graph, so Nitro's h3 would be evaluated as v2 too.
  if (runH3 && runH3.owner !== "project") {
    throw new Error(
      `Migration target h3@2 is not supported for ${project.framework} projects: Nitro provides h3. Use --to nitro@3, which moves Nitro to h3 v2.`,
    );
  }
  const packages = projectH3Packages(project);
  if (!packages.length) {
    throw new Error(
      `Migration target h3@2 is not supported for ${project.framework} projects that do not declare h3.`,
    );
  }
  if (!packages.some(({ h3 }) => needsH3Upgrade(h3))) {
    throw new Error(
      `Migration target h3@2 is not supported: h3 is already ${packages.map(({ h3 }) => h3.version).join(", ")}.`,
    );
  }
}

/** Workspace packages that declare and run their own h3, outside Nitro and Nuxt. */
function projectH3Packages(
  project: ProjectInfo,
): Array<{ root: string; h3: RuntimePackageInstance }> {
  return (project.workspacePackages ?? []).flatMap((item) => {
    if (!item.declaredRuntimes?.includes("h3")) return [];
    const h3 = (project.workspaceRuntimeGraphs?.[item.root] ?? project.runtimeGraph)?.packages.h3;
    return h3?.owner === "project" ? [{ root: item.root, h3 }] : [];
  });
}

function needsH3Upgrade(h3: RuntimePackageInstance): boolean {
  return h3.state !== "resolved" || !(major(h3.version) >= 2);
}

function targetFromRequested(
  requested: string[],
  source: "inferred" | "explicit",
): MigrationReport["target"] {
  const runtime: RuntimeTarget = {};
  for (const target of requested) {
    if (target === "nuxt@5") {
      runtime.nuxt = "5.0.0-0";
      runtime.nitro = "3.0.0-0";
      runtime.h3 = "2.0.0-0";
      runtime.nuxtCompatibility = 5;
      continue;
    }
    if (target === "nitro@3") {
      runtime.nitro = "3.0.0-0";
      runtime.h3 = "2.0.0-0";
      continue;
    }
    if (target === "h3@2") {
      runtime.h3 = "2.0.0-0";
      continue;
    }
    throw new Error(`Unsupported migration target "${target}". Use nuxt@5, nitro@3, or h3@2.`);
  }
  if (!requested.length) throw new Error("Migration requires at least one target.");
  return { source, requested, runtime };
}

function dependencyChanges(
  project: ProjectInfo,
  requested: string[],
  runtime: RuntimeTarget,
): MigrationDependencyStage["changes"] {
  const changes: MigrationDependencyStage["changes"] = [];
  for (const target of requested) {
    if (target === "h3@2") {
      changes.push(...h3DependencyChanges(project));
      continue;
    }
    const [runtimeName, targetMajor] = target.split("@") as [RuntimePackageName, string];
    const current = project.runtimeGraph?.packages[runtimeName];
    const packageName =
      runtimeName === "nitro" && current?.name === "nitropack" ? "nitro" : runtimeName;
    changes.push({
      kind: "dependency",
      package: packageName,
      from: current?.version,
      to: `${packageName}@${targetMajor}`,
      instruction: `Update ${current?.name ?? packageName}${current?.version ? ` from ${current.version}` : ""} to ${packageName}@${targetMajor}.`,
    });
  }
  if (runtime.nuxtCompatibility === 5 && project.nuxtCompatibility?.version !== 5) {
    const unknownCompatibility = project.nuxtCompatibility?.state === "unknown";
    changes.push({
      kind: "config",
      to: "future.compatibilityVersion: 5",
      instruction: unknownCompatibility
        ? "Verify that the effective future.compatibilityVersion resolves to 5; Doctor could not prove it from the composed Nuxt config."
        : "Set future.compatibilityVersion to 5 while preparing the Nuxt upgrade, then resolve the reported compatibility diagnostics.",
    });
  }
  return changes;
}

function h3DependencyChanges(project: ProjectInfo): MigrationDependencyStage["changes"] {
  return projectH3Packages(project)
    .filter(({ h3 }) => needsH3Upgrade(h3))
    .map(({ root, h3 }) => {
      const file = root === "." ? "package.json" : `${root}/package.json`;
      const from = h3.state === "resolved" ? h3.version : h3.declaration;
      return {
        kind: "dependency",
        package: "h3",
        file,
        from,
        to: "h3@2",
        instruction: `Update ${h3.name ?? "h3"}${from ? ` from ${from}` : ""} to h3@2 in ${file}.`,
      };
    });
}

function migrationDiagnostic(root: string, diagnostic: Diagnostic): MigrationDiagnostic {
  return {
    code: diagnostic.code,
    ruleId: diagnostic.ruleId,
    severity: diagnostic.severity,
    file: relative(root, diagnostic.file),
    range: diagnostic.range,
    why: diagnostic.why,
    fix: diagnostic.suggestion ?? diagnostic.diagnostic.fix ?? "Review this migration diagnostic.",
  };
}

function major(version: string | undefined): number {
  return Number(version?.split(".")[0] ?? Number.NaN);
}
