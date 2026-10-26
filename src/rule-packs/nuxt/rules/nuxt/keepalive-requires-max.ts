import { resolve } from "pathe";
import { parseScriptScope } from "../../../../core/internal/script-scope.js";
import type { DiagnosticEvidence, RuleContext } from "../../../../core/index.js";
import { FUNCTION_TYPES, propertyName, unwrap } from "./nuxt-config-ast.js";
import {
  type AnyNode,
  createRule,
  nuxtPagePath,
  resolveSameFile,
  resolveLocalCalleeName,
  sourceForNode,
} from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/routing/keepalive-requires-max";
// Params that name one of a few configured values, such as i18n locales, cannot grow the cache.
const BOUNDED_PARAMS = new Set(["locale", "lang", "language"]);
const FILE_PARAM_RE = /\[{1,2}(?:\.{3})?([^[\]]+)\]{1,2}/g;
const ROUTE_PARAM_RE = /:(\w+)/g;
const PARAM_BEARING_ROUTE_FIELDS = new Set(["fullPath", "path", "href"]);

interface RouteParams {
  names: string[];
  evidence: DiagnosticEvidence;
}

export const keepaliveRequiresMax = createRule({
  meta: {
    id: RULE_ID,
    title: "Bound keepalive caches on pages with route params",
    category: "performance",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/built-ins/keep-alive.html#max-cached-instances",
    requires: { script: true, nuxt: true },
    prefilter: { calls: ["definePageMeta"] },
  },
  create(ctx) {
    const pagePath = nuxtPagePath(ctx);
    if (!pagePath || !ctx.file.isVueSfc) return;
    return {
      CallExpression(node: AnyNode) {
        if (resolveLocalCalleeName(ctx, node) !== "definePageMeta") return;
        const meta = unwrap(node.arguments?.[0]);
        if (meta?.type !== "ObjectExpression") return;
        const properties = staticProperties(meta);
        if (!properties) return;
        const keepalive = properties.get("keepalive");
        if (!keepalive || !isUnboundedKeepalive(unwrap(keepalive.value))) return;

        const params = routeParams(ctx, pagePath, properties.get("path")?.value);
        const routeUnbounded = params?.names.filter(
          (name) => !BOUNDED_PARAMS.has(name.toLowerCase()),
        );
        if (!params || !routeUnbounded?.length) return;
        const key = properties.get("key")?.value;
        // A key that is not a function, or that Doctor cannot follow, may collapse the params.
        const unbounded = key
          ? keptParams(sourceForNode(key, ctx.file.text), routeUnbounded)
          : routeUnbounded;
        if (!unbounded) return;

        const listed = unbounded.map((name) => `:${name}`).join(", ");
        ctx.report(
          diagnostics.NUXT0094({
            why: `This page sets keepalive without max, and its page key includes the route param${unbounded.length > 1 ? "s" : ""} ${listed}. Nuxt caches one page instance per distinct key in a <KeepAlive> that never evicts without max, so each ${listed} value a user visits leaves a mounted instance behind, with its watchers, effects and data, and none is ever evicted.`,
            fix: "Bound the cache with keepalive: { max: N } so Vue evicts the least recently used instance, or set a definePageMeta key that does not read the route params, such as a static string, so one instance is reused across param values.",
          }),
          {
            ruleId: RULE_ID,
            severity: ctx.severity,
            category: "performance",
            file: ctx.file.path,
            range: ctx.range(keepalive),
            confidence: "heuristic-high",
            evidence: [
              params.evidence,
              {
                kind: "ast",
                summary: key
                  ? `definePageMeta sets keepalive without max and a key function that returns ${listed}.`
                  : "definePageMeta sets keepalive without max and no key, so Nuxt keys the page by its interpolated route path.",
              },
            ],
          },
        );
      },
    };
  },
});

function staticProperties(object: AnyNode): Map<string, AnyNode> | null {
  const properties = new Map<string, AnyNode>();
  for (const property of object.properties ?? []) {
    // A spread or computed key may set keepalive, key or path to values Doctor cannot see.
    if (property.type !== "Property") return null;
    const name = propertyName(property);
    if (!name) return null;
    properties.set(name, property);
  }
  return properties;
}

function isUnboundedKeepalive(value: AnyNode): boolean {
  if (value?.type === "Literal") return value.value === true;
  if (value?.type !== "ObjectExpression") return false;
  const properties = staticProperties(value);
  // exclude can leave this page out of the cache, so only a plain options object is proven.
  return !!properties && !properties.has("max") && !properties.has("exclude");
}

function routeParams(ctx: RuleContext, pagePath: string, metaPath: AnyNode): RouteParams | null {
  const manifest = ctx.project.nuxt?.manifest;
  if (manifest?.isCurrent && manifest.pages?.length) {
    const routes = manifest.pages.filter(
      (page) =>
        page.file &&
        page.path &&
        resolveSameFile(
          resolve(ctx.project.root, page.file),
          resolve(ctx.project.root, ctx.file.path),
        ),
    );
    if (!routes.length) return null;
    const paths = [...new Set(routes.map((route) => route.path!))];
    return {
      names: [...new Set(paths.flatMap((path) => matches(path, ROUTE_PARAM_RE)))],
      evidence: {
        kind: "manifest",
        summary: `Nuxt resolves this page to ${paths.join(", ")}.`,
      },
    };
  }
  if (metaPath) {
    const value = unwrap(metaPath);
    if (value?.type !== "Literal" || typeof value.value !== "string") return null;
    return {
      names: matches(value.value, ROUTE_PARAM_RE),
      evidence: { kind: "ast", summary: `definePageMeta sets the route path to ${value.value}.` },
    };
  }
  return {
    names: matches(pagePath, FILE_PARAM_RE),
    evidence: {
      kind: "facts",
      summary: `The file-based route pages/${pagePath} has dynamic segments.`,
    },
  };
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

/**
 * The unbounded params a definePageMeta key returns. Null when the key collapses them, or when
 * Doctor cannot follow it: only a returned route path, full path or named param counts.
 */
function keptParams(source: string, unbounded: string[]): string[] | null {
  try {
    const { ast, scopeManager, visitorKeys } = parseScriptScope(`(${source})`, {
      sourceType: "module",
    });
    const key = unwrap((ast.body[0] as AnyNode)?.expression);
    const parameter = key?.params?.[0];
    if (!FUNCTION_TYPES.has(key?.type) || parameter?.type !== "Identifier") return null;
    const variable = scopeManager
      .acquire(key, true)
      ?.variables.find((entry) => entry.identifiers.includes(parameter));
    const route = new Set(variable?.references.map((reference) => reference.identifier));
    const kept = new Set<string>();

    const collect = (node: AnyNode) => {
      const value = unwrap(node);
      if (value?.type === "TemplateLiteral") value.expressions.forEach(collect);
      if (value?.type === "BinaryExpression" && value.operator === "+") {
        collect(value.left);
        collect(value.right);
      }
      if (value?.type !== "MemberExpression" || value.computed) return;
      const field = value.property?.name;
      const owner = unwrap(value.object);
      if (route.has(owner)) {
        if (PARAM_BEARING_ROUTE_FIELDS.has(field)) unbounded.forEach((name) => kept.add(name));
      } else if (
        owner?.type === "MemberExpression" &&
        !owner.computed &&
        route.has(unwrap(owner.object)) &&
        owner.property?.name === "params" &&
        unbounded.includes(field)
      ) {
        kept.add(field);
      }
    };
    const collectReturns = (node: AnyNode) => {
      if (!node || FUNCTION_TYPES.has(node.type)) return;
      if (node.type === "ReturnStatement") return collect(node.argument);
      for (const name of visitorKeys[node.type] ?? []) {
        const child = node[name];
        if (Array.isArray(child)) child.forEach(collectReturns);
        else collectReturns(child);
      }
    };
    if (key.body.type === "BlockStatement") collectReturns(key.body);
    else collect(key.body);
    return kept.size ? unbounded.filter((name) => kept.has(name)) : null;
  } catch {
    return null;
  }
}
