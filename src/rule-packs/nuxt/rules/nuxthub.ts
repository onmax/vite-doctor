import { createRule, defineRulePack, type DoctorRule } from "../../../core/index.js";
import { walkScriptLocal } from "../../../core/rule-authoring.js";
import { routeMethodSuffix } from "../../nitro/rules/request-helpers.js";
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

function hasMeaningfulCacheControl(node: AnyNode) {
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
    fixable: "suggestion",
    docsUrl: "https://hub.nuxt.com/docs/features/cache#when-to-use-cache",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!isCachedEventHandler(node)) return;
        const handler = node.arguments?.[0];
        if (!handler) return;
        const snippet = ctx.file.text.slice(handler.start, handler.end);
        if (!/(getUserSession|getCookie|getHeader|authorization|tenant|user)/i.test(snippet))
          return;
        if (hasMeaningfulCacheControl(node)) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0062({
            why: "This cached handler appears to depend on user, tenant, cookie, or auth state.",
            fix: "Avoid caching personalized responses or include an explicit cache key/vary strategy.",
          }),
          {
            ruleId: "nuxthub/no-personalized-cached-handler",
            severity: "error",
            category: "cache",
          },
        );
      },
    };
  },
});

export const preferCachedEventHandler = createRule({
  meta: {
    id: "nuxthub/prefer-cached-event-handler",
    title: "Cache expensive public server handlers",
    category: "cache",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://hub.nuxt.com/docs/features/cache#when-to-use-cache",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    const method = routeMethodSuffix(ctx.file.relativePath);
    if (method && method !== "GET" && method !== "HEAD") return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
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
