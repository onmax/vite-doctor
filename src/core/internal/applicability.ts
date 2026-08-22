import { satisfies, valid, validRange } from "semver";
import type {
  ApplicabilityState,
  DoctorRule,
  ProjectInfo,
  RulePack,
  RuntimePackageName,
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
  if (!pack.activation) return active();
  if (pack.activation.nuxt && project.framework !== "nuxt") {
    return inactive(`Rule Pack ${pack.name} requires a Nuxt project.`);
  }
  const results: ApplicabilityResult[] = [];
  if (pack.activation.nuxt) {
    results.push(evaluateRuntimeRange(project, "nuxt", pack.activation.nuxt));
  }

  if (pack.activation.languages?.length) {
    const languages = new Set(project.languages ?? []);
    const matched = pack.activation.languages.some((language) => languages.has(language));
    results.push(
      matched ? active() : inactive(`Rule Pack ${pack.name} language activation did not match.`),
    );
  }

  const hasPackageOrModuleConstraints = Boolean(
    pack.activation.packages?.length || pack.activation.modules?.length,
  );
  if (hasPackageOrModuleConstraints) {
    const moduleNames = new Set((project.nuxt?.modules ?? []).map((module) => module.name));
    const matched =
      pack.activation.packages?.some((name) => moduleNames.has(name)) ||
      pack.activation.modules?.some((name) => moduleNames.has(name));
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
