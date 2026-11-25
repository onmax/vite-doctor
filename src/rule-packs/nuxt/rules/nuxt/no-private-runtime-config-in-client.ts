import { resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { scriptNodesOfType } from "../../../../core/internal/script-index.js";
import { fileScriptScope, type ScriptScope } from "../../../../core/internal/script-scope.js";
import { diagnostics } from "../../diagnostics.js";
import { isRuntimeAppFile, nuxtSourcePath, resolveSameFile } from "./file-classification.js";
import { isNuxtAppExport, isVueLifecycleExport } from "./nuxt-app-binding.js";
import { excludesRuntime, isInlineCallback, scriptParents } from "./runtime-branches.js";
import { createRule, toPosixPath, type AnyNode } from "./shared.js";

const RULE_ID = "nuxt/runtime/no-private-runtime-config-in-client";
const GAP_SOURCE = "vite-doctor/nuxt-private-runtime-config";
// The client payload carries only these top-level runtimeConfig keys (nuxt/dist/app/nuxt.js).
const CLIENT_KEYS = new Set(["public", "app"]);
const SERVER_ONLY_FILE_RE = /\.(?:server|island(?:\.global)?)\.[^/]+$/;
// Components, pages, layouts, client plugins and route middleware run in the browser. Composables
// and utils can be called from server-only code, so they stay out of scope.
const CLIENT_CODE_RE = /(?:\.vue$|(?:^|\/)(?:plugins|middleware)\/)/;
// Nuxt renders pages, layouts and the app root on every client navigation. Other components run in
// the browser only when a client-rendered parent uses them, which this file Rule cannot see.
const CLIENT_ENTRY_RE = /^(?:(?:pages|layouts)\/|(?:app|error)\.vue$)/;
const ISLANDS_DIR_RE = /^components\/islands\//;
const SERVER_LIFECYCLE = new Set(["onServerPrefetch"]);

interface PrivateRead {
  key: string;
  node: AnyNode;
}

export const noPrivateRuntimeConfigInClient = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not read private runtimeConfig in client code",
    category: "runtime-config",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/going-further/runtime-config#reading",
    cacheScope: "none",
    requires: { script: true, nuxt: true, crossFile: true },
  },
  async create(ctx) {
    const nuxt = ctx.project.nuxt;
    const path = toPosixPath(ctx.file.relativePath);
    if (
      !nuxt ||
      (!path.endsWith(".vue") && SERVER_ONLY_FILE_RE.test(path)) ||
      !CLIENT_CODE_RE.test(path) ||
      !isRuntimeAppFile(ctx)
    )
      return;
    const sourcePath = nuxtSourcePath(ctx);
    const scope = fileScriptScope(ctx);
    if (!scope) return;
    const runsOnlyOnServer = (parents: Map<AnyNode, AnyNode>, node: AnyNode) =>
      excludesRuntime(
        parents,
        node,
        scope,
        "client",
        (call, child) =>
          call.callee.type === "Identifier" &&
          isInlineCallback(call, child) &&
          isVueLifecycleExport(scope.references.get(call.callee), nuxt, SERVER_LIFECYCLE),
        (test) => isRequestEvent(test, scope, nuxt),
      );
    const reads = clientReads(scope, runsOnlyOnServer, (reference) =>
      isNuxtAppExport(reference, nuxt, "useRuntimeConfig", "nuxt"),
    ).filter((read) => !CLIENT_KEYS.has(read.key));
    if (!reads.length) return;
    if (isServerComponent(ctx, sourcePath)) {
      const graph = await ctx.inventory.importGraph();
      // Nuxt registration wraps the component; a physical import can bypass the wrapper.
      if (!graph.importersOf(ctx.file.path).some((edge) => !edge.typeOnly)) return;
    }
    const component = path.endsWith(".vue") && !CLIENT_ENTRY_RE.test(sourcePath ?? "");
    return {
      Program() {
        const declared = topLevelKeys(nuxt.runtimeConfig);
        if (!declared) {
          recordUnknownKeys(ctx, reads[0]!.key);
          return;
        }
        const current = nuxt.manifest?.isCurrent === true;
        const confidence = component
          ? "heuristic-medium"
          : current
            ? "manifest-backed"
            : "heuristic-high";
        const unseenParents = component
          ? " Doctor did not check which components render this one; if only server components do, the read never reaches the browser."
          : "";
        for (const { key, node } of reads) {
          if (!declared.has(key)) continue;
          ctx.report(
            diagnostics.NUXT0102({
              why: `runtimeConfig.${key} is private, so it is undefined in the browser even though its type is not. Nuxt sends only runtimeConfig.public and runtimeConfig.app to the client, and in development it warns "Could not access \`${key}\`" (NUXT_E1003).${unseenParents}`,
              fix: `Move ${key} under runtimeConfig.public if it is safe to expose, or read it in a server route and fetch the result. Wrap reads that only run during SSR in if (import.meta.server).`,
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "runtime-config",
              file: ctx.file.path,
              range: ctx.helpers.rangeFromOffsets(
                ctx.file.path,
                ctx.file.text,
                node.range[0],
                node.range[1],
              ),
              confidence,
            },
          );
        }
      },
    };
  },
});

function isServerComponent(ctx: RuleContext, sourcePath: string | null): boolean {
  if (!ctx.file.relativePath.endsWith(".vue")) return false;
  const file = toPosixPath(resolve(ctx.project.root, ctx.file.path));
  const inventory = ctx.project.nuxt?.manifest;
  const entries = inventory?.resolvedComponents?.filter(
    (entry) =>
      typeof entry?.file === "string" &&
      resolveSameFile(toPosixPath(resolve(ctx.project.root, entry.file)), file),
  );
  if (entries?.length) return entries.every((entry) => entry.mode === "server");
  return (
    SERVER_ONLY_FILE_RE.test(file) ||
    (entries === undefined && sourcePath !== null && ISLANDS_DIR_RE.test(sourcePath))
  );
}

function topLevelKeys(config: unknown): Set<string> | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  return new Set(Object.keys(config));
}

function recordUnknownKeys(ctx: RuleContext, key: string) {
  const gaps = ctx.project.evidenceGaps ?? [];
  const existing = gaps.find((gap) => gap.source === GAP_SOURCE);
  const file = toPosixPath(ctx.file.relativePath);
  if (existing?.files.includes(file)) return;
  const gap = existing
    ? { ...existing, files: [...existing.files, file] }
    : {
        source: GAP_SOURCE,
        message: `Doctor cannot tell which runtimeConfig keys are private without the Doctor manifest, so it did not check client reads such as useRuntimeConfig().${key}. Run nuxt prepare with vite-doctor/nuxt to write .nuxt/doctor.manifest.json.`,
        files: [".nuxt/doctor.manifest.json", file],
      };
  ctx.project.evidenceGaps = [...gaps.filter((item) => item !== existing), gap];
}

/** Top-level key reads of `useRuntimeConfig()` results outside server-only branches. */
function clientReads(
  scope: ScriptScope,
  runsOnlyOnServer: (parents: Map<AnyNode, AnyNode>, node: AnyNode) => boolean,
  isUseRuntimeConfig: (reference: ReturnType<ScriptScope["references"]["get"]>) => boolean,
): PrivateRead[] {
  const parents = scriptParents(scope);
  const reads: PrivateRead[] = [];
  const readsOf = (value: AnyNode) => {
    const parent = outerParent(parents, value);
    if (parent?.type === "MemberExpression" && parent.object === skipWrappers(parents, value)) {
      const key = memberKey(parent);
      if (key) reads.push({ key, node: parent });
      return;
    }
    if (parent?.type !== "VariableDeclarator" || parent.init !== skipWrappers(parents, value))
      return;
    if (parent.id.type === "ObjectPattern") {
      for (const property of parent.id.properties) {
        if (property.type !== "Property") continue;
        const key = propertyKey(property);
        if (key) reads.push({ key, node: property.key });
      }
      return;
    }
    if (parent.id.type !== "Identifier") return;
    const variable = scope.scopeManager
      .getDeclaredVariables(parent)
      .find((item) => item.name === parent.id.name);
    if (
      !variable ||
      variable.references.some((ref) => ref.isWrite() && ref.writeExpr !== parent.init)
    )
      return;
    for (const reference of variable.references)
      if (reference.isRead()) readsOf(reference.identifier);
  };
  for (const call of scriptNodesOfType(scope.ast, "CallExpression")) {
    if (
      call.callee?.type !== "Identifier" ||
      call.arguments.length ||
      !isUseRuntimeConfig(scope.references.get(call.callee)) ||
      runsOnlyOnServer(parents, call)
    )
      continue;
    readsOf(call);
  }
  return reads.filter((read) => !runsOnlyOnServer(parents, read.node));
}

const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]);

function outerParent(parents: Map<AnyNode, AnyNode>, node: AnyNode): AnyNode {
  return parents.get(skipWrappers(parents, node));
}

function skipWrappers(parents: Map<AnyNode, AnyNode>, node: AnyNode): AnyNode {
  let current = node;
  while (WRAPPERS.has(parents.get(current)?.type)) current = parents.get(current);
  return current;
}

function memberKey(node: AnyNode): string | undefined {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return typeof node.property.value === "string" ? node.property.value : undefined;
}

function propertyKey(node: AnyNode): string | undefined {
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  return typeof node.key.value === "string" ? node.key.value : undefined;
}

function isRequestEvent(
  test: AnyNode,
  scope: ScriptScope,
  nuxt: NonNullable<RuleContext["project"]["nuxt"]>,
): boolean {
  const call = (node: AnyNode) =>
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.arguments.length === 0 &&
    isNuxtAppExport(scope.references.get(node.callee), nuxt, "useRequestEvent", "composables/ssr");
  if (call(test)) return true;
  if (test.type !== "Identifier") return false;
  const binding = scope.references.get(test)?.resolved;
  const def = binding?.defs[0];
  if (!binding || binding.defs.length !== 1 || def?.type !== "Variable") return false;
  const declaration = def.node as AnyNode;
  return (
    declaration.id === def.name &&
    call(declaration.init) &&
    declaration.range[1] < test.range[0] &&
    !binding.references.some((ref) => ref.isWrite() && ref.writeExpr !== declaration.init)
  );
}
