import { defu } from "defu";
import { resolve } from "pathe";
import { createRouter, toRouteMatcher, type RouteMatcher } from "radix3";
import type { ProjectInfo } from "../primitives.js";

// Route rules as Nitro applies them: the rules the Nuxt module records from Nitro's resolved
// options, matched with Nitro's own matcher (radix3 `toRouteMatcher`) and merged with `defu`, most
// specific rule first, as `getRouteRulesForPath` does in nitropack's runtime.

export interface NitroRouteRules {
  cache?: false | ({ swr?: boolean; maxAge?: number; varies?: unknown } & Record<string, unknown>);
  swr?: boolean | number;
  isr?: unknown;
  prerender?: boolean;
  ssr?: boolean;
  redirect?: { to: string; statusCode?: number };
  proxy?: unknown;
  [key: string]: unknown;
}

export interface RouteRulesForRoute {
  /** The route as the framework resolved it, such as `/blog/:slug()`. */
  route: string;
  /** The rule keys that apply to every request on the route, least specific first. */
  patterns: string[];
  /** The merged rules for those keys. */
  rules: NitroRouteRules;
}

export type RouteRulesFact =
  | { state: "resolved"; routes: RouteRulesForRoute[] }
  /** The resolved pages or server handlers do not serve this file. */
  | { state: "absent" }
  | { state: "unknown"; reason: string };

export type RouteRulesProject = Pick<ProjectInfo, "root" | "nuxt">;

export type SharedCacheKind = "cache" | "swr" | "isr" | "prerender";

interface Matcher {
  rules: Map<string, NitroRouteRules>;
  matcher: RouteMatcher;
}

const ROUTE_RULES_GAP = "vite-doctor/nuxt-route-rules";
const matchers = new WeakMap<object, Matcher>();

/** Route rules for the page that `file` defines, from the pages Nuxt resolved. */
export function pageRouteRules(project: RouteRulesProject, file: string): RouteRulesFact {
  const manifest = project.nuxt?.manifest;
  if (!manifest?.hasManifest || !manifest.isCurrent || !manifest.pages?.length)
    return { state: "unknown", reason: "no current Doctor manifest records the resolved pages" };
  const target = samePath(project.root, file);
  const routes = manifest.pages
    .filter((page) => page.file && page.path && samePath(project.root, page.file) === target)
    .map((page) => page.path!);
  if (!routes.length) return { state: "absent" };
  const matcher = routeRulesMatcher(project);
  if (!matcher) return unknownRules();
  const resolved: RouteRulesForRoute[] = [];
  for (const route of new Set(routes)) {
    // Nuxt resolves nested pages relative to their parent, which the manifest does not record.
    if (!route.startsWith("/"))
      return { state: "unknown", reason: `the page route ${route} is nested under a parent page` };
    const path = samplePagePath(route);
    if (path === null)
      return {
        state: "unknown",
        reason: `the page route ${route} matches a varying number of path segments`,
      };
    resolved.push({ route, ...match(matcher, path) });
  }
  return { state: "resolved", routes: resolved };
}

/**
 * Route rules for the server handlers that `file` registers, from the handlers Nitro scanned.
 * Nitro decides whether to wrap a handler in `cachedEventHandler` from the rules for its route with
 * every param and `**` replaced by `_`, so this answers with the same sample path.
 */
export function handlerRouteRules(project: RouteRulesProject, file: string): RouteRulesFact {
  const manifest = project.nuxt?.manifest;
  if (!manifest?.hasManifest || !manifest.isCurrent || !manifest.resolvedServerHandlers)
    return {
      state: "unknown",
      reason: "no current Doctor manifest records the server handlers Nitro resolved",
    };
  const target = samePath(project.root, file);
  const routes = manifest.resolvedServerHandlers
    .filter(
      (handler) =>
        !handler.middleware && handler.route && samePath(project.root, handler.file) === target,
    )
    .map((handler) => handler.route!);
  if (!routes.length) return { state: "absent" };
  const matcher = routeRulesMatcher(project);
  if (!matcher) return unknownRules();
  return {
    state: "resolved",
    routes: [...new Set(routes)].map((route) => ({
      route,
      ...match(matcher, route.replace(/:\w+|\*\*/g, "_")),
    })),
  };
}

/**
 * Records that `file` makes per-request reads whose caching Doctor cannot decide, once per file.
 */
export function recordRouteRulesGap(
  project: Pick<ProjectInfo, "evidenceGaps">,
  file: string,
  reason: string,
) {
  const gaps = project.evidenceGaps ?? [];
  if (gaps.some((gap) => gap.source === ROUTE_RULES_GAP && gap.files?.includes(file))) return;
  project.evidenceGaps = [
    ...gaps,
    {
      source: ROUTE_RULES_GAP,
      message: `${file} reads per-request state, and Doctor cannot tell whether a route rule caches its route: ${reason}. Run Nuxt with the Doctor module to write a current .nuxt/doctor.manifest.json.`,
      files: [file],
    },
  ];
}

/** The ways the merged rules serve one response to more than one request. */
export function sharedCacheKinds(rules: NitroRouteRules): SharedCacheKind[] {
  const kinds: SharedCacheKind[] = [];
  if (rules.cache) kinds.push(rules.cache.swr ? "swr" : "cache");
  if (rules.isr) kinds.push("isr");
  if (rules.prerender === true) kinds.push("prerender");
  return kinds;
}

function match(matcher: Matcher, path: string): Omit<RouteRulesForRoute, "route"> {
  const patterns = (matcher.matcher.matchAll(path) as Array<{ key: string }>).map(
    (entry) => entry.key,
  );
  const mostSpecificFirst = patterns.toReversed().map((key) => matcher.rules.get(key)!);
  return { patterns, rules: defu({}, ...mostSpecificFirst) as NitroRouteRules };
}

function routeRulesMatcher(project: RouteRulesProject): Matcher | null {
  const source = project.nuxt?.manifest?.resolvedRouteRules;
  if (!source) return null;
  let cached = matchers.get(source);
  if (cached) return cached;
  const rules = new Map<string, NitroRouteRules>();
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") continue;
    const path = key.startsWith("/") ? key : `/${key}`;
    rules.set(path, normalizeRouteRules(value as NitroRouteRules));
  }
  const router = createRouter<{ key: string }>({
    routes: Object.fromEntries([...rules.keys()].map((key) => [key, { key }])),
  });
  cached = { rules, matcher: toRouteMatcher(router) };
  matchers.set(source, cached);
  return cached;
}

// Nitro normalizes `swr` into `cache` when it loads its options; manifests store the normalized
// rules, but normalizing again keeps rules from other sources in the same shape.
function normalizeRouteRules(input: NitroRouteRules): NitroRouteRules {
  const rules: NitroRouteRules = { ...input };
  if (input.swr) {
    rules.cache = { ...rules.cache, swr: true };
    if (typeof input.swr === "number") rules.cache.maxAge = input.swr;
  }
  if (input.cache === false) rules.cache = false;
  return rules;
}

/**
 * A concrete path that stands for every URL the page route serves, or null when the route can
 * match a varying number of segments. Each param becomes `_`, as Nitro does for handler routes.
 */
function samplePagePath(route: string): string | null {
  const segments = route.split("/").map((segment) => {
    let fixed = true;
    const sample = segment.replace(
      /:\w+(\(((?:[^()]|\([^()]*\))*)\))?([?*+])?/g,
      (_param, _group, pattern: string | undefined, modifier: string | undefined) => {
        if (modifier || (pattern && /\/|\.[*+]/.test(pattern))) fixed = false;
        return "_";
      },
    );
    return fixed ? sample : null;
  });
  return segments.includes(null) ? null : segments.join("/") || "/";
}

function samePath(root: string, file: string) {
  return resolve(root, file).replace(/\\/g, "/");
}

function unknownRules(): RouteRulesFact {
  return {
    state: "unknown",
    reason: "the Doctor manifest predates resolved route rules; regenerate it",
  };
}
