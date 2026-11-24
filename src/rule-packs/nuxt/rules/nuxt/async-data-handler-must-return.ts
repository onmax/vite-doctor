import { fileScriptScope } from "../../../../core/internal/script-scope.js";
import { diagnostics } from "../../diagnostics.js";
import { isRuntimeAppFile } from "./file-classification.js";
import { isNuxtAppExport } from "./nuxt-app-binding.js";
import { scriptNodesOfType } from "./script-index.js";
import { createRule, toPosixPath, type AnyNode } from "./shared.js";

const RULE_ID = "nuxt/fetch/handler-must-return";
const COMPOSABLES = ["useAsyncData", "useLazyAsyncData"];
const FUNCTION_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression"]);
// transform and pick replace an undefined result, default and getCachedData give hydration data,
// and server or immediate decide whether the handler runs during SSR at all.
const RESULT_OPTIONS = new Set(["transform", "pick", "default", "getCachedData"]);
const NESTED_SCOPES = new Set([
  ...FUNCTION_TYPES,
  "FunctionDeclaration",
  "ClassDeclaration",
  "ClassExpression",
]);
const SSR_OPTIONS = new Set(["server", "immediate"]);
const CLIENT_ONLY_FILE_RE = /\.(?:client|server|island(?:\.global)?)\.[^/]+$/;

export const asyncDataHandlerMustReturn = createRule({
  meta: {
    id: RULE_ID,
    title: "Return a value from useAsyncData handlers",
    category: "fetching",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/api/composables/use-async-data#params",
    requires: { script: true, nuxt: true },
    prefilter: { calls: COMPOSABLES },
  },
  create(ctx) {
    const nuxt = ctx.project.nuxt;
    if (
      !nuxt ||
      nuxt.ssr === false ||
      CLIENT_ONLY_FILE_RE.test(toPosixPath(ctx.file.relativePath)) ||
      !isRuntimeAppFile(ctx)
    )
      return;
    return {
      Program() {
        const scope = fileScriptScope(ctx);
        if (!scope) return;
        for (const call of scriptNodesOfType(scope.ast, "CallExpression")) {
          if (call.callee?.type !== "Identifier") continue;
          const composable = COMPOSABLES.find((composable) =>
            isNuxtAppExport(
              scope.references.get(call.callee),
              nuxt,
              composable,
              "composables/asyncData",
            ),
          );
          if (!composable) continue;
          const handlerIndex = FUNCTION_TYPES.has(call.arguments[0]?.type) ? 0 : 1;
          const handler = call.arguments[handlerIndex];
          const options = call.arguments[handlerIndex + 1];
          if (
            !FUNCTION_TYPES.has(handler?.type) ||
            handler.generator ||
            !runsDuringSsrWithoutFallback(options) ||
            returnsValue(handler)
          )
            continue;
          ctx.report(
            diagnostics.NUXT0103({
              why: `This ${composable}() handler never returns a value, so it resolves to undefined. Nuxt skips the client fetch during hydration only when the payload holds data that is not undefined, so the handler runs again in the browser after SSR, and in development Nuxt warns that the request may be duplicated (NUXT_E3006).`,
              fix: "Return the data the page uses. If the handler only runs side effects, return null, or move the side effects out of the handler.",
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "fetching",
              file: ctx.file.path,
              range: ctx.helpers.rangeFromOffsets(
                ctx.file.path,
                ctx.file.text,
                handler.range[0],
                handler.body.range[0],
              ),
              confidence: "proven",
            },
          );
        }
      },
    };
  },
});

/** Options that leave the handler to run during SSR and its undefined result in the payload. */
function runsDuringSsrWithoutFallback(options: AnyNode): boolean {
  if (!options) return true;
  if (options.type !== "ObjectExpression") return false;
  return options.properties.every((property: AnyNode) => {
    if (property.type !== "Property" || property.computed) return false;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
    if (RESULT_OPTIONS.has(key)) return false;
    if (SSR_OPTIONS.has(key))
      return property.value.type === "Literal" && property.value.value === true;
    return true;
  });
}

/**
 * Whether the handler can resolve to a value: an expression body, a `return` with a value, or a
 * body that always throws.
 */
function returnsValue(handler: AnyNode): boolean {
  if (handler.body.type !== "BlockStatement") return true;
  const returns: AnyNode[] = [];
  const visit = (node: AnyNode) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (NESTED_SCOPES.has(node.type)) return;
    if (node.type === "ReturnStatement") returns.push(node);
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
  };
  handler.body.body.forEach(visit);
  if (returns.some((statement) => statement.argument && !isUndefined(statement.argument)))
    return true;
  return !returns.length && handler.body.body.at(-1)?.type === "ThrowStatement";
}

function isUndefined(node: AnyNode): boolean {
  return (
    (node.type === "Identifier" && node.name === "undefined") ||
    (node.type === "UnaryExpression" && node.operator === "void")
  );
}
