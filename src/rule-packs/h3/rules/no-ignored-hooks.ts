import { createRule } from "../../../core/index.js";
import { propertyKey, unwrap } from "./_migration-helpers.js";
import { type AnyNode, canUseNativeH3, h3ExportName, isH3HandlerFile, report } from "./shared.js";

const ruleId = "h3/migration/no-ignored-hooks";

// H3 v2's defineHandler reads only handler, fetch, middleware, and meta from a handler object.
const handlerDefiners = new Set(["defineEventHandler", "defineHandler", "eventHandler"]);
const handlerHooks: Record<string, [message: string, fix: string]> = {
  onRequest: [
    "H3 v2 never calls onRequest on a handler object.",
    "Move the hook into middleware, such as defineHandler({ middleware: [onRequest(hook)], handler }).",
  ],
  onBeforeResponse: [
    "H3 v2 never calls onBeforeResponse on a handler object.",
    "Move the hook into middleware with onResponse(), such as defineHandler({ middleware: [onResponse((response, event) => {})], handler }).",
  ],
};

// H3 v2 app config reads onRequest, onResponse, and onError; v1's response hooks are gone.
const appFactories = new Set(["createApp", "createRouter"]);
const appClasses = new Set(["H3", "H3Core"]);
const appHooks: Record<string, [message: string, fix: string]> = {
  onBeforeResponse: [
    "H3 v2 never calls the onBeforeResponse app hook.",
    "Move the logic to the onResponse(response, event) app hook.",
  ],
  onAfterResponse: [
    "H3 v2 never calls the onAfterResponse app hook.",
    "Move the logic to the onResponse(response, event) app hook.",
  ],
};

export const noIgnoredHooks = createRule({
  meta: {
    id: ruleId,
    title: "Replace H3 v1 hooks that H3 v2 ignores",
    description:
      "Flags onRequest and onBeforeResponse on handler objects, and onBeforeResponse and onAfterResponse in app options, which H3 v2 never calls.",
    why: "H3 v2 replaced handler-object hooks with a middleware array and kept only onRequest, onResponse, and onError as app hooks. The old keys are copied onto the handler or config but never run, so authentication, logging, or header logic in them silently stops.",
    recommendedReplacement:
      "Move handler hooks into middleware, such as defineHandler({ middleware: [auth], handler }), and move onBeforeResponse or onAfterResponse app logic to onResponse.",
    category: "migration",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/migration",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    const check = (options: AnyNode, hooks: Record<string, [string, string]>) => {
      const object = unwrap(options);
      if (object?.type !== "ObjectExpression") return;
      for (const property of object.properties ?? []) {
        const key = propertyKey(property);
        const hook = key && Object.hasOwn(hooks, key) ? hooks[key] : undefined;
        if (hook) report(ctx, property, ruleId, "error", "migration", hook[0], hook[1]);
      }
    };
    return {
      CallExpression(node: AnyNode) {
        if (!canUseNativeH3(ctx, node.callee)) return;
        const name = h3ExportName(ctx, node.callee);
        if (!name) return;
        if (handlerDefiners.has(name)) check(node.arguments?.[0], handlerHooks);
        else if (appFactories.has(name)) check(node.arguments?.[0], appHooks);
      },
      NewExpression(node: AnyNode) {
        if (
          canUseNativeH3(ctx, node.callee) &&
          appClasses.has(h3ExportName(ctx, node.callee) ?? "")
        )
          check(node.arguments?.[0], appHooks);
      },
    };
  },
});
