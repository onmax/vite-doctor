import {
  constantValue,
  mayReferenceH3App,
  h3AppMethod,
  memberName,
  propertyKey,
  unwrap,
} from "./_migration-helpers.js";
import { type AnyNode, createRule, h3ExportName, isH3AppReceiver, report } from "./shared.js";

const ruleId = "h3/migration/no-removed-router-api";

// H3 v2's H3 class has no add, resolve, or stack member, so each reads as undefined.
const removedMembers: Record<string, [message: string, fix: string]> = {
  add: [
    "H3 v2 removed router.add().",
    "Register the route with app.on(method, path, handler), or app.get(path, handler) and the other method shortcuts.",
  ],
  resolve: [
    "H3 v2 removed app.resolve().",
    "Match routes by calling app.fetch() or app.request() with a Request for the path.",
  ],
  stack: [
    "H3 v2 removed app.stack.",
    "Keep your own list of what you register, or inspect requests through middleware.",
  ],
};

const lazyLoaders = new Set(["defineLazyEventHandler", "lazyEventHandler"]);

export const noRemovedRouterApi = createRule({
  meta: {
    id: ruleId,
    title: "Replace router APIs H3 v2 removed",
    description:
      "Flags router.add(), router.resolve(), app.stack, lazy handlers registered with { lazy: true }, and array route paths, which H3 v2 removed.",
    why: "H3 v2 merged the router into the app. The removed members are undefined at runtime, so a call throws when the route module loads and the server fails to start.",
    recommendedReplacement:
      "Register routes with app.on(method, path, handler) or app.get(path, handler), register each path separately, and wrap lazy handlers with defineLazyEventHandler().",
    category: "migration",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://github.com/h3js/h3/blob/main/MIGRATION.md",
    requires: { script: true },
    applicability: {
      runtimes: { h3: ">=2.0.0-0" },
      includePrerelease: true,
    },
  },
  create(ctx) {
    if (!mayReferenceH3App(ctx)) return;
    const reportAt = (node: AnyNode, message: string, fix: string) =>
      report(ctx, node, ruleId, "error", "migration", message, fix);
    const checkUse = (args: AnyNode[]) => {
      for (const argument of args.slice(0, 2)) {
        if (unwrap(argument)?.type === "ArrayExpression")
          reportAt(
            argument,
            "H3 v2 app.use() no longer accepts an array of paths or handlers; requests it matches fail with a 500.",
            "Call app.use() once for each path and handler.",
          );
      }
      const first = unwrap(args[0]);
      if (
        first?.type === "ObjectExpression" &&
        first.properties?.some((item: AnyNode) => propertyKey(item) === "handler")
      ) {
        reportAt(
          first,
          "H3 v2 app.use() no longer accepts a { route, handler } layer object; it treats the object as a sub-app and throws while mounting it.",
          'Pass the path and handler as arguments, such as app.use("/path/**", handler).',
        );
        return;
      }
      if (args.some(isLazyLoader)) return;
      for (const argument of args.slice(1)) {
        const options = unwrap(argument);
        if (options?.type !== "ObjectExpression") continue;
        const lazy = options.properties?.find((item: AnyNode) => propertyKey(item) === "lazy");
        if (!lazy || isFalse(lazy.value)) continue;
        reportAt(
          lazy,
          "H3 v2 ignores the lazy option, so the loader runs as middleware on each request and its return value becomes the response instead of the handler it loads.",
          "Wrap the loader with defineLazyEventHandler(() => import(...)) and drop the lazy option.",
        );
      }
    };
    const isLazyLoader = (node: AnyNode) => {
      const value = constantValue(ctx, node);
      return (
        value?.type === "CallExpression" && lazyLoaders.has(h3ExportName(ctx, value.callee) ?? "")
      );
    };
    return {
      MemberExpression(node: AnyNode) {
        const name = memberName(node);
        const removed = name && Object.hasOwn(removedMembers, name) ? removedMembers[name] : null;
        if (!removed || isAssignmentTarget(node) || !isH3AppReceiver(ctx, node.object, true))
          return;
        reportAt(node, removed[0], removed[1]);
      },
      CallExpression(node: AnyNode) {
        if (h3AppMethod(ctx, node) === "use") checkUse(node.arguments ?? []);
      },
    };
  },
});

function isFalse(node: AnyNode) {
  return node?.type === "Literal" && node.value === false;
}

function isAssignmentTarget(node: AnyNode) {
  const parent = node.__doctorParent ?? node.parent;
  return parent?.type === "AssignmentExpression" && parent.left === node;
}
