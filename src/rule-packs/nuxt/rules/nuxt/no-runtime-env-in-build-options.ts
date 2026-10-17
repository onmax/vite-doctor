import { type AnyNode, createRule, walkScriptLocal } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/config/no-runtime-env-in-build-options";
const RUNTIME_ENV_PREFIXES = ["NUXT_", "NITRO_"];
const WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ParenthesizedExpression",
]);
const ENVIRONMENT_OVERRIDE_KEYS = new Set(["$production", "$development", "$test"]);
const FUNCTION_TYPES = new Set([
  "FunctionExpression",
  "ArrowFunctionExpression",
  "FunctionDeclaration",
]);

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
        const config = exportedConfigObject(program, bindings);
        if (!config) return;
        const runtimeEnvKeys = new Map<string, string>();
        collectRuntimeConfigKeys(config, bindings, runtimeEnvKeys);
        if (!runtimeEnvKeys.size) return;
        const readsFor = envReadsResolver(bindings);

        for (const { path, value } of buildOptionValues(config, bindings)) {
          const reads = readsFor(value);
          if (reads.opaque || !reads.names.size) continue;
          const names = [...reads.names];
          if (!names.every(isRuntimeEnvName)) continue;
          const overridden = names
            .map((name) => ({ name, key: runtimeEnvKeys.get(stripRuntimePrefix(name)) }))
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

function topLevelBindings(program: AnyNode): Map<string, AnyNode> {
  const bindings = new Map<string, AnyNode>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id?.type === "Identifier" && declarator.init) {
          bindings.set(declarator.id.name, declarator.init);
        }
      }
    } else if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      bindings.set(declaration.id.name, declaration);
    }
  }
  return bindings;
}

function exportedConfigObject(program: AnyNode, bindings: Map<string, AnyNode>): AnyNode {
  const exported = program.body?.find(
    (statement: AnyNode) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  let config = unwrap(exported);
  if (config?.type === "Identifier" && isDefineNuxtConfig(unwrap(bindings.get(config.name)))) {
    config = unwrap(bindings.get(config.name));
  }
  if (isDefineNuxtConfig(config)) {
    config = unwrap(config.arguments?.[0]);
  }
  return objectExpression(config, bindings);
}

function isDefineNuxtConfig(node: AnyNode): boolean {
  return node?.type === "CallExpression" && node.callee?.name === "defineNuxtConfig";
}

function objectExpression(node: AnyNode, bindings: Map<string, AnyNode>): AnyNode {
  const value = unwrap(node);
  if (value?.type === "ObjectExpression") return value;
  if (value?.type === "Identifier") {
    const bound = unwrap(bindings.get(value.name));
    if (bound?.type === "ObjectExpression") return bound;
  }
  return null;
}

// Only the places Nuxt reads runtime config from: the root, environment overrides, and nitro.
function collectRuntimeConfigKeys(
  node: AnyNode,
  bindings: Map<string, AnyNode>,
  keys: Map<string, string>,
) {
  for (const property of node?.properties ?? []) {
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    const value = objectExpression(property.value, bindings);
    if (!key || !value) continue;
    if (key === "runtimeConfig") collectDeclaredKeys(value, [], bindings, keys);
    else if (key === "nitro" || ENVIRONMENT_OVERRIDE_KEYS.has(key)) {
      collectRuntimeConfigKeys(value, bindings, keys);
    } else if (key === "$env") {
      for (const environment of value.properties ?? []) {
        if (environment.type === "Property") {
          collectRuntimeConfigKeys(objectExpression(environment.value, bindings), bindings, keys);
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
    if (!key || key === "runtimeConfig") continue;
    yield* buildOptionValue(property.value, bindings, [...parents, key]);
  }
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
      if (element && element.type !== "SpreadElement") {
        yield* buildOptionValue(element, bindings, path);
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
    walkScriptLocal(root, (node) => {
      if (isProcessEnv(node)) {
        const name = envMemberName(node.__doctorParent, node);
        if (name) reads.names.add(name);
        else reads.opaque = true;
        return;
      }
      if (node.type !== "Identifier" || !bindings.has(node.name) || isNonReference(node)) return;
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

function isCallee(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  return parent?.type === "CallExpression" && parent.callee === node;
}

function isNonReference(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return true;
  }
  if (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) {
    return true;
  }
  return false;
}

function isRuntimeEnvName(name: string): boolean {
  return RUNTIME_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function stripRuntimePrefix(name: string): string {
  const prefix = RUNTIME_ENV_PREFIXES.find((candidate) => name.startsWith(candidate)) ?? "";
  return name.slice(prefix.length);
}

// Mirrors how Nuxt maps runtimeConfig paths to NUXT_ variables: snakeCase(path).toUpperCase().
function envKey(path: string[]): string {
  return path
    .map((segment) =>
      segment
        .replace(/([a-z\d])([A-Z])/g, "$1_$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
        .replace(/[-\s]+/g, "_"),
    )
    .join("_")
    .toUpperCase();
}

function propertyName(property: AnyNode): string | null {
  const key = property.key;
  if (!property.computed && key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  if (key?.type === "TemplateLiteral" && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current && WRAPPER_TYPES.has(current.type)) current = current.expression;
  return current;
}
