import {
  createRule,
  defineRulePack,
  type DoctorRule,
  type RuleContext,
} from "../../../core/index.js";
import {
  FUNCTION_TYPES,
  holdsRequestValue,
  staticRequestString,
  type RequestValueSources,
} from "../../../core/internal/request-values.js";
import {
  handlerRouteRules,
  hasRouteRulesEvidence,
  recordRouteRulesGap,
} from "../../../core/internal/route-rules.js";
import { walkScriptLocal } from "../../../core/rule-authoring.js";
import {
  h3Name,
  eventMemberDependency,
  eventReaderDependency,
  type EventRequestRead,
  routeMethodSuffix,
  variesOnHeaders,
} from "../../nitro/rules/request-helpers.js";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

function isCachedEventHandler(node: AnyNode) {
  return (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    (node.callee.name === "cachedEventHandler" || node.callee.name === "defineCachedEventHandler")
  );
}

function propertyName(property: AnyNode) {
  if (!property.computed && property.key?.type === "Identifier") return property.key.name;
  if (property.key?.type === "Literal" && typeof property.key.value === "string")
    return property.key.value;
  return undefined;
}

function hasMeaningfulCacheControl(node: AnyNode, read: EventRequestRead) {
  const options = unwrap(node.arguments?.[1]);
  if (options?.type !== "ObjectExpression") return false;
  const controls = new Map<string, AnyNode>();
  const collect = (value: AnyNode) => {
    value = unwrap(value);
    if (value?.type !== "ObjectExpression") {
      controls.clear();
      return;
    }
    for (const property of value.properties) {
      if (property.type === "SpreadElement") {
        collect(property.argument);
        continue;
      }
      if (property.type !== "Property") continue;
      const name = propertyName(property);
      if (name === undefined) controls.clear();
      else {
        const value = property.kind === "init" ? unwrap(property.value) : undefined;
        if (isUndefinedOption(value)) controls.delete(name);
        else controls.set(name, value);
      }
    }
  };
  collect(options);
  const allowCookies = controls.get("allowCookies");
  if (read.kind === "headers") {
    const varies = controls.get("varies");
    if (
      (!controls.has("getKey") || usesDefaultKey(controls.get("getKey"))) &&
      varies?.type === "ArrayExpression" &&
      variesOnHeaders(knownVariesHeaders(varies), read.headers)
    )
      return true;
  }
  return [...controls].some(([name, value]) => {
    if (name === "shouldBypassCache") {
      if (!["ArrowFunctionExpression", "FunctionExpression"].includes(value?.type)) return false;
      const body = value.body;
      const result =
        body.type === "BlockStatement"
          ? body.body.length === 1 && body.body[0].type === "ReturnStatement"
            ? body.body[0].argument
            : undefined
          : body;
      return result?.type === "Literal" && result.value === true;
    }
    if (read.kind === "headers") return false;
    if (name === "getKey")
      return (
        ["ArrowFunctionExpression", "FunctionExpression"].includes(value?.type) ||
        isDynamicOption(value)
      );
    if (name === "allowCookies") {
      if (value?.type === "ArrayExpression") return hasNonEmptyStringArray(value);
      return isDynamicOption(value);
    }
    if (name === "allowAuthorization") return value?.type === "Literal" && value.value === true;
    if (name !== "varies") return false;
    if (value?.type === "ArrayExpression")
      return value.elements.some((entry: AnyNode) => {
        entry = unwrap(entry);
        if (allowCookies !== undefined && entry?.type === "Literal" && entry.value === "cookie")
          return false;
        return hasVaryHeader(entry);
      });
    return isDynamicOption(value);
  });
}

function isUndefinedOption(node: AnyNode): boolean {
  return node?.type === "Identifier" && node.name === "undefined";
}

function knownVariesHeaders(array: AnyNode): string[] {
  return array.elements.flatMap((element: AnyNode) => {
    const value = unwrap(element);
    if (value?.type === "SpreadElement") {
      const spread = unwrap(value.argument);
      return spread?.type === "ArrayExpression" ? knownVariesHeaders(spread) : [];
    }
    const header = staticRequestString(value);
    return header === undefined ? [] : [header];
  });
}

function usesDefaultKey(callback: AnyNode): boolean {
  if (callback?.type === "Literal" && callback.value === null) return true;
  if (!FUNCTION_TYPES.has(callback?.type) || callback.generator) return false;
  let result = callback.body;
  if (result.type === "BlockStatement") {
    if (!result.body.length) return true;
    if (result.body.length !== 1 || result.body[0].type !== "ReturnStatement") return false;
    result = result.body[0].argument;
  }
  result = unwrap(result);
  return (
    !result ||
    (result.type === "Literal" && !result.value) ||
    (result.type === "UnaryExpression" && result.operator === "void") ||
    staticRequestString(result) === ""
  );
}

function hasNonEmptyStringArray(node: AnyNode): boolean {
  return (
    node.elements.length > 0 &&
    node.elements.every((element: AnyNode) => {
      element = unwrap(element);
      return (
        element?.type === "Literal" && typeof element.value === "string" && element.value.length > 0
      );
    })
  );
}

function hasVaryHeader(node: AnyNode): boolean {
  node = unwrap(node);
  if (node?.type === "Literal") return typeof node.value === "string" && node.value.length > 0;
  if (node?.type === "TemplateLiteral")
    return node.expressions.length > 0 || node.quasis.some((part: AnyNode) => part.value.cooked);
  if (node?.type === "SpreadElement") {
    const value = unwrap(node.argument);
    return value?.type === "ArrayExpression"
      ? value.elements.some(hasVaryHeader)
      : isDynamicOption(value);
  }
  return isDynamicOption(node);
}

function isDynamicOption(node: AnyNode): boolean {
  if (node?.type === "Identifier") return node.name !== "undefined";
  return [
    "MemberExpression",
    "CallExpression",
    "ChainExpression",
    "ConditionalExpression",
    "LogicalExpression",
    "AwaitExpression",
    "NewExpression",
    "TaggedTemplateExpression",
  ].includes(node?.type);
}

function unwrap(node: AnyNode): AnyNode {
  return [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
    "TSTypeAssertion",
    "TSNonNullExpression",
  ].includes(node?.type)
    ? unwrap(node.expression)
    : node;
}

export const noPersonalizedCachedHandler = createRule({
  meta: {
    id: "nuxthub/no-personalized-cached-handler",
    title: "Do not cache personalized handlers without varying",
    category: "cache",
    severity: "error",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://hub.nuxt.com/docs/features/cache#when-to-use-cache",
    requires: { script: true, nuxt: true },
    prefilter: {
      names: [
        "cachedEventHandler",
        "defineCachedEventHandler",
        "defineEventHandler",
        "eventHandler",
      ],
    },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      Program(program: AnyNode) {
        let wrapped = false;
        walkScriptLocal(program, (node) => {
          if (
            node.type !== "CallExpression" ||
            !CACHED_HANDLERS.has(h3Name(unwrap(node.callee)) ?? "")
          )
            return;
          wrapped = true;
          const read = personalReads(handlerFunction(node)).find(
            (read) => !hasMeaningfulCacheControl(node, read),
          );
          if (!read) return;
          ctx.helpers.report(
            ctx,
            node,
            diagnostics.NUXT0062({
              why: `This cached handler reads ${read.label} from the request. Nitro keeps only the headers listed in varies while retaining the original event.context, so the cached response can omit request data or reuse one visitor's data for another.`,
              fix: "Avoid caching personalized responses. For responses that depend only on known request headers, list each of those headers in varies.",
            }),
            {
              ruleId: "nuxthub/no-personalized-cached-handler",
              severity: "error",
              category: "cache",
            },
          );
        });
        if (!wrapped) reportRouteRuleCache(ctx, program);
      },
    };
  },
});

// Nitro wraps a plain handler in cachedEventHandler when the route rules for its route set
// `cache` or `swr`, so the same reads leak without a cachedEventHandler call in the file.
function reportRouteRuleCache(ctx: RuleContext, program: AnyNode) {
  const call = exportedEventHandler(program);
  if (!call) return;
  const reads = personalReads(handlerFunction(call));
  if (!reads.length) return;
  const fact = handlerRouteRules(ctx.project, ctx.file.path);
  if (fact.state === "unknown") {
    if (hasRouteRulesEvidence(ctx.project))
      recordRouteRulesGap(ctx.project, ctx.file.relativePath, fact.reason);
    return;
  }
  if (fact.state !== "resolved") return;
  const uncovered = fact.routes.flatMap((route) => {
    const { rules } = route;
    if (!rules.cache) return [];
    const { varies, swr } = rules.cache;
    const read = reads.find((read) => !variesOnHeaders(varies, read.headers));
    return read ? [{ route, read, swr }] : [];
  })[0];
  if (!uncovered) return;
  const { route: cached, read, swr } = uncovered;
  ctx.helpers.report(
    ctx,
    call,
    diagnostics.NUXT0062({
      why: `This handler reads ${read.label} from the request, and the route rules for ${cached.route} (${cached.patterns.join(", ")}) set \`${swr ? "swr" : "cache"}\`, so Nitro wraps it in cachedEventHandler. Nitro keeps only the headers listed in cache.varies while retaining the original event.context, so the cached response can omit request data or reuse one visitor's data for another.`,
      fix: "Exclude the route from the cache with `cache: false`, or list the headers the response depends on in the rule's `cache.varies`.",
    }),
    {
      ruleId: "nuxthub/no-personalized-cached-handler",
      severity: "error",
      category: "cache",
      confidence: "manifest-backed",
      evidence: [
        {
          kind: "manifest",
          summary: `Nitro's route rule matcher applies ${cached.patterns.join(", ")} to the handler route ${cached.route}.`,
        },
      ],
    },
  );
}

const EVENT_HANDLERS = new Set(["defineEventHandler", "eventHandler"]);
const CACHED_HANDLERS = new Set(["cachedEventHandler", "defineCachedEventHandler"]);
// h3 readers of the visitor's headers, cookies and session, plus nuxt-auth-utils' session helpers.
const PERSONAL_READERS = new Set([
  "getCookie",
  "parseCookies",
  "getHeader",
  "getHeaders",
  "getRequestHeader",
  "getRequestHeaders",
  "getRequestIP",
  "getSession",
  "useSession",
  "getUserSession",
  "requireUserSession",
]);

function exportedEventHandler(program: AnyNode): AnyNode {
  for (const statement of program.body ?? []) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    const call = unwrap(statement.declaration);
    return call?.type === "CallExpression" && EVENT_HANDLERS.has(h3Name(unwrap(call.callee)) ?? "")
      ? call
      : null;
  }
  return null;
}

/** The function an h3 handler factory receives, or its `{ handler }` option. */
function handlerFunction(call: AnyNode): AnyNode {
  const argument = unwrap(call.arguments?.[0]);
  if (argument?.type !== "ObjectExpression") return argument;
  const property = argument.properties.find(
    (entry: AnyNode) => entry.type === "Property" && propertyName(entry) === "handler",
  );
  return property ? unwrap(property.value) : null;
}

function personalReads(input: AnyNode): Array<EventRequestRead & { label: string }> {
  const handler = unwrap(input);
  if (!FUNCTION_TYPES.has(handler?.type)) return [];
  const event: RequestValueSources = {
    isSource: () => false,
    parameter: (fn, index) => fn === handler && index === 0,
  };
  const reads: Array<EventRequestRead & { label: string }> = [];
  walkScriptLocal(handler.body, (node) => {
    if (node.type === "CallExpression") {
      const name = h3Name(unwrap(node.callee));
      if (name && PERSONAL_READERS.has(name) && node.arguments?.[0])
        if (holdsRequestValue(node.arguments[0], event))
          reads.push({ ...eventReaderDependency(name, node.arguments), label: `${name}()` });
    } else {
      const dependency = eventMemberDependency(node);
      if (dependency && holdsRequestValue(node.object, event))
        reads.push({
          ...dependency,
          label: dependency.kind === "event" ? "event.context" : "request headers",
        });
    }
  });
  return reads;
}

export const preferCachedEventHandler = createRule({
  meta: {
    id: "nuxthub/prefer-cached-event-handler",
    title: "Cache expensive public server handlers",
    category: "cache",
    severity: "info",
    confidence: "heuristic-low",
    fixable: "suggestion",
    docsUrl: "https://hub.nuxt.com/docs/features/cache#when-to-use-cache",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    const method = routeMethodSuffix(ctx.file.relativePath);
    if (method && method !== "GET" && method !== "HEAD") return;
    return {
      Program(node: AnyNode) {
        let hasCachedHandler = false;
        let consumesBody = false;
        walkScriptLocal(node, (child) => {
          if (isCachedEventHandler(child)) hasCachedHandler = true;
          if (
            [
              "readBody",
              "readValidatedBody",
              "readRawBody",
              "readMultipartFormData",
              "readFormData",
            ].includes(ctx.helpers.getCalleeName(child) ?? "")
          )
            consumesBody = true;
        });
        if (hasCachedHandler || consumesBody) return;
        if (!/(await\s+\$fetch|queryCollection|hubDatabase|hubKV)/.test(ctx.file.text)) return;
        if (/(getUserSession|getCookie|getHeader|authorization|tenant|user)/i.test(ctx.file.text))
          return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0063({
            why: "This public-looking server handler does expensive work and may be cacheable.",
            fix: "Consider cachedEventHandler() with route rules when the response is public.",
          }),
          {
            ruleId: "nuxthub/prefer-cached-event-handler",
            severity: "info",
            category: "cache",
          },
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [noPersonalizedCachedHandler, preferCachedEventHandler];

export const nuxtHubRulePack = defineRulePack({
  name: "vite-doctor/nuxthub",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@nuxthub/core"], modules: ["@nuxthub/core"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtHubRulePack;
