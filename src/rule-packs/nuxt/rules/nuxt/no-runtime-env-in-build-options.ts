import {
  ENVIRONMENT_OVERRIDE_KEYS,
  FUNCTION_TYPES,
  declaredNames,
  exportedConfigObject,
  isCallee,
  isNonReference,
  objectExpression,
  propertyName,
  topLevelBindings,
  unwrap,
  walkWhileLoading,
} from "./nuxt-config-ast.js";
import { type AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/config/no-runtime-env-in-build-options";
const RUNTIME_ENV_PREFIXES = ["NUXT_", "NITRO_"];

interface EnvReads {
  names: Set<string>;
  /** The value also depends on a build-time source Doctor cannot rule out. */
  opaque: boolean;
}

export const noRuntimeEnvInBuildOptions = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not freeze runtime config environment variables into build options",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/going-further/runtime-config#environment-variables",
    requires: { script: true, nuxt: true },
    prefilter: { names: ["runtimeConfig"] },
  },
  create(ctx) {
    if (!/(^|\/)nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      Program(program: AnyNode) {
        const bindings = topLevelBindings(program);
        // A local `process` is not Node's global, so its `env` reads prove nothing.
        if (bindings.has("process") || importsLocalProcess(program)) return;
        const config = exportedConfigObject(program, bindings);
        if (!config) return;
        const runtimeEnvKeys = {
          nuxt: new Map<string, string>(),
          nitro: new Map<string, string>(),
        };
        collectRuntimeConfigKeys(config, bindings, runtimeEnvKeys, "nuxt");
        if (!runtimeEnvKeys.nuxt.size && !runtimeEnvKeys.nitro.size) return;
        const readsFor = envReadsResolver(bindings);

        for (const { path, value } of buildOptionValues(config, bindings)) {
          const reads = readsFor(value);
          if (reads.opaque || !reads.names.size) continue;
          const names = [...reads.names];
          if (!names.every(isRuntimeEnvName)) continue;
          const overridden = names
            .map((name) => ({ name, key: runtimeConfigKey(name, runtimeEnvKeys) }))
            .find((entry): entry is { name: string; key: string } => Boolean(entry.key));
          if (!overridden) continue;
          ctx.report(
            diagnostics.NUXT0090({
              why: `${path} reads ${overridden.name} when nuxt.config loads, so the build keeps its build-time value. At runtime ${overridden.name} overrides runtimeConfig.${overridden.key}, but not ${path}, and a deployment that sets it only at runtime gets the stale value.`,
              fix: `Read runtimeConfig.${overridden.key} with useRuntimeConfig() where the value is used, or pass ${overridden.name} to the build when ${path} must be fixed at build time.`,
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "runtime-config",
              file: ctx.file.path,
              range: ctx.range(value),
            },
          );
        }
      },
    };
  },
});

function importsLocalProcess(program: AnyNode): boolean {
  return (program.body ?? []).some((statement: AnyNode) => {
    if (statement.type !== "ImportDeclaration") return false;
    const source = statement.source?.value;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name !== "process") continue;
      if (!["process", "node:process"].includes(source)) return true;
      if (specifier.type !== "ImportDefaultSpecifier") return true;
    }
    return false;
  });
}

// Only the places Nuxt reads runtime config from: the root, environment overrides, and nitro.
function collectRuntimeConfigKeys(
  node: AnyNode,
  bindings: Map<string, AnyNode>,
  keys: { nuxt: Map<string, string>; nitro: Map<string, string> },
  owner: "nuxt" | "nitro",
) {
  for (const property of node?.properties ?? []) {
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    const value = objectExpression(property.value, bindings);
    if (!key || !value) continue;
    if (key === "runtimeConfig") {
      collectDeclaredKeys(value, [], bindings, keys[owner]);
    } else if (key === "nitro") {
      collectRuntimeConfigKeys(value, bindings, keys, "nitro");
    } else if (ENVIRONMENT_OVERRIDE_KEYS.has(key)) {
      collectRuntimeConfigKeys(value, bindings, keys, "nuxt");
    } else if (key === "$env") {
      for (const environment of value.properties ?? []) {
        if (environment.type === "Property") {
          collectRuntimeConfigKeys(
            objectExpression(environment.value, bindings),
            bindings,
            keys,
            "nuxt",
          );
        }
      }
    }
  }
}

function collectDeclaredKeys(
  node: AnyNode,
  parents: string[],
  bindings: Map<string, AnyNode>,
  keys: Map<string, string>,
) {
  for (const property of node.properties ?? []) {
    if (property.type === "SpreadElement") {
      const spread = objectExpression(property.argument, bindings);
      if (spread) collectDeclaredKeys(spread, parents, bindings, keys);
      continue;
    }
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    if (!key) continue;
    const path = [...parents, key];
    keys.set(envKey(path), path.join("."));
    const nested = objectExpression(property.value, bindings);
    if (nested) collectDeclaredKeys(nested, path, bindings, keys);
  }
}

function* buildOptionValues(
  node: AnyNode,
  bindings: Map<string, AnyNode>,
  parents: string[] = [],
): Generator<{ path: string; value: AnyNode }> {
  for (const property of node.properties ?? []) {
    if (property.type === "SpreadElement") {
      const spread = objectExpression(property.argument, bindings);
      if (spread) yield* buildOptionValues(spread, bindings, parents);
      continue;
    }
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    if (!key || (key === "runtimeConfig" && isRuntimeConfigOwner(parents))) continue;
    yield* buildOptionValue(property.value, bindings, [...parents, key]);
  }
}

function isRuntimeConfigOwner(path: string[]): boolean {
  let rest = path;
  if (rest[0] && ENVIRONMENT_OVERRIDE_KEYS.has(rest[0])) rest = rest.slice(1);
  else if (rest[0] === "$env" && rest.length >= 2) rest = rest.slice(2);
  return rest.length === 0 || (rest.length === 1 && rest[0] === "nitro");
}

function* buildOptionValue(
  node: AnyNode,
  bindings: Map<string, AnyNode>,
  path: string[],
): Generator<{ path: string; value: AnyNode }> {
  const value = unwrap(node);
  if (!value || FUNCTION_TYPES.has(value.type)) return;
  if (value.type === "ObjectExpression") {
    yield* buildOptionValues(value, bindings, path);
  } else if (value.type === "ArrayExpression") {
    for (const element of value.elements ?? []) {
      if (element?.type !== "SpreadElement") yield* buildOptionValue(element, bindings, path);
      else if (element.argument?.type === "Identifier") {
        const spread = unwrap(bindings.get(element.argument.name));
        if (spread?.type === "ArrayExpression") yield* buildOptionValue(spread, bindings, path);
      }
    }
  } else {
    yield { path: path.join("."), value: node };
  }
}

function envReadsResolver(bindings: Map<string, AnyNode>) {
  const resolved = new Map<string, EnvReads>();
  const resolving = new Set<string>();

  const readsFor = (root: AnyNode): EnvReads => {
    const reads: EnvReads = { names: new Set(), opaque: false };
    const shadowed = FUNCTION_TYPES.has(root?.type) ? declaredNames(root) : new Set<string>();
    walkWhileLoading(root, (node) => {
      if (isProcessEnv(node)) {
        const name = envMemberName(node.__doctorParent, node);
        if (name) reads.names.add(name);
        else reads.opaque = true;
        return;
      }
      if (node.type !== "Identifier" || !bindings.has(node.name) || isNonReference(node)) return;
      if (shadowed.has(node.name)) return;
      // A function passed as a value reads the environment when it runs, not when config loads.
      if (FUNCTION_TYPES.has(unwrap(bindings.get(node.name))?.type) && !isCallee(node)) return;
      const bound = bindingReads(node.name);
      for (const name of bound.names) reads.names.add(name);
      reads.opaque ||= bound.opaque;
    });
    return reads;
  };

  const bindingReads = (name: string): EnvReads => {
    const cached = resolved.get(name);
    if (cached) return cached;
    if (resolving.has(name)) return { names: new Set(), opaque: false };
    resolving.add(name);
    const reads = readsFor(bindings.get(name));
    resolving.delete(name);
    resolved.set(name, reads);
    return reads;
  };

  return readsFor;
}

function isProcessEnv(node: AnyNode): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === "process" &&
    node.property?.name === "env"
  );
}

function envMemberName(parent: AnyNode, env: AnyNode): string | null {
  if (parent?.type !== "MemberExpression" || parent.object !== env) return null;
  if (!parent.computed && parent.property?.type === "Identifier") return parent.property.name;
  const property = parent.property;
  if (property?.type === "Literal" && typeof property.value === "string") return property.value;
  if (property?.type === "TemplateLiteral" && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function runtimeConfigKey(
  name: string,
  keys: { nuxt: Map<string, string>; nitro: Map<string, string> },
): string | undefined {
  if (name.startsWith("NUXT_")) return keys.nuxt.get(name.slice("NUXT_".length));
  if (name.startsWith("NITRO_")) return keys.nitro.get(name.slice("NITRO_".length));
  return undefined;
}

function isRuntimeEnvName(name: string): boolean {
  return RUNTIME_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Nitro maps runtimeConfig paths to env names with scule: snakeCase(path.join("_")).toUpperCase().
function envKey(path: string[]): string {
  return splitByCase(path.join("_")).join("_").toUpperCase();
}

// A port of scule's splitByCase, so acronym and digit boundaries match Nitro exactly.
function splitByCase(value: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let previousUpper: boolean | undefined;
  let previousSplitter: boolean | undefined;
  for (const char of value) {
    if (["-", "_", "/", "."].includes(char)) {
      parts.push(buffer);
      buffer = "";
      previousUpper = undefined;
      continue;
    }
    const isUpper = /\d/.test(char) ? undefined : char !== char.toLowerCase();
    if (previousSplitter === false) {
      if (previousUpper === false && isUpper === true) {
        parts.push(buffer);
        buffer = char;
        previousUpper = isUpper;
        continue;
      }
      if (previousUpper === true && isUpper === false && buffer.length > 1) {
        parts.push(buffer.slice(0, -1));
        buffer = buffer.at(-1) + char;
        previousUpper = isUpper;
        continue;
      }
    }
    buffer += char;
    previousUpper = isUpper;
    previousSplitter = false;
  }
  parts.push(buffer);
  return parts;
}
