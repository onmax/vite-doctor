import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "pathe";
import { valid } from "semver";
import { parseScript } from "./script.js";
import type {
  DoctorFramework,
  NuxtCompatibilityInfo,
  NuxtDoctorManifest,
  RuntimeGraph,
  RuntimePackageInstance,
  RuntimePackageName,
  RuntimeTarget,
} from "../primitives.js";

const packageCandidates: Record<RuntimePackageName, string[]> = {
  nuxt: ["nuxt"],
  nitro: ["nitro", "nitropack"],
  h3: ["h3"],
  vue: ["vue"],
};

const acceptedIdentities: Record<RuntimePackageName, Set<string>> = {
  nuxt: new Set(["nuxt", "nuxt-nightly"]),
  nitro: new Set(["nitro", "nitropack", "nitro-nightly"]),
  h3: new Set(["h3", "h3-nightly"]),
  vue: new Set(["vue"]),
};

export function resolveRuntimeGraph(root: string, framework: DoctorFramework): RuntimeGraph {
  const rootManifest = join(root, "package.json");
  const packages: RuntimeGraph["packages"] = {};
  const edges: RuntimeGraph["edges"] = [];

  if (framework === "nuxt") {
    packages.nuxt = resolveRuntimePackage("nuxt", rootManifest, "project");
    edges.push(edge("project", packages.nuxt));
    packages.nitro =
      packages.nuxt.state === "resolved" && packages.nuxt.packageJsonPath
        ? resolveRuntimePackage("nitro", packages.nuxt.packageJsonPath, "nuxt")
        : blockedRuntime("nitro", "nuxt", packages.nuxt);
    edges.push(edge("nuxt", packages.nitro));
    packages.h3 =
      packages.nitro.state === "resolved" && packages.nitro.packageJsonPath
        ? resolveRuntimePackage("h3", packages.nitro.packageJsonPath, "nitro")
        : blockedRuntime("h3", "nitro", packages.nitro);
    edges.push(edge("nitro", packages.h3));
    packages.vue = resolveRuntimePackage("vue", rootManifest, "project");
    edges.push(edge("project", packages.vue));
  } else if (framework === "nitro") {
    packages.nitro = resolveRuntimePackage("nitro", rootManifest, "project");
    edges.push(edge("project", packages.nitro));
    packages.h3 =
      packages.nitro.state === "resolved" && packages.nitro.packageJsonPath
        ? resolveRuntimePackage("h3", packages.nitro.packageJsonPath, "nitro")
        : blockedRuntime("h3", "nitro", packages.nitro);
    edges.push(edge("nitro", packages.h3));
  } else if (framework === "vue") {
    packages.vue = resolveRuntimePackage("vue", rootManifest, "project");
    edges.push(edge("project", packages.vue));
  }

  return { packages, edges };
}

export function resolveNuxtCompatibility(
  root: string,
  graph: RuntimeGraph,
  manifest: NuxtDoctorManifest | null,
): NuxtCompatibilityInfo | undefined {
  if (!graph.packages.nuxt) return undefined;
  const config = readNuxtConfig(root);
  const manifestGeneratedAt = manifest?.generatedAt ? Date.parse(manifest.generatedAt) : Number.NaN;
  if (
    Number.isFinite(manifestGeneratedAt) &&
    isSupportedNuxtCompatibility(manifest?.compatibilityVersion) &&
    isNuxtManifestCurrent(root, manifest)
  ) {
    return {
      state: "resolved",
      version: manifest!.compatibilityVersion,
      provenance: "manifest",
    };
  }

  if (config) {
    const configured = readExportedCompatibilityVersion(config.file, config.text);
    if (configured.state === "resolved") {
      return {
        state: "resolved",
        version: configured.version,
        provenance: "config",
        file: config.file,
      };
    }
    if (configured.state === "unknown") {
      return {
        state: "unknown",
        provenance: "config",
        reason: configured.reason,
        file: config.file,
      };
    }
  }

  const nuxt = graph.packages.nuxt;
  if (nuxt.state !== "resolved" || !nuxt.version) {
    return {
      state: "unknown",
      provenance: "default",
      reason: "Nuxt compatibility defaults require a resolved Nuxt version.",
    };
  }
  return {
    state: "resolved",
    version: Number(nuxt.version.split(".")[0]) >= 5 ? 5 : 4,
    provenance: "default",
  };
}

export function isNuxtManifestCurrent(root: string, manifest: NuxtDoctorManifest | null) {
  if (!manifest?.generatedAt || !Number.isFinite(Date.parse(manifest.generatedAt))) return false;
  const config = readNuxtConfig(root);
  const configModifiedAt = config ? configModifiedTime(config.file) : undefined;
  if (configModifiedAt === undefined) return true;
  return Number.isFinite(manifest.nuxtConfigMtimeMs)
    ? manifest.nuxtConfigMtimeMs === configModifiedAt
    : Date.parse(manifest.generatedAt) >= configModifiedAt;
}

function isSupportedNuxtCompatibility(value: unknown): value is 4 | 5 {
  return value === 4 || value === 5;
}

export function applyRuntimeTarget(
  graph: RuntimeGraph,
  compatibility: NuxtCompatibilityInfo | undefined,
  target: RuntimeTarget | undefined,
): { graph: RuntimeGraph; compatibility: NuxtCompatibilityInfo | undefined } {
  if (!target) return { graph, compatibility };
  const packages = { ...graph.packages };
  for (const runtime of ["nuxt", "nitro", "h3", "vue"] as const) {
    const version = target[runtime];
    if (!version) continue;
    const current = packages[runtime];
    packages[runtime] = {
      runtime,
      state: "resolved",
      requestedName: runtime,
      name: runtime,
      version,
      owner: current?.owner ?? targetOwner(runtime),
      provenance: "target",
      identity: "exact",
    };
  }
  return {
    graph: {
      packages,
      edges: graph.edges.map((item) => ({
        ...item,
        state: packages[item.to]?.state ?? item.state,
      })),
    },
    compatibility:
      target.nuxtCompatibility === undefined
        ? compatibility
        : {
            state: "resolved",
            version: target.nuxtCompatibility,
            provenance: "target",
          },
  };
}

function resolveRuntimePackage(
  runtime: RuntimePackageName,
  ownerManifest: string,
  owner: RuntimePackageInstance["owner"],
): RuntimePackageInstance {
  const ownerPackage = readPackageManifest(ownerManifest);
  const require = createRequire(ownerManifest);
  let lastReason = `No ${runtime} package is resolvable from ${ownerManifest}.`;
  const declaredCandidates = packageCandidates[runtime].filter(
    (name) => packageDeclaration(ownerPackage, name) !== undefined,
  );
  const candidates = declaredCandidates.length ? declaredCandidates : packageCandidates[runtime];

  for (const requestedName of candidates) {
    const declaration = packageDeclaration(ownerPackage, requestedName);
    try {
      const packageJsonPath = resolvePackageJson(require, requestedName);
      const manifest = readPackageManifest(packageJsonPath);
      const name = typeof manifest?.name === "string" ? manifest.name : undefined;
      const version = typeof manifest?.version === "string" ? manifest.version : undefined;
      const identity = packageIdentity(runtime, requestedName, name);
      if (!name || !version || !valid(version)) {
        return unknownRuntime(runtime, requestedName, owner, declaration, {
          name,
          version,
          packageJsonPath,
          reason: `Resolved ${requestedName} has no valid package name and exact semver version.`,
        });
      }
      if (identity === "unknown") {
        return unknownRuntime(runtime, requestedName, owner, declaration, {
          name,
          version,
          packageJsonPath,
          reason: `Resolved ${requestedName} to unrecognized package identity ${name}.`,
        });
      }
      return {
        runtime,
        state: "resolved",
        requestedName,
        name,
        version,
        packageJsonPath,
        resolvedPath: resolvePackageEntry(require, requestedName),
        owner,
        provenance: "node-resolve",
        declaration,
        identity,
      };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  const requestedName = packageCandidates[runtime][0]!;
  return unknownRuntime(
    runtime,
    requestedName,
    owner,
    packageDeclaration(ownerPackage, requestedName),
    {
      reason: lastReason,
    },
  );
}

function resolvePackageJson(require: NodeRequire, name: string): string {
  try {
    return require.resolve(`${name}/package.json`);
  } catch {
    const entry = require.resolve(name);
    let current = dirname(entry);
    while (current !== dirname(current)) {
      const candidate = join(current, "package.json");
      const manifest = readPackageManifest(candidate);
      if (manifest?.name) return candidate;
      current = dirname(current);
    }
    throw new Error(`Could not locate package.json for ${name} from ${entry}.`);
  }
}

function resolvePackageEntry(require: NodeRequire, name: string): string | undefined {
  try {
    return require.resolve(name);
  } catch {
    return undefined;
  }
}

function packageIdentity(
  runtime: RuntimePackageName,
  requestedName: string,
  actualName: string | undefined,
): RuntimePackageInstance["identity"] {
  if (!actualName || !acceptedIdentities[runtime].has(actualName)) return "unknown";
  return actualName === requestedName ? "exact" : "alias";
}

function packageDeclaration(
  manifest: Record<string, unknown> | null,
  name: string,
): string | undefined {
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = manifest?.[key];
    if (dependencies && typeof dependencies === "object") {
      const value = (dependencies as Record<string, unknown>)[name];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

function unknownRuntime(
  runtime: RuntimePackageName,
  requestedName: string,
  owner: RuntimePackageInstance["owner"],
  declaration: string | undefined,
  details: Partial<RuntimePackageInstance>,
): RuntimePackageInstance {
  return {
    runtime,
    state: "unknown",
    requestedName,
    owner,
    provenance: "node-resolve",
    declaration,
    identity: details.identity ?? "unknown",
    ...details,
  };
}

function blockedRuntime(
  runtime: RuntimePackageName,
  owner: RuntimePackageInstance["owner"],
  ownerInstance: RuntimePackageInstance,
): RuntimePackageInstance {
  return unknownRuntime(runtime, packageCandidates[runtime][0]!, owner, undefined, {
    reason: `Cannot resolve ${runtime} because the owning ${ownerInstance.runtime} package is unresolved.`,
  });
}

function edge(from: "project" | RuntimePackageName, instance: RuntimePackageInstance) {
  return { from, to: instance.runtime, state: instance.state } as const;
}

function targetOwner(runtime: RuntimePackageName): RuntimePackageInstance["owner"] {
  if (runtime === "nitro") return "nuxt";
  if (runtime === "h3") return "nitro";
  return "project";
}

function readNuxtConfig(root: string): { file: string; text: string } | null {
  for (const extension of ["ts", "mts", "js", "mjs", "cjs", "cts"]) {
    const file = join(root, `nuxt.config.${extension}`);
    if (!existsSync(file)) continue;
    try {
      return { file, text: readFileSync(file, "utf8") };
    } catch {
      return null;
    }
  }
  return null;
}

function configModifiedTime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

type CompatibilityValue =
  | { state: "absent" }
  | { state: "resolved"; version: number }
  | { state: "unknown"; reason: string };

function readExportedCompatibilityVersion(file: string, text: string): CompatibilityValue {
  const program = parseScript(file, text) as { body?: AnyRuntimeNode[] } | null;
  if (!program) {
    return /\bfuture\s*:[\s\S]{0,200}\bcompatibilityVersion\s*:/.test(text)
      ? {
          state: "unknown",
          reason: `Doctor found future.compatibilityVersion in ${file} but could not parse the exported Nuxt config safely.`,
        }
      : { state: "absent" };
  }
  const exported = program.body?.find((node) => node.type === "ExportDefaultDeclaration");
  if (!exported) return { state: "absent" };
  let config = unwrapExpression(exported.declaration);
  if (config?.type === "CallExpression" && config.callee?.name === "defineNuxtConfig") {
    config = unwrapExpression(config.arguments?.[0]);
  }
  if (config?.type !== "ObjectExpression") {
    return {
      state: "unknown",
      reason: `The exported Nuxt config in ${file} is computed, so Doctor cannot prove the effective future.compatibilityVersion.`,
    };
  }

  const future = objectProperty(config, "future");
  if (future.state === "absent") return future;
  if (future.state === "unknown") {
    return {
      state: "unknown",
      reason: `A spread in the exported Nuxt config at ${file} may define or override future.compatibilityVersion.`,
    };
  }
  const futureObject = unwrapExpression(future.value);
  if (futureObject?.type !== "ObjectExpression") {
    return {
      state: "unknown",
      reason: `Nuxt future in ${file} is computed, so Doctor cannot prove the effective compatibilityVersion.`,
    };
  }
  const compatibility = objectProperty(futureObject, "compatibilityVersion");
  if (compatibility.state === "absent") return compatibility;
  if (compatibility.state === "unknown") {
    return {
      state: "unknown",
      reason: `A spread in Nuxt future at ${file} may define or override compatibilityVersion.`,
    };
  }
  const value = unwrapExpression(compatibility.value);
  return value?.type === "Literal" && (value.value === 4 || value.value === 5)
    ? { state: "resolved", version: value.value }
    : {
        state: "unknown",
        reason: `Nuxt future.compatibilityVersion in ${file} is not a static 4 or 5 literal.`,
      };
}

type AnyRuntimeNode = Record<string, any>;

function unwrapExpression(node: AnyRuntimeNode | undefined): AnyRuntimeNode | undefined {
  let current = node;
  while (
    current &&
    ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

function objectProperty(
  object: AnyRuntimeNode,
  name: string,
): { state: "absent" } | { state: "unknown" } | { state: "resolved"; value: AnyRuntimeNode } {
  let result:
    | { state: "absent" }
    | { state: "unknown" }
    | { state: "resolved"; value: AnyRuntimeNode } = { state: "absent" };
  for (const property of object.properties ?? []) {
    if (property.type === "SpreadElement") {
      result = { state: "unknown" };
      continue;
    }
    const key = property.key;
    const keyName = key?.name ?? key?.value;
    if (keyName === name) result = { state: "resolved", value: property.value };
  }
  return result;
}

function readPackageManifest(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(resolve(file), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
