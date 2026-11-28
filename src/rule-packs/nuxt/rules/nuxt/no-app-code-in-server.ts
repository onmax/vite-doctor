import { relative } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule, toPosixPath } from "./shared.js";
import {
  boundaryFile,
  importSource,
  importVisitor,
  isTypeOnly,
  layerFor,
  resolveSpecifier,
  sideOf,
  staticString,
} from "./import-boundaries.js";
import { diagnostics } from "../../diagnostics.js";

const VALUE_RULE_ID = "nuxt/structure/no-app-code-in-server";
const TYPE_RULE_ID = "nuxt/structure/no-app-types-in-server";
// Nuxt rejects #app in server code and generates #build; neither is the developer's app code.
const NUXT_OWNED = /^#(?:app|build)(?:\/|$)/;
// JSON, styles and images from the app carry no app runtime into the server bundle.
const DATA_FILE =
  /\.(?:json5?|css|s[ac]ss|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|txt|md|ya?ml|toml|csv)$/i;

interface AppImport {
  node: AnyNode;
  specifier: string;
  target: string;
  typeOnly: boolean;
}

export const noAppCodeInServer = createRule({
  meta: {
    id: VALUE_RULE_ID,
    title: "Do not import app code into server code",
    category: "architecture",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/shared",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return appImportVisitor(ctx, false, (found) => {
      ctx.report(
        diagnostics.NUXT0108({
          why: `${found.specifier} resolves to ${found.target}, which is app code. Nuxt does not block it, so Nitro bundles it into the server build, where the app's auto-imports, plugins and browser APIs are not available.`,
          fix: "Move code needed by both sides to shared/utils/, which Nuxt auto-imports in the app and the server. Keep code that needs the Vue app in app/.",
        }),
        {
          ruleId: VALUE_RULE_ID,
          severity: "error",
          category: "architecture",
          file: ctx.file.path,
          range: ctx.range(found.node),
        },
      );
    });
  },
});

export const noAppTypesInServer = createRule({
  meta: {
    id: TYPE_RULE_ID,
    title: "Keep types shared by server and app in shared/types",
    category: "architecture",
    severity: "info",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/shared",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return appImportVisitor(ctx, true, (found) => {
      ctx.report(
        diagnostics.NUXT0109({
          why: `Server code imports types from ${found.target}, which couples it to app internals.`,
          fix: "Move the shared types to shared/types/, which Nuxt auto-imports in the app and the server, and import them from there in app code too.",
        }),
        {
          ruleId: TYPE_RULE_ID,
          severity: "info",
          category: "architecture",
          file: ctx.file.path,
          range: ctx.range(found.node),
        },
      );
    });
  },
});

function appImportVisitor(
  ctx: RuleContext,
  typeOnly: boolean,
  onImport: (found: AppImport) => void,
) {
  const importer = boundaryFile(ctx);
  if (importer?.side !== "server") return;
  return importVisitor((node) => {
    const source = importSource(node);
    const specifier = source && staticString(source);
    if (!specifier || NUXT_OWNED.test(specifier)) return;
    const resolved = resolveSpecifier(ctx, specifier, importer);
    if (!resolved || DATA_FILE.test(resolved)) return;
    const targetLayer = layerFor(ctx, resolved, importer.layers);
    if (sideOf(resolved, targetLayer) !== "app") return;
    const found = {
      node: source,
      specifier,
      target: toPosixPath(relative(ctx.project.root, resolved)) || ".",
      typeOnly: isTypeOnly(node),
    };
    if (found.typeOnly === typeOnly) onImport(found);
  });
}
