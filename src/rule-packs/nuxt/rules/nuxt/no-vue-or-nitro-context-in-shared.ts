import { builtinModules } from "node:module";
import { AnyNode, NUXT_AUTO_IMPORTS, createRule, report } from "./shared.js";
import {
  boundaryFile,
  importSource,
  importVisitor,
  isTypeOnly,
  layerFor,
  resolveSpecifier,
  sideOf,
  staticString,
  type BoundaryFile,
} from "./import-boundaries.js";
import type { RuleContext } from "../../../../core/index.js";

const RULE_ID = "nuxt/shared/no-vue-or-nitro-context-in-shared";
const RUNTIME_PACKAGES = new Set(["vue", "nuxt", "nuxt/app", "h3", "nitropack"]);
const RUNTIME_ALIASES = /^(?:#app|#imports|#ui|nitropack\/runtime|nitro)(?:\/|$)/;
// Bare names that browser polyfill packages also publish, such as `events` or `buffer`; only
// their `node:` form is unambiguous.
const POLYFILLED = new Set(
  "assert buffer console constants crypto domain events http https os path punycode process querystring stream string_decoder sys timers tty url util vm zlib".split(
    " ",
  ),
);
const NODE_BUILTINS = new Set(builtinModules.filter((name) => !POLYFILLED.has(name)));

export const noVueOrNitroContextInShared = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep shared code runtime-neutral",
    category: "architecture",
    severity: "error",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/shared#usage",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const importer = boundaryFile(ctx);
    if (importer?.side !== "shared") return;
    const visitCall = (node: AnyNode) => {
      const name = ctx.helpers.getCalleeName(node);
      if (!name || !NUXT_AUTO_IMPORTS.has(name)) return;
      report(
        ctx,
        node,
        RULE_ID,
        "error",
        "architecture",
        "shared/ code should not call Nuxt app composables or Nitro context helpers.",
        "Move context-aware logic into app/ or server/ and keep shared/ utilities pure.",
      );
    };
    return {
      ...importVisitor((node) => {
        const source = importSource(node);
        const specifier = source && staticString(source);
        if (!specifier || isTypeOnly(node)) return;
        const problem = sharedImportProblem(ctx, specifier, importer);
        if (problem) report(ctx, source, RULE_ID, "error", "architecture", ...problem);
      }),
      MemberExpression(node: AnyNode) {
        if (!isProcessEnvRead(ctx, node)) return;
        report(
          ctx,
          node,
          RULE_ID,
          "error",
          "architecture",
          "shared/ code reads process.env, which holds the server's environment on the server and is empty or replaced at build time in the browser.",
          "Pass the value in as a parameter, and read it with useRuntimeConfig() in app/ or server/ code.",
        );
      },
      CallExpression: visitCall,
      NewExpression: visitCall,
    };
  },
});

function sharedImportProblem(
  ctx: RuleContext,
  specifier: string,
  importer: BoundaryFile,
): [message: string, suggestion: string] | undefined {
  if (RUNTIME_PACKAGES.has(specifier) || RUNTIME_ALIASES.test(specifier))
    return [
      `shared/ code imports ${specifier}, which needs the Vue app or the Nitro runtime. shared/ code should be usable by both without that context.`,
      "Move Vue composables to app/composables/, Nitro utilities to server/utils/, or keep shared/ pure.",
    ];
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier))
    return [
      `shared/ code imports the Node API ${specifier}, which is not available when the app bundle runs in the browser.`,
      "Move code that needs Node to server/utils/, or pass its result into the shared function.",
    ];
  const resolved = resolveSpecifier(ctx, specifier, importer);
  if (resolved && sideOf(resolved, layerFor(ctx, resolved, importer.layers)) === "app")
    return [
      `shared/ code imports ${specifier}, which resolves to app code. The server also runs shared/ code and cannot use the app's components, composables or auto-imports.`,
      "Move the code both sides need into shared/, or keep the caller in app/.",
    ];
}

// `process.env.NODE_ENV` is replaced at build time on both sides.
function isProcessEnvRead(ctx: RuleContext, node: AnyNode) {
  if ((node.computed ? staticString(node.property) : node.property?.name) !== "env") return false;
  if (node.object?.type !== "Identifier" || node.object.name !== "process") return false;
  if (ctx.helpers.isTypeOnlyContext(node) || ctx.helpers.hasLocalBinding(node.object)) return false;
  const parent = node.parent ?? node.__doctorParent;
  const access = parent?.type === "MemberExpression" && parent.object === node ? parent : node;
  if (isWriteOnly(access)) return false;
  return (
    access === node || node.computed || access.computed || access.property?.name !== "NODE_ENV"
  );
}

function isWriteOnly(node: AnyNode) {
  const parent = node.parent ?? node.__doctorParent;
  return (
    (parent?.type === "AssignmentExpression" && parent.left === node && parent.operator === "=") ||
    (parent?.type === "UnaryExpression" && parent.operator === "delete" && parent.argument === node)
  );
}
