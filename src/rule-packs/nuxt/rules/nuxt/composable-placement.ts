import { basename } from "pathe";
import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";
import {
  createModuleScope,
  exportedFunctions,
  importSources,
  isAnalyzableScript,
  mayUseFrameworkApi,
  nuxtSourceDirectory,
  setupContextSignal,
} from "./composable-analysis.js";

const COMPOSABLE_IN_UTILS = "nuxt/structure/no-composable-in-utils";
const STATELESS_COMPOSABLE = "nuxt/structure/no-stateless-composable";

export const noComposableInUtils = createRule({
  meta: {
    id: COMPOSABLE_IN_UTILS,
    title: "Keep setup-bound functions out of utils/",
    category: "architecture",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/directory-structure/app/utils",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isAnalyzableScript(ctx) || nuxtSourceDirectory(ctx) !== "utils") return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const imports = importSources(node);
        for (const exported of exportedFunctions(node)) {
          const signal = setupContextSignal(exported.fn, imports, node);
          if (!signal) continue;
          const name = exported.isDefault ? fileExportName(ctx.file.path) : exported.name;
          const target = /^use[A-Z0-9]/.test(name) ? name : `use${upperFirst(name)}`;
          ctx.report(
            diagnostics.NUXT0077({
              why: `${name}() calls ${signal}(), so it only works during component setup or inside another composable, but utils/ is where Nuxt auto-imports plain helpers.`,
              fix: `Move ${name} to composables/ and name it ${target} so callers know to call it from setup.`,
            }),
            {
              ruleId: COMPOSABLE_IN_UTILS,
              severity: ctx.severity,
              category: "architecture",
              file: ctx.file.path,
              range: ctx.range(exported.nameNode),
            },
          );
        }
      },
    };
  },
});

export const noStatelessComposable = createRule({
  meta: {
    id: STATELESS_COMPOSABLE,
    title: "Move plain helpers out of composables/",
    category: "architecture",
    severity: "info",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/directory-structure/app/utils",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isAnalyzableScript(ctx) || nuxtSourceDirectory(ctx) !== "composables") return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const scope = createModuleScope(ctx, node);
        for (const exported of exportedFunctions(node)) {
          if (exported.isDefault || !/^use[A-Z0-9]/.test(exported.name)) continue;
          if (mayUseFrameworkApi(exported.fn, scope)) continue;
          const helperName = lowerFirst(exported.name.slice(3));
          ctx.report(
            diagnostics.NUXT0078({
              why: `${exported.name}() is exported from composables/ but uses no Vue or Nuxt API and calls no composable, so it is a plain helper that can run anywhere.`,
              fix: `Move ${exported.name} to utils/ and rename it to ${helperName} so the use prefix keeps meaning "call from setup".`,
            }),
            {
              ruleId: STATELESS_COMPOSABLE,
              severity: ctx.severity,
              category: "architecture",
              file: ctx.file.path,
              range: ctx.range(exported.nameNode),
            },
          );
        }
      },
    };
  },
});

function fileExportName(path: string) {
  const name = basename(path).replace(/\.[^.]+$/, "");
  return /[-_.]/.test(name)
    ? lowerFirst(name.split(/[-_.]/).filter(Boolean).map(upperFirst).join(""))
    : name;
}

function upperFirst(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function lowerFirst(value: string) {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}
