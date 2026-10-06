import { satisfies, valid, validRange } from "semver";
import type {
  ApplicabilityState,
  DoctorRule,
  ProjectInfo,
  RulePack,
  RuntimePackageName,
  WorkspacePackage,
} from "../primitives.js";

export interface ApplicabilityResult {
  state: ApplicabilityState;
  reasons: string[];
}

export function evaluateRuleApplicability(
  rule: DoctorRule,
  project: ProjectInfo,
): ApplicabilityResult {
  const requirements = {
    ...rule.meta.frameworkVersions,
    ...rule.meta.applicability?.runtimes,
  } as Partial<Record<RuntimePackageName, string>>;
  const results = Object.entries(requirements).map(([runtime, range]) =>
    evaluateRuntimeRange(
      project,
      runtime as RuntimePackageName,
      range,
      rule.meta.applicability?.includePrerelease,
    ),
  );

  const compatibilityRange = rule.meta.applicability?.nuxtCompatibility;
  if (compatibilityRange) {
    results.push(evaluateNuxtCompatibility(project, compatibilityRange));
  }
  return combineApplicability(results);
}

export function evaluatePackActivation(pack: RulePack, project: ProjectInfo): ApplicabilityResult {
  if (pack.activation === false)
    return inactive(`Rule Pack ${pack.name} requires explicit preset selection.`);
  const results = projectWorkspacePackages(project).map((item) =>
    evaluateWorkspacePackageActivation(pack, project, item),
  );
  return (
    results.find((result) => result.state === "active") ??
    results.find((result) => result.state === "unknown") ?? {
      state: "inactive",
      reasons: [...new Set(results.flatMap((result) => result.reasons))],
    }
  );
}

/** Roots of the workspace packages whose Project Inventory activates `pack`. */
export function activatingWorkspacePackages(pack: RulePack, project: ProjectInfo): string[] {
  if (pack.activation === false) return [];
  return projectWorkspacePackages(project)
    .filter((item) => evaluateWorkspacePackageActivation(pack, project, item).state === "active")
    .map((item) => item.root);
}

export function projectWorkspacePackages(project: ProjectInfo): WorkspacePackage[] {
  return (
    project.workspacePackages ?? [
      {
        root: ".",
        framework: project.framework,
        packages: (project.inventory?.packages ?? {}) as Record<string, string>,
      },
    ]
  );
}

function evaluateWorkspacePackageActivation(
  pack: RulePack,
  project: ProjectInfo,
  workspacePackage: WorkspacePackage,
): ApplicabilityResult {
  const activation = pack.activation;
  if (!activation) return active();
  if (activation.frameworks && !activation.frameworks.includes(workspacePackage.framework)) {
    return inactive(
      `Rule Pack ${pack.name} requires a ${activation.frameworks.join(" or ")} workspace package.`,
    );
  }
  if (activation.nuxt && workspacePackage.framework !== "nuxt") {
    return inactive(`Rule Pack ${pack.name} requires a Nuxt project.`);
  }
  const results: ApplicabilityResult[] = [];
  if (activation.nuxt) {
    results.push(evaluateRuntimeRange(project, "nuxt", activation.nuxt));
  }

  if (activation.languages?.length) {
    const languages = new Set(project.languages ?? []);
    const matched = activation.languages.some((language) => languages.has(language));
    results.push(
      matched ? active() : inactive(`Rule Pack ${pack.name} language activation did not match.`),
    );
  }

  if (activation.packages?.length || activation.modules?.length) {
    const moduleNames = new Set((project.nuxt?.modules ?? []).map((module) => module.name));
    const packageNames = new Set(Object.keys(workspacePackage.packages));
    const matched =
      activation.packages?.some((name) => moduleNames.has(name) || packageNames.has(name)) ||
      activation.modules?.some((name) => moduleNames.has(name));
    results.push(
      matched
        ? active()
        : inactive(`Rule Pack ${pack.name} package or module activation did not match.`),
    );
  }
  return combineApplicability(results);
}

export function evaluateRuntimeRange(
  project: ProjectInfo,
  runtime: RuntimePackageName,
  range: string,
  includePrerelease = false,
): ApplicabilityResult {
  if (!validRange(range)) return unknown(`Invalid ${runtime} applicability range ${range}.`);
  const instance = project.runtimeGraph?.packages[runtime];
  if (!instance || instance.state !== "resolved" || !instance.version || !valid(instance.version)) {
    return unknown(instance?.reason ?? `The ${runtime} runtime is unresolved.`);
  }
  return satisfies(instance.version, range, { includePrerelease })
    ? active()
    : inactive(`${runtime} ${instance.version} does not satisfy ${range}.`);
}

function evaluateNuxtCompatibility(project: ProjectInfo, range: string): ApplicabilityResult {
  if (!validRange(range)) return unknown(`Invalid Nuxt compatibility range ${range}.`);
  const compatibility = project.nuxtCompatibility;
  if (compatibility?.state !== "resolved" || compatibility.version === undefined) {
    return unknown(compatibility?.reason ?? "Nuxt compatibility behavior is unresolved.");
  }
  const version = `${compatibility.version}.0.0`;
  return satisfies(version, range)
    ? active()
    : inactive(`Nuxt compatibility ${compatibility.version} does not satisfy ${range}.`);
}

function combineApplicability(results: ApplicabilityResult[]): ApplicabilityResult {
  if (!results.length) return active();
  const inactiveResults = results.filter((item) => item.state === "inactive");
  if (inactiveResults.length) {
    return { state: "inactive", reasons: inactiveResults.flatMap((item) => item.reasons) };
  }
  const unknownResults = results.filter((item) => item.state === "unknown");
  if (unknownResults.length) {
    return { state: "unknown", reasons: unknownResults.flatMap((item) => item.reasons) };
  }
  return active();
}

function active(): ApplicabilityResult {
  return { state: "active", reasons: [] };
}

function inactive(reason: string): ApplicabilityResult {
  return { state: "inactive", reasons: [reason] };
}

function unknown(reason: string): ApplicabilityResult {
  return { state: "unknown", reasons: [reason] };
}
