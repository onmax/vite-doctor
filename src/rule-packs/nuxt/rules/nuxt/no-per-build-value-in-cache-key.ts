import { diagnostics } from "../../diagnostics.js";
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
import { type AnyNode, createRule, isNewDate } from "./shared.js";

const RULE_ID = "nuxt/config/no-per-build-value-in-cache-key";
// The top-level keys Nuxt drops before it hashes each local layer's config into the
// experimental.buildCache key. Everything else is hashed as written, $production and $env too.
const UNHASHED_KEYS = new Set([
  "buildId",
  "serverDir",
  "nitro",
  "devServer",
  "runtimeConfig",
  "logLevel",
  "devServerHandlers",
  "devtools",
]);
const PER_RUN_CALLS = new Set([
  "Date.now",
  "Math.random",
  "performance.now",
  "crypto.randomUUID",
  "globalThis.crypto.randomUUID",
]);
const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
// A Date read through one of these still changes on every build. Calendar getters such as
// getFullYear() change daily at most, so the cache still hits between them.
const PER_RUN_DATE_METHODS = new Set([
  "toISOString",
  "toJSON",
  "getTime",
  "valueOf",
  "toString",
  "toUTCString",
  "toLocaleString",
  "toLocaleTimeString",
  "getSeconds",
  "getMilliseconds",
  "getUTCSeconds",
  "getUTCMilliseconds",
]);
const TRUNCATING_METHODS = new Set(["slice", "substring", "substr", "split"]);

export const noPerBuildValueInCacheKey = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep per-build values out of the Nuxt build cache key",
    category: "performance",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/going-further/experimental-features#buildcache",
    requires: { script: true, nuxt: true },
    prefilter: { names: ["Date", "Math", "performance", "randomUUID"] },
  },
  create(ctx) {
    if (!/(^|\/)nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      Program(program: AnyNode) {
        const bindings = topLevelBindings(program);
        const config = exportedConfigObject(program, bindings);
        if (!config) return;
        const enabledBy = buildCacheSource(ctx.project.nuxt?.buildCache, config, bindings);
        if (!enabledBy) return;
        const findPerRun = perRunResolver(bindings, perRunMatcher(program, bindings));

        for (const { path, value } of hashedValues(config, bindings)) {
          const source = findPerRun(value);
          if (!source) continue;
          const option = path.join(".");
          ctx.report(
            diagnostics.NUXT0091({
              why: `${option} gets a new value from ${describe(source)} every time nuxt.config loads. experimental.buildCache hashes this config into its cache key, so every build computes a new key and the cached client and server bundles are never restored.`,
              fix: fixFor(path),
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "performance",
              file: ctx.file.path,
              range: ctx.range(value),
              confidence: "proven",
              evidence: [
                enabledBy === "manifest"
                  ? {
                      kind: "manifest",
                      summary: "The resolved Nuxt config enables experimental.buildCache.",
                    }
                  : { kind: "ast", summary: "nuxt.config sets experimental.buildCache to true." },
                {
                  kind: "ast",
                  summary: `${option} reads ${describe(source)} while nuxt.config loads.`,
                },
              ],
            },
          );
        }
      },
    };
  },
});

function buildCacheSource(
  resolved: boolean | undefined,
  config: AnyNode,
  bindings: Map<string, AnyNode>,
): "manifest" | "config" | null {
  if (resolved !== undefined) return resolved ? "manifest" : null;
  // `nuxt build` loads the production environment, so its override counts as well.
  const scopes = [config, objectExpression(propertyValue(config, "$production"), bindings)];
  const enabled = scopes.some((scope) => {
    const experimental = objectExpression(propertyValue(scope, "experimental"), bindings);
    const flag = unwrap(propertyValue(experimental, "buildCache"));
    return flag?.type === "Literal" && flag.value === true;
  });
  return enabled ? "config" : null;
}

function propertyValue(node: AnyNode, name: string): AnyNode {
  for (const property of node?.properties ?? []) {
    if (property.type === "Property" && propertyName(property) === name) return property.value;
  }
  return null;
}

function* hashedValues(
  node: AnyNode,
  bindings: Map<string, AnyNode>,
  parents: string[] = [],
): Generator<{ path: string[]; value: AnyNode }> {
  for (const property of node.properties ?? []) {
    if (property.type === "SpreadElement") {
      const spread = objectExpression(property.argument, bindings);
      if (spread) yield* hashedValues(spread, bindings, parents);
      continue;
    }
    if (property.type !== "Property") continue;
    const key = propertyName(property);
    if (!key || (parents.length === 0 && UNHASHED_KEYS.has(key))) continue;
    yield* hashedValue(property.value, bindings, [...parents, key]);
  }
}

function* hashedValue(
  node: AnyNode,
  bindings: Map<string, AnyNode>,
  path: string[],
): Generator<{ path: string[]; value: AnyNode }> {
  const value = unwrap(node);
  // Nuxt hashes a function by its source text, so a value it computes when called is not hashed.
  if (!value || FUNCTION_TYPES.has(value.type)) return;
  if (value.type === "ObjectExpression") {
    yield* hashedValues(value, bindings, path);
  } else if (value.type === "ArrayExpression") {
    for (const element of value.elements ?? []) {
      if (element?.type !== "SpreadElement") yield* hashedValue(element, bindings, path);
      else if (element.argument?.type === "Identifier") {
        const spread = unwrap(bindings.get(element.argument.name));
        if (spread?.type === "ArrayExpression") yield* hashedValue(spread, bindings, path);
      }
    }
  } else {
    yield { path, value: node };
  }
}

type PerRunMatcher = (node: AnyNode, shadowed: Set<string>) => boolean;

function perRunMatcher(program: AnyNode, bindings: Map<string, AnyNode>): PerRunMatcher {
  const imports = importedNames(program);
  const randomUUIDNames = new Set(
    [...imports]
      .filter(([, entry]) => CRYPTO_MODULES.has(entry.source) && entry.imported === "randomUUID")
      .map(([local]) => local),
  );
  const isGlobal = (name: string, shadowed: Set<string>) => {
    if (shadowed.has(name) || bindings.has(name)) return false;
    const imported = imports.get(name);
    return !imported || (name === "crypto" && CRYPTO_MODULES.has(imported.source));
  };

  return (node, shadowed) => {
    if (isNewDate(node)) return isGlobal("Date", shadowed) && isPerRunDateUse(node);
    if (node.type !== "CallExpression") return false;
    const callee = unwrap(node.callee);
    if (callee?.type === "Identifier") {
      return randomUUIDNames.has(callee.name) && !shadowed.has(callee.name);
    }
    const name = memberChain(callee);
    return Boolean(name && PER_RUN_CALLS.has(name) && isGlobal(name.split(".")[0]!, shadowed));
  };
}

function isPerRunDateUse(date: AnyNode): boolean {
  const member = date.__doctorParent;
  if (member?.type !== "MemberExpression" || member.object !== date) return true;
  const method = member.computed ? null : member.property?.name;
  if (!method || !PER_RUN_DATE_METHODS.has(method)) return false;
  // `new Date().toISOString().slice(0, 10)` is a calendar date, stable for a day.
  const call = member.__doctorParent;
  const next = call?.type === "CallExpression" ? call.__doctorParent : null;
  return !(
    next?.type === "MemberExpression" &&
    next.object === call &&
    TRUNCATING_METHODS.has(next.property?.name)
  );
}

function memberChain(node: AnyNode): string | null {
  if (node?.type === "Identifier") return node.name;
  if (node?.type !== "MemberExpression" || node.computed) return null;
  const object = memberChain(unwrap(node.object));
  return object && node.property?.type === "Identifier" ? `${object}.${node.property.name}` : null;
}

function importedNames(program: AnyNode): Map<string, { source: string; imported: string }> {
  const names = new Map<string, { source: string; imported: string }>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers ?? []) {
      const imported =
        specifier.type === "ImportSpecifier"
          ? (specifier.imported?.name ?? specifier.imported?.value)
          : "*";
      if (specifier.local?.name) {
        names.set(specifier.local.name, { source: statement.source?.value, imported });
      }
    }
  }
  return names;
}

function perRunResolver(bindings: Map<string, AnyNode>, isPerRun: PerRunMatcher) {
  const resolved = new Map<string, AnyNode>();
  const resolving = new Set<string>();

  const find = (root: AnyNode): AnyNode => {
    let found: AnyNode = null;
    const shadowed = FUNCTION_TYPES.has(root?.type) ? declaredNames(root) : new Set<string>();
    walkWhileLoading(root, (node) => {
      if (found) return;
      if (isPerRun(node, shadowed)) {
        found = node;
        return;
      }
      if (node.type !== "Identifier" || !bindings.has(node.name) || isNonReference(node)) return;
      if (shadowed.has(node.name)) return;
      // A function passed as a value runs later, so only a call made while config loads counts.
      if (FUNCTION_TYPES.has(unwrap(bindings.get(node.name))?.type) && !isCallee(node)) return;
      found = bindingSource(node.name);
    });
    return found;
  };

  const bindingSource = (name: string): AnyNode => {
    if (resolved.has(name)) return resolved.get(name)!;
    if (resolving.has(name)) return null;
    resolving.add(name);
    const source = find(bindings.get(name));
    resolving.delete(name);
    resolved.set(name, source);
    return source;
  };

  return find;
}

function describe(source: AnyNode): string {
  if (source.type === "NewExpression") return "new Date()";
  return `${memberChain(unwrap(source.callee)) ?? "randomUUID"}()`;
}

function fixFor(path: string[]): string {
  const [root, ...rest] = path;
  if (root === "appConfig") {
    return `Move it to runtimeConfig.public.${rest.join(".")} and read it with useRuntimeConfig().public instead of useAppConfig(). Nuxt leaves the top-level runtimeConfig out of the cache key.`;
  }
  const blockAt = path.findIndex((key) => UNHASHED_KEYS.has(key));
  if ((ENVIRONMENT_OVERRIDE_KEYS.has(root!) || root === "$env") && blockAt > 0) {
    return `Move it to the top-level ${path[blockAt]} block. Nuxt drops only the top-level ${path[blockAt]} from the cache key, so ${path.slice(0, blockAt + 1).join(".")} is still hashed.`;
  }
  return "Put the value in runtimeConfig (runtimeConfig.public for client code) and read it with useRuntimeConfig(), or replace it with a value that only changes with the source, such as the package version.";
}
