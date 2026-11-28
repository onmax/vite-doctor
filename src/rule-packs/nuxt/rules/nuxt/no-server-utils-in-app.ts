import { relative } from "pathe";
import { gte, valid } from "semver";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule, toPosixPath } from "./shared.js";
import {
  boundaryFile,
  importSource,
  importVisitor,
  isInside,
  isTypeOnly,
  layerFor,
  resolveSpecifier,
  rootLayer,
  staticString,
  type BoundaryFile,
} from "./import-boundaries.js";
import { diagnostics } from "../../diagnostics.js";

const VALUE_RULE_ID = "nuxt/structure/no-server-utils-in-app";
const TYPE_RULE_ID = "nuxt/structure/no-server-types-in-app";
const NUXT_PROTECTED_SERVER_SUBDIR = /^(api|routes|middleware|plugins)(\/|$)/;

interface ServerImport {
  node: AnyNode;
  specifier: string;
  target: string;
  typeOnly: boolean;
}

type ClientSide = "app" | "shared";

export const noServerUtilsInApp = createRule({
  meta: {
    id: VALUE_RULE_ID,
    title: "Do not import server code into app or shared code",
    category: "architecture",
    severity: "error",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/shared",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return serverImportVisitor(ctx, false, (found, side) => {
      ctx.report(
        diagnostics.NUXT0075({
          why: `${found.specifier} resolves to ${found.target}, which Nuxt's import protection does not block. Importing it from ${side} code bundles server code into the client.`,
          fix: "Move code needed by both sides to shared/utils/, which Nuxt auto-imports in the app and the server. Call server-only logic through an API route with $fetch() or useFetch().",
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

export const noServerTypesInApp = createRule({
  meta: {
    id: TYPE_RULE_ID,
    title: "Keep types shared by app and server in shared/types",
    category: "architecture",
    severity: "info",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/shared",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return serverImportVisitor(ctx, true, (found, side) => {
      ctx.report(
        diagnostics.NUXT0076({
          why: `${side === "app" ? "App" : "Shared"} code imports types from ${found.target}, which couples it to server internals.`,
          fix: "Move the shared types to shared/types/, which Nuxt auto-imports in the app and the server, and import them from there in server code too.",
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

function serverImportVisitor(
  ctx: RuleContext,
  typeOnly: boolean,
  onImport: (found: ServerImport, side: ClientSide) => void,
) {
  const importer = boundaryFile(ctx);
  if (!importer || importer.side === "server") return;
  const side = importer.side;
  return importVisitor((node) => {
    const found = serverImport(ctx, node, importer);
    if (found && found.typeOnly === typeOnly) onImport(found, side);
  });
}

function serverImport(
  ctx: RuleContext,
  node: AnyNode,
  { file, layer, layers }: BoundaryFile,
): ServerImport | undefined {
  const source = importSource(node);
  if (!source) return;
  const specifier = staticString(source);
  if (!specifier) return;
  const resolved = resolveSpecifier(ctx, specifier, file, layer);
  if (!resolved) return;
  const targetLayer = layerFor(resolved, layers, ctx.project.root);
  const serverDir = targetLayer.serverDirs.find((dir) => isInside(resolved, dir));
  if (!serverDir) return;
  const foundTypeOnly = isTypeOnly(node);
  const isRootLayer = targetLayer.root === toPosixPath(ctx.project.root);
  if (
    isRootLayer &&
    !foundTypeOnly &&
    NUXT_PROTECTED_SERVER_SUBDIR.test(relative(serverDir, resolved)) &&
    nuxtProtectsServerDir(ctx)
  )
    return;
  return {
    node: source,
    specifier,
    target: toPosixPath(relative(ctx.project.root, resolved)) || ".",
    typeOnly: foundTypeOnly,
  };
}

// Before 4.4.0 Nuxt built the pattern relative to srcDir, so with srcDir app/ it was
// `../server/(api|...)/` and never matched the rootDir-relative paths impound checks.
function nuxtProtectsServerDir(ctx: RuleContext) {
  const nuxt = ctx.project.runtimeGraph?.packages.nuxt;
  const version = nuxt?.state === "resolved" && valid(nuxt.version) ? nuxt.version! : undefined;
  if (!version || gte(version, "4.4.0")) return true;
  const root = rootLayer(ctx);
  return !root.srcDir || root.srcDir === root.root;
}
