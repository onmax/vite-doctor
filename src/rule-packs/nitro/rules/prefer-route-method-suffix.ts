import { type AnyNode, createRule, report } from "./shared.js";
import {
  isNitroRouteFile,
  isInIfStatementTest,
  methodChecks,
  routeMethodSuffix,
  routePathWithMethodSuffix,
  singleMethodCheck,
  type MethodCheck,
} from "./request-helpers.js";

const RULE_ID = "nitro/request/prefer-route-method-suffix";

export const preferRouteMethodSuffix = createRule({
  meta: {
    id: RULE_ID,
    title: "Use Nitro route method suffixes",
    description:
      "File-routed Nitro handlers should use HTTP method filename suffixes instead of manual request method gates.",
    why: "Nitro's file router can bind handlers to HTTP methods before user code runs, which keeps unsupported methods out of the handler and makes the route contract visible in the filesystem.",
    recommendedReplacement:
      "Use route files such as server/api/user.get.ts or server/api/user.post.ts instead of checking request.method inside the handler.",
    examples: [
      {
        title: "Move method gates into the route filename",
        language: "ts",
        invalid:
          "export default defineEventHandler((event) => {\n  if (getMethod(event) !== 'POST') throw createError({ statusCode: 405 })\n  return createUser(event)\n})",
        valid:
          "// server/api/user.post.ts\nexport default defineEventHandler((event) => {\n  return createUser(event)\n})",
      },
    ],
    category: "request",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/routing#specific-request-method",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!isNitroRouteFile(ctx.file.relativePath)) return;

    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "IfStatement") {
          const checks = methodChecks(node.test, ctx.file.text, node);
          if (!checks.length) return;
          reportMethodCheck(node.test ?? node, checks, wholeHandlerAllowed(node, checks));
          return;
        }

        if (node.type !== "BinaryExpression" || isInIfStatementTest(node)) return;
        const check = singleMethodCheck(node, ctx.file.text, node);
        if (!check) return;
        reportMethodCheck(node, [check], false);
      },
    };

    function reportMethodCheck(node: AnyNode, checks: MethodCheck[], wholeHandler: boolean) {
      const methods = methodsFromChecks(checks);
      const suffix = routeMethodSuffix(ctx.file.relativePath);
      const suggestion =
        suffix && isRedundantSuffix(suffix, methods)
          ? `Remove the manual method guard; .${suffix.toLowerCase()}.ts already constrains this route.`
          : methodSuffixSuggestion(ctx.file.relativePath, methods, wholeHandler);
      report(
        ctx,
        node,
        RULE_ID,
        "warn",
        "request",
        `This file-routed Nitro handler checks ${formatMethods(methods)} manually.`,
        suggestion,
      );
    }
  },
});

function formatMethods(methods: string[]) {
  return methods.length === 1 ? methods[0]! : methods.join("/");
}

function isRedundantSuffix(suffix: string | null, methods: string[]) {
  return methods.length === 1 && methods[0] === suffix;
}

function methodSuffixSuggestion(relativePath: string, methods: string[], wholeHandler: boolean) {
  const paths = methods.map((method) =>
    routePathWithMethodSuffix(relativePath, method.toLowerCase()),
  );
  if (wholeHandler && paths.length === 1)
    return `Move this handler to ${paths[0]} and remove the manual method guard.`;
  if (wholeHandler)
    return `Split this handler into ${formatList(paths)} and remove the manual method guard.`;
  if (paths.length === 1)
    return `Move the ${methods[0]}-specific branch to ${paths[0]} and keep other method behavior in method-suffixed route files.`;
  return `Move the method-specific branches to ${formatList(paths)} and keep other method behavior in method-suffixed route files.`;
}

function formatList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function methodsFromChecks(checks: MethodCheck[]) {
  return [...new Set(checks.map((check) => check.method))];
}

function wholeHandlerAllowed(node: AnyNode, checks: MethodCheck[]) {
  return checks.every((check) => check.isNegative) && branchExits(node.consequent);
}

function branchExits(node: AnyNode) {
  if (!node) return false;
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return true;
  if (node.type !== "BlockStatement") return false;
  return branchExits(node.body?.at(-1));
}
