import type { RuleContext } from "../../../../core/index.js";
import { holdsRequestValue, unwrapExpression } from "../../../../core/internal/request-values.js";
import {
  type NitroRouteRules,
  pageRouteRules,
  recordRouteRulesGap,
  type SharedCacheKind,
  sharedCacheKinds,
} from "../../../../core/internal/route-rules.js";
import { findStatementBinding } from "../../../../core/internal/script-index.js";
import { isEventRequestRead } from "../../../nitro/rules/request-helpers.js";
import { importedName } from "./module-scope-state.js";
import {
  type AnyNode,
  classifyExecutionEvidence,
  createRule,
  isClientOnlyPath,
  isRenderedTemplateName,
  nuxtPagePath,
  walkScriptLocal,
} from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/ssr/no-request-state-in-cached-page";
const NUXT_SOURCES = /^(?:#app(?:\/.*)?|#imports|nuxt\/app)$/;
const H3_SOURCES = /^(?:h3|nitro\/h3|nitropack\/runtime(?:\/.*)?|#imports)$/;
const HEADER_COMPOSABLES = new Map([
  ["useRequestHeaders", "request headers"],
  ["useRequestHeader", "a request header"],
]);
// h3 utilities that read the headers, cookies or session of the event they receive.
const H3_READERS = new Set([
  "getCookie",
  "parseCookies",
  "getHeader",
  "getHeaders",
  "getRequestHeader",
  "getRequestHeaders",
  "getRequestIP",
  "getSession",
  "useSession",
]);
const QUERY_FIELDS = new Set(["search", "searchParams"]);
const SERVER_EVIDENCE = new Set(["setup-time", "unknown"]);

type ReadKind = "headers" | "event" | "query";

interface RequestRead {
  node: AnyNode;
  kind: ReadKind;
  label: string;
}

export const noRequestStateInCachedPage = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep per-request state out of pages served from a shared cache",
    category: "ssr",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/cache#route-rules",
    requires: { script: true, nuxt: true },
    prefilter: {
      names: [
        "useRequestHeaders",
        "useRequestHeader",
        "useCookie",
        "useRequestEvent",
        "useRequestURL",
      ],
    },
  },
  create(ctx) {
    if (!ctx.file.isVueSfc || isClientOnlyPath(ctx.file.relativePath)) return;
    if (!ctx.project.ssr || ctx.project.nuxt?.ssr === false) return;
    return {
      Program(program: AnyNode) {
        const reads = requestReads(ctx, program);
        if (!reads.length) return;
        const fact = pageRouteRules(ctx.project, ctx.file.path);
        if (fact.state === "absent") return;
        if (fact.state === "unknown") {
          if (nuxtPagePath(ctx) !== null && Object.keys(ctx.project.nuxt?.routeRules ?? {}).length)
            recordRouteRulesGap(ctx.project, ctx.file.relativePath, fact.reason);
          return;
        }
        for (const { route, patterns, rules } of fact.routes) {
          const kinds = cacheKinds(rules);
          const read = reads.find((candidate) =>
            candidate.kind !== "query" ? kinds.length : kinds.includes("prerender"),
          );
          if (!read) continue;
          const kind = read.kind === "query" ? "prerender" : kinds[0]!;
          ctx.report(diagnostics.NUXT0106({ why: why(read, kind, route), fix: fix(read) }), {
            ruleId: RULE_ID,
            severity: ctx.severity,
            category: "ssr",
            file: ctx.file.path,
            range: ctx.range(read.node),
            confidence: "manifest-backed",
            evidence: [
              {
                kind: "manifest",
                summary: `Nitro's route rule matcher applies ${patterns.join(", ")} to ${route}, which merge to \`${kind}\`.`,
              },
            ],
          });
          return;
        }
      },
    };
  },
});

function requestReads(ctx: RuleContext, program: AnyNode): RequestRead[] {
  const reads: RequestRead[] = [];
  const event = sources(ctx, "useRequestEvent");
  const url = sources(ctx, "useRequestURL");
  walkScriptLocal(program, (node) => {
    let read: Omit<RequestRead, "node"> | null = null;
    if (node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      const composable = importedName(ctx, callee, (source) => NUXT_SOURCES.test(source));
      const label = composable ? HEADER_COMPOSABLES.get(composable) : undefined;
      if (label) read = { kind: "headers", label: `${composable}() reads ${label}` };
      else if (composable === "useCookie") {
        // useCookie also reads document.cookie in the browser, so only a rendered value matters.
        const name = renderedBinding(ctx, node);
        if (name)
          read = {
            kind: "headers",
            label: `useCookie() reads a cookie that the template renders as ${name}`,
          };
      } else {
        const reader = importedName(ctx, callee, (source) => H3_SOURCES.test(source));
        if (reader && H3_READERS.has(reader) && node.arguments?.[0])
          if (holdsRequestValue(node.arguments[0], event))
            read = { kind: "event", label: `${reader}() reads the request event` };
      }
    } else if (node.type === "MemberExpression" && !node.computed) {
      const field = node.property?.name;
      if (isEventRequestRead(node) && holdsRequestValue(node.object, event))
        read = { kind: "event", label: `useRequestEvent() is read for its ${field}` };
      else if (QUERY_FIELDS.has(field) && holdsRequestValue(node.object, url))
        read = { kind: "query", label: `useRequestURL().${field} reads the query string` };
    }
    if (read && runsDuringServerRender(ctx, node)) reads.push({ node, ...read });
  });
  return reads.sort((a, b) => a.node.start - b.node.start);
}

function renderedBinding(ctx: RuleContext, call: AnyNode) {
  let node = call;
  while (node.__doctorParent && unwrapExpression(node.__doctorParent) === call)
    node = node.__doctorParent;
  const declarator = node.__doctorParent;
  if (declarator?.type !== "VariableDeclarator" || declarator.init !== node) return null;
  const name = declarator.id?.type === "Identifier" ? declarator.id.name : null;
  return name && isRenderedTemplateName(ctx, name) ? name : null;
}

function sources(ctx: RuleContext, composable: string) {
  return {
    isSource: (node: AnyNode) =>
      node.type === "CallExpression" &&
      importedName(ctx, unwrapExpression(node.callee), (source) => NUXT_SOURCES.test(source)) ===
        composable,
    programBinding: (program: AnyNode, name: string) => findStatementBinding(program, name),
  };
}

function runsDuringServerRender(ctx: RuleContext, node: AnyNode) {
  return (
    !ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text) &&
    SERVER_EVIDENCE.has(classifyExecutionEvidence(ctx, node))
  );
}

/**
 * Shared caches that render this route without the request's headers or cookies. A cache that
 * varies on request headers keeps those headers, so Doctor stays quiet for it.
 */
function cacheKinds(rules: NitroRouteRules): SharedCacheKind[] {
  if (rules.ssr === false) return [];
  const varies = rules.cache ? rules.cache.varies : undefined;
  return sharedCacheKinds(rules).filter(
    (kind) => !((kind === "cache" || kind === "swr") && Array.isArray(varies) && varies.length > 0),
  );
}

function why(read: RequestRead, kind: SharedCacheKind, route: string) {
  const served = {
    cache: `Nitro caches the server-rendered response for ${route} (route rule \`cache\`) and serves it to every visitor until it expires.`,
    swr: `Nitro caches the server-rendered response for ${route} (route rule \`swr\`) and serves it to every visitor while it revalidates in the background.`,
    isr: `The route rule \`isr\` makes presets that implement it (Vercel, Netlify, Zeabur) cache one rendered response for ${route} and serve it to every visitor.`,
    prerender: `The route rule \`prerender\` renders ${route} once at build time, and the server serves that HTML for every request without rendering it again.`,
  }[kind];
  const consequence =
    read.kind === "query"
      ? "The prerender request has no query string, and Nitro serves the prerendered file for any query, so the page renders as if none was given."
      : kind === "prerender"
        ? "At build time there is no visitor, so the page renders without their headers, cookies or session, and every visitor gets that render."
        : kind === "isr"
          ? "The visitor whose request fills the cache decides what everyone else sees, including anything rendered from their headers, cookies or session."
          : read.kind === "event"
            ? "Nitro renders the cached response with a copy of the request that drops every header not listed in `cache.varies`, but it keeps the request's `event.context`, so the visitor who fills the cache decides what everyone else sees."
            : "Nitro renders the cached response with a copy of the request that drops every header not listed in `cache.varies`, cookies included, so this read is empty while the cache renders and every visitor gets the anonymous page.";
  return `${read.label} while the page renders on the server. ${served} ${consequence}`;
}

function fix(read: RequestRead) {
  return read.kind === "query"
    ? "Read the query on the client, in onMounted() or behind import.meta.client, or drop `prerender` for this route so it renders per request."
    : "Move the per-visitor part to the client (onMounted(), import.meta.client, or <ClientOnly>) or to an uncached API call, or exclude the route from the cache with `cache: false` / `isr: false` / `prerender: false`. For a cache keyed on a header, list it in `cache.varies`.";
}
