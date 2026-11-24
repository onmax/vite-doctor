import type { Confidence, RuleContext } from "../../../../core/index.js";
import {
  holdsRequestValue,
  staticMemberName,
  staticRequestString,
  unwrapExpression,
} from "../../../../core/internal/request-values.js";
import {
  hasRouteRulesEvidence,
  pageIsrState,
  pageRouteRules,
  recordRouteRulesGap,
  type SharedCacheKind,
  sharedCacheKinds,
} from "../../../../core/internal/route-rules.js";
import { findStatementBinding } from "../../../../core/internal/script-index.js";
import {
  eventMemberDependency,
  eventReaderDependency,
  variesOnHeaders,
} from "../../../nitro/rules/request-helpers.js";
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

type ReadKind = "headers" | "event" | "query";

interface RequestRead {
  node: AnyNode;
  kind: ReadKind;
  label: string;
  headers?: string[];
  /** The read may run only in the browser: execution evidence is `unknown`. */
  renderUnproven: boolean;
  /** An `event.context` field, which may hold per-deployment rather than per-visitor data. */
  visitorUnproven: boolean;
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
          if (nuxtPagePath(ctx) !== null && hasRouteRulesEvidence(ctx.project))
            recordRouteRulesGap(ctx.project, ctx.file.relativePath, fact.reason);
          return;
        }
        for (const entry of fact.routes) {
          const { route, patterns, rules } = entry;
          if (rules.ssr === false || rules.redirect || rules.proxy) continue;
          const isr = pageIsrState(entry, ctx.project);
          const kinds = sharedCacheKinds(rules);
          if (isr === "on") kinds.unshift("isr");
          if (isr === "unknown" && reads.some((read) => read.kind !== "query"))
            recordRouteRulesGap(
              ctx.project,
              ctx.file.relativePath,
              `ISR coverage for ${route} is unproven for the production Nitro preset`,
            );
          const applicable = reads.filter((candidate) =>
            kinds.some((kind) => applies(candidate, kind)),
          );
          const read =
            applicable.find(
              (candidate) => !candidate.renderUnproven && !candidate.visitorUnproven,
            ) ?? applicable[0];
          if (!read) continue;
          const kind = kinds.find((kind) => applies(read, kind))!;
          const doubts = [
            read.renderUnproven &&
              "Doctor can't prove this code runs while the page renders on the server; it may only run later in the browser.",
            read.visitorUnproven &&
              "`event.context` holds whatever middleware, Nitro and the deployment adapter put there, such as `context.cloudflare.env`; Doctor can't tell whether this field is per visitor.",
          ].filter((doubt): doubt is string => !!doubt);
          const confidence: Confidence = doubts.length ? "heuristic-medium" : "manifest-backed";
          ctx.report(diagnostics.NUXT0106({ why: why(read, kind, route), fix: fix(read) }), {
            ruleId: RULE_ID,
            severity: ctx.severity,
            category: "ssr",
            file: ctx.file.path,
            range: ctx.range(read.node),
            confidence,
            evidence: [
              {
                kind: "manifest",
                summary: `Nitro's route rule matcher applies ${patterns.join(", ")} to ${route}, which merge to \`${kind}\`.`,
              },
              ...doubts.map((summary) => ({ kind: "ast" as const, summary })),
            ],
          });
          return;

          function applies(read: RequestRead, kind: SharedCacheKind) {
            if (read.kind === "query") return kind === "prerender";
            if (kind !== "cache" && kind !== "swr") return true;
            return !variesOnHeaders(rules.cache ? rules.cache.varies : undefined, read.headers);
          }
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
    let read: Omit<RequestRead, "node" | "renderUnproven" | "visitorUnproven"> | null = null;
    let visitorUnproven = false;
    if (node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      const composable = importedName(ctx, callee, (source) => NUXT_SOURCES.test(source));
      const label = composable ? HEADER_COMPOSABLES.get(composable) : undefined;
      if (label) {
        const argument = unwrapExpression(node.arguments?.[0]);
        const names =
          composable === "useRequestHeader"
            ? [staticRequestString(argument)]
            : argument?.type === "ArrayExpression"
              ? argument.elements.map(staticRequestString)
              : undefined;
        if (names?.length !== 0)
          read = {
            kind: "headers",
            label: `${composable}() reads ${label}`,
            headers: names?.every((name: string | undefined) => name) ? names : undefined,
          };
      } else if (composable === "useCookie") {
        // useCookie also reads document.cookie in the browser, so only a rendered value matters.
        const name = renderedBinding(ctx, program, node);
        if (name)
          read = {
            kind: "headers",
            headers: ["cookie"],
            label: `useCookie() reads a cookie that the template renders as ${name}`,
          };
      } else {
        const reader = importedName(ctx, callee, (source) => H3_SOURCES.test(source));
        if (reader && H3_READERS.has(reader) && node.arguments?.[0])
          if (holdsRequestValue(node.arguments[0], event))
            read = {
              ...eventReaderDependency(reader, node.arguments),
              label: `${reader}() reads the request event`,
            };
      }
    } else if (node.type === "MemberExpression") {
      const field = staticMemberName(node);
      const dependency = eventMemberDependency(node);
      if (dependency && holdsRequestValue(node.object, event)) {
        read = {
          ...dependency,
          label: `useRequestEvent() is read for its ${dependency.kind === "headers" ? "headers" : "context"}`,
        };
        visitorUnproven = dependency.kind === "event";
      } else if (field && QUERY_FIELDS.has(field) && holdsRequestValue(node.object, url))
        read = { kind: "query", label: `useRequestURL().${field} reads the query string` };
    }
    if (!read || ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
    const execution = classifyExecutionEvidence(ctx, node);
    if (execution !== "setup-time" && execution !== "unknown") return;
    reads.push({ node, ...read, renderUnproven: execution === "unknown", visitorUnproven });
  });
  return reads.sort((a, b) => a.node.start - b.node.start);
}

function renderedBinding(ctx: RuleContext, program: AnyNode, call: AnyNode) {
  for (const statement of program.body ?? []) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const { id, init } of statement.declarations) {
      if (id?.type !== "Identifier" || !isRenderedTemplateName(ctx, id.name)) continue;
      if (
        holdsRequestValue(init, {
          isSource: (node) => node === call,
          programBinding: findStatementBinding,
          maxDepth: 8,
        })
      )
        return id.name;
    }
  }
  return null;
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

function why(read: RequestRead, kind: SharedCacheKind, route: string) {
  const served = {
    cache: `Nitro caches the server-rendered response for ${route} (route rule \`cache\`) and serves it to every visitor until it expires.`,
    swr: `Nitro caches the server-rendered response for ${route} (route rule \`swr\`) and serves it to every visitor while it revalidates in the background.`,
    isr: `The production Nitro preset uses the route rule \`isr\` to cache the rendered response for ${route}.`,
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
            ? `Nitro renders the cached response with a copy of the request that drops every header not listed in \`cache.varies\`, but it keeps the request's \`event.context\`, so ${read.visitorUnproven ? "if this field holds per-visitor data, " : ""}the visitor who fills the cache decides what everyone else sees.`
            : "Nitro renders the cached response with a copy of the request that drops every header not listed in `cache.varies`, cookies included, so this read is empty while the cache renders and every visitor gets the anonymous page.";
  const when = read.renderUnproven
    ? "in code that may run while the page renders on the server"
    : "while the page renders on the server";
  return `${read.label} ${when}. ${served} ${consequence}`;
}

function fix(read: RequestRead) {
  return read.kind === "query"
    ? "Read the query on the client, in onMounted() or behind import.meta.client, or drop `prerender` for this route so it renders per request."
    : "Move the per-visitor part to the client (onMounted(), import.meta.client, or <ClientOnly>) or to an uncached API call, or exclude the route from the cache with `cache: false` / `isr: false` / `prerender: false`. For a cache keyed on a header, list it in `cache.varies`.";
}
