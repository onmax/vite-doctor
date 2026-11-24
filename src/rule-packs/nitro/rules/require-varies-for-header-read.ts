import type { RuleContext } from "../../../core/index.js";
import { fileTextScope, type ScriptScope } from "../../../core/internal/script-scope.js";
import { type AnyNode, createRule, report } from "./shared.js";
import { readStaticConfigOptions, nitroServerFile } from "./server-layout.js";
import { routeMethodSuffix } from "./request-helpers.js";

const RULE_ID = "nitro/cache/require-varies-for-header-read";
const NITRO2_HANDLERS = new Set(["defineCachedEventHandler", "cachedEventHandler"]);
const NITRO2_SOURCES = new Set([
  "#imports",
  "#internal/nitro",
  "nitropack/runtime",
  "nitropack/runtime/internal/cache",
]);
const NITRO3_HANDLER = "defineCachedHandler";
const NITRO3_SOURCE = "nitro/cache";
const HEADER_HELPERS = new Set(["getHeader", "getRequestHeader"]);
const COOKIE_HELPERS = new Set(["getCookie", "parseCookies"]);
const H3_SOURCES = new Set(["h3", "nitro/h3", "#imports"]);
const AUTHORIZATION_HEADERS = ["authorization", "proxy-authorization"];
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

type Version = 2 | 3;

/** The request headers a cached handler still sees, or `undefined` when they cannot be proven. */
interface KeptHeaders {
  headers: Set<string>;
  /** Nitro 3 `allowCookies`: the cookie header reaches the handler with only these cookies. */
  cookies?: Set<string>;
}

interface HeaderRead {
  node: AnyNode;
  header: string;
  label: string;
  cookie?: string;
}

export const requireVariesForHeaderRead = createRule({
  meta: {
    id: RULE_ID,
    title: "List request headers a cached handler reads in varies",
    category: "cache",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/cache#options",
    requires: { script: true, nitro: true },
    prefilter: { names: [...NITRO2_HANDLERS, NITRO3_HANDLER] },
  },
  create(ctx) {
    if (!isServerSource(ctx)) return;
    return {
      Program() {
        const scope = fileTextScope(ctx);
        if (!scope) return;
        visit(scope, scope.ast, (node) => {
          if (node.type !== "CallExpression") return;
          const version = cachedHandlerVersion(scope, node.callee);
          if (!version) return;
          checkCachedHandler(ctx, scope, node, version);
        });
      },
    };
  },
});

function isServerSource(ctx: RuleContext) {
  const path = ctx.file.relativePath.replace(/\\/g, "/");
  if (/\.d\.[cm]?ts$|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)) return false;
  return Boolean(nitroServerFile(ctx, ctx.file.path));
}

function checkCachedHandler(ctx: RuleContext, scope: ScriptScope, call: AnyNode, version: Version) {
  const handler = unwrap(call.arguments?.[0]);
  if (!FUNCTION_TYPES.has(handler?.type)) return;
  const event = handler.params?.[0];
  if (event?.type !== "Identifier") return;
  // Nitro 3 serves every method other than GET and HEAD from the live request.
  if (version === 3) {
    const method = routeMethodSuffix(ctx.file.relativePath);
    if (method && method !== "GET" && method !== "HEAD") return;
    if (hasNitro3CacheDefaults(ctx)) return;
  }
  const kept = keptHeaders(call.arguments?.[1], version);
  if (!kept) return;
  const reads: HeaderRead[] = [];
  visit(scope, handler.body, (node) => {
    const read = headerRead(scope, node, event);
    if (read) reads.push(read);
  });
  for (const read of reads) {
    if (kept.headers.has(read.header)) continue;
    if (read.header === "cookie" && kept.cookies) {
      if (read.cookie === undefined || kept.cookies.has(read.cookie)) continue;
      reportFilteredCookie(ctx, read, call);
      continue;
    }
    reportStrippedHeader(ctx, read, call, version);
  }
}

function reportStrippedHeader(ctx: RuleContext, read: HeaderRead, call: AnyNode, version: Version) {
  const handler = calleeName(call.callee);
  const runtime =
    version === 2
      ? "Nitro builds the request it passes to a cached handler with only the headers listed in varies"
      : "Nitro rebuilds the request it passes to a cached handler with only the headers listed in varies (plus host, and authorization when allowAuthorization is true)";
  const cookie =
    read.header === "cookie"
      ? version === 3
        ? " For cookies, allowCookies: ['<name>'] keeps only the cookies the response depends on and keys the cache by them."
        : " Varying on cookie keys the cache by the whole cookie header, so read per-user state outside the cached handler when it should not be cached per visitor."
      : "";
  report(
    ctx,
    read.node,
    RULE_ID,
    "error",
    "cache",
    `${read.label} reads the ${read.header} request header inside ${handler}(), but ${read.header} is not in varies. ${runtime}, so this read always sees no value and the cached response ignores it.`,
    `Add '${read.header}' to the varies option of ${handler}(). Nitro then passes the header through and keys the cache by its value.${cookie}`,
  );
}

function reportFilteredCookie(ctx: RuleContext, read: HeaderRead, call: AnyNode) {
  const handler = calleeName(call.callee);
  report(
    ctx,
    read.node,
    RULE_ID,
    "error",
    "cache",
    `${read.label} reads the ${read.cookie} cookie inside ${handler}(), but allowCookies does not list it. Nitro strips every cookie not in allowCookies from the request it passes to the cached handler, so this read always sees no value.`,
    `Add '${read.cookie}' to the allowCookies option of ${handler}(). Nitro then passes that cookie through and keys the cache by its value.`,
  );
}

function cachedHandlerVersion(scope: ScriptScope, callee: AnyNode): Version | undefined {
  if (callee?.type !== "Identifier") return undefined;
  const source = importSource(scope, callee);
  if (NITRO2_HANDLERS.has(callee.name)) {
    if (
      source === null ||
      (source && NITRO2_SOURCES.has(source.module) && source.name === callee.name)
    )
      return 2;
    return undefined;
  }
  const imported = source || undefined;
  if (imported?.module === NITRO3_SOURCE && imported.name === NITRO3_HANDLER) return 3;
  return undefined;
}

/**
 * The module and imported name an identifier is bound to; `null` for an unbound identifier, which
 * Nitro 2 and Nuxt resolve through auto-imports; `false` for any other local binding.
 */
function importSource(
  scope: ScriptScope,
  identifier: AnyNode,
): { module: string; name: string } | null | false {
  const variable = scope.references.get(identifier)?.resolved;
  if (!variable) return null;
  const def = variable.defs.length === 1 ? (variable.defs[0] as AnyNode) : undefined;
  if (
    def?.type !== "ImportBinding" ||
    def.parent?.type !== "ImportDeclaration" ||
    def.parent.importKind === "type" ||
    def.node.type !== "ImportSpecifier" ||
    def.node.importKind === "type"
  )
    return false;
  const name = def.node.imported?.name ?? def.node.imported?.value;
  return typeof name === "string" ? { module: String(def.parent.source.value), name } : false;
}

function keptHeaders(options: AnyNode, version: Version): KeptHeaders | undefined {
  const headers = new Set<string>(version === 3 ? ["host"] : []);
  options = unwrap(options);
  if (options === undefined) return { headers };
  if (options.type !== "ObjectExpression") return undefined;
  const values = new Map<string, AnyNode>();
  for (const property of options.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init")
      return undefined;
    const key = propertyName(property.key);
    if (key === undefined) return undefined;
    values.set(key, unwrap(property.value));
  }
  const headersOnly = values.get("headersOnly");
  if (headersOnly && !isLiteral(headersOnly, false)) return undefined;
  const varies = values.get("varies");
  if (varies) {
    const names = stringArray(varies);
    if (!names) return undefined;
    for (const name of names) headers.add(name.toLowerCase());
  }
  if (version === 2) return { headers };
  if (values.has("shouldBypassCache")) return undefined;
  const allowAuthorization = values.get("allowAuthorization");
  if (allowAuthorization) {
    if (isLiteral(allowAuthorization, true))
      for (const name of AUTHORIZATION_HEADERS) headers.add(name);
    else if (!isLiteral(allowAuthorization, false)) return undefined;
  }
  const allowCookies = values.get("allowCookies");
  if (!allowCookies) return { headers };
  const cookies = stringArray(allowCookies);
  if (!cookies) return undefined;
  const allowed = new Set(cookies.map((name) => name.trim()).filter(Boolean));
  return allowed.size ? { headers, cookies: allowed } : { headers };
}

/** Nitro 3 merges `cache.defaults`, including varies, into every cached handler. */
function hasNitro3CacheDefaults(ctx: RuleContext) {
  const options = readStaticConfigOptions(ctx, ctx.project.framework === "nuxt" ? "nuxt" : "nitro");
  return options.some(({ path }) => path.length === 0 || path.at(-1) === "cache");
}

function headerRead(scope: ScriptScope, node: AnyNode, event: AnyNode): HeaderRead | undefined {
  if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
    const name = node.callee.name;
    if (!HEADER_HELPERS.has(name) && !COOKIE_HELPERS.has(name)) return undefined;
    const source = importSource(scope, node.callee);
    if (source === false || (source && (!H3_SOURCES.has(source.module) || source.name !== name)))
      return undefined;
    if (!isEvent(scope, node.arguments?.[0], event)) return undefined;
    if (name === "parseCookies") return { node, header: "cookie", label: "parseCookies(event)" };
    const value = staticString(node.arguments?.[1]);
    if (value === undefined) return undefined;
    if (name === "getCookie")
      return { node, header: "cookie", cookie: value, label: `getCookie(event, '${value}')` };
    return { node, header: value.toLowerCase(), label: `${name}(event, '${value}')` };
  }
  if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression") {
    return nodeHeadersRead(scope, node, event);
  }
  const callee = node.callee;
  if (memberName(callee) !== "get") return undefined;
  const headers = callee.object;
  if (headers?.type !== "MemberExpression" || memberName(headers) !== "headers") return undefined;
  const owner = headers.object;
  const viaRequest = owner?.type === "MemberExpression" && memberName(owner) === "req";
  if (!isEvent(scope, viaRequest ? owner.object : owner, event)) return undefined;
  const value = staticString(node.arguments?.[0]);
  if (value === undefined) return undefined;
  const path = viaRequest ? "event.req.headers" : "event.headers";
  return { node, header: value.toLowerCase(), label: `${path}.get('${value}')` };
}

/** `event.node.req.headers['x']` or `event.node.req.headers.x`. Node lowercases header keys. */
function nodeHeadersRead(scope: ScriptScope, node: AnyNode, event: AnyNode) {
  if (node.type !== "MemberExpression") return undefined;
  const headers = node.object;
  if (headers?.type !== "MemberExpression" || memberName(headers) !== "headers") return undefined;
  const req = headers.object;
  if (req?.type !== "MemberExpression" || memberName(req) !== "req") return undefined;
  const nodeMember = req.object;
  if (nodeMember?.type !== "MemberExpression" || memberName(nodeMember) !== "node")
    return undefined;
  if (!isEvent(scope, nodeMember.object, event)) return undefined;
  const value = node.computed ? staticString(node.property) : node.property?.name;
  if (typeof value !== "string" || value !== value.toLowerCase()) return undefined;
  return { node, header: value, label: `event.node.req.headers['${value}']` };
}

function isEvent(scope: ScriptScope, node: AnyNode, event: AnyNode) {
  node = unwrap(node);
  if (node?.type !== "Identifier") return false;
  const def = scope.references.get(node)?.resolved?.defs;
  return def?.length === 1 && def[0]!.name === event;
}

function stringArray(node: AnyNode): string[] | undefined {
  if (node?.type !== "ArrayExpression") return undefined;
  const values: string[] = [];
  for (const element of node.elements) {
    const value = staticString(element);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function staticString(node: AnyNode): string | undefined {
  node = unwrap(node);
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value?.cooked ?? undefined;
  return undefined;
}

function isLiteral(node: AnyNode, value: boolean) {
  return node?.type === "Literal" && node.value === value;
}

function propertyName(node: AnyNode): string | undefined {
  if (node?.type === "Identifier") return node.name;
  return staticString(node);
}

function memberName(node: AnyNode): string | undefined {
  if (node.computed) return staticString(node.property);
  return node.property?.type === "Identifier" ? node.property.name : undefined;
}

function calleeName(node: AnyNode): string {
  return node?.type === "Identifier" ? node.name : "the cached handler";
}

function unwrap(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

function visit(scope: ScriptScope, node: AnyNode, callback: (node: AnyNode) => void) {
  if (!node?.type) return;
  callback(node);
  for (const key of scope.visitorKeys[node.type] ?? []) {
    const child = node[key];
    if (Array.isArray(child)) for (const item of child) visit(scope, item, callback);
    else visit(scope, child, callback);
  }
}
