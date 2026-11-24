import type { RuleContext } from "../../../../core/index.js";
import { fileScriptScope, type ScriptScope } from "../../../../core/internal/script-scope.js";
import { diagnostics } from "../../diagnostics.js";
import { isRuntimeAppFile } from "./file-classification.js";
import { isNuxtAppExport } from "./nuxt-app-binding.js";
import { scriptNodesOfType } from "./script-index.js";
import { createRule, toPosixPath, type AnyNode } from "./shared.js";

const RULE_ID = "nuxt/runtime/no-private-runtime-config-in-client";
const GAP_SOURCE = "vite-doctor/nuxt-private-runtime-config";
// The client payload carries only these top-level runtimeConfig keys (nuxt/dist/app/nuxt.js).
const CLIENT_KEYS = new Set(["public", "app"]);
const SERVER_ONLY_FILE_RE = /\.(?:server|island(?:\.global)?)\.[^/]+$/;
// Components, pages, layouts, client plugins and route middleware run in the browser. Composables
// and utils can be called from server-only code, so they stay out of scope.
const CLIENT_CODE_RE = /(?:\.vue$|(?:^|\/)(?:plugins|middleware)\/)/;
const CLIENT_FLAGS = new Set([
  "import.meta.client",
  "import.meta.browser",
  "process.client",
  "process.browser",
]);
const SERVER_FLAGS = new Set(["import.meta.server", "import.meta.env.SSR", "process.server"]);
// A test that names the server or the request event is taken as a server guard Doctor can't read.
const SERVER_HINT_RE = /server|ssr|requestevent|\bevent\b/i;

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
    requires: { script: true, nuxt: true },
    prefilter: { calls: ["useRuntimeConfig"] },
  },
  create(ctx) {
    const nuxt = ctx.project.nuxt;
    const path = toPosixPath(ctx.file.relativePath);
    if (
      !nuxt ||
      SERVER_ONLY_FILE_RE.test(path) ||
      !CLIENT_CODE_RE.test(path) ||
      !isRuntimeAppFile(ctx)
    )
      return;
    return {
      Program() {
        const scope = fileScriptScope(ctx);
        if (!scope) return;
        const reads = clientReads(scope, ctx.file.text, (reference) =>
          isNuxtAppExport(reference, nuxt, "useRuntimeConfig", "nuxt"),
        ).filter((read) => !CLIENT_KEYS.has(read.key));
        if (!reads.length) return;
        const declared = topLevelKeys(nuxt.runtimeConfig);
        if (!declared) {
          recordUnknownKeys(ctx, reads[0]!.key);
          return;
        }
        const current = nuxt.manifest?.isCurrent === true;
        for (const { key, node } of reads) {
          if (!declared.has(key)) continue;
          ctx.report(
            diagnostics.NUXT0102({
              why: `runtimeConfig.${key} is private, so it is undefined in the browser even though its type is not. Nuxt sends only runtimeConfig.public and runtimeConfig.app to the client, and in development it warns "Could not access \`${key}\`" (NUXT_E1003).`,
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
              confidence: current ? "manifest-backed" : "heuristic-high",
            },
          );
        }
      },
    };
  },
});

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
  text: string,
  isUseRuntimeConfig: (reference: ReturnType<ScriptScope["references"]["get"]>) => boolean,
): PrivateRead[] {
  const parents = parentMap(scope);
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
      runsOnlyOnServer(parents, call, text)
    )
      continue;
    readsOf(call);
  }
  return reads.filter((read) => !runsOnlyOnServer(parents, read.node, text));
}

function parentMap(scope: ScriptScope): Map<AnyNode, AnyNode> {
  const parents = new Map<AnyNode, AnyNode>();
  const visit = (node: AnyNode) => {
    for (const key of scope.visitorKeys[node.type] ?? []) {
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child?.type) continue;
        parents.set(child, node);
        visit(child);
      }
    }
  };
  visit(scope.ast);
  return parents;
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

function runsOnlyOnServer(parents: Map<AnyNode, AnyNode>, node: AnyNode, text: string): boolean {
  const hintsServer = (test: AnyNode) =>
    SERVER_HINT_RE.test(text.slice(test.range[0], test.range[1]));
  let child = node;
  for (let parent = parents.get(node); parent; child = parent, parent = parents.get(parent)) {
    if (parent.type === "IfStatement" || parent.type === "ConditionalExpression") {
      if (child === parent.test) continue;
      const side = runtimeSide(parent.test);
      if (side === (child === parent.consequent ? "server" : "client")) return true;
      if (side === undefined && hintsServer(parent.test)) return true;
    } else if (parent.type === "LogicalExpression" && child === parent.right) {
      const side = runtimeSide(parent.left);
      if (side === (parent.operator === "&&" ? "server" : "client")) return true;
      if (side === undefined && hintsServer(parent.left)) return true;
    } else if (parent.type === "BlockStatement" || parent.type === "Program") {
      const index = parent.body.indexOf(child);
      if (parent.body.slice(0, index).some(isClientExit)) return true;
    } else if (
      parent.type === "CallExpression" &&
      parent.callee.type === "Identifier" &&
      parent.callee.name === "onServerPrefetch" &&
      parent.arguments.includes(child)
    )
      return true;
  }
  return false;
}

/** `if (import.meta.client) return`: what follows runs only on the server. */
function isClientExit(statement: AnyNode): boolean {
  if (statement.type !== "IfStatement" || statement.alternate) return false;
  if (runtimeSide(statement.test) !== "client") return false;
  const body =
    statement.consequent.type === "BlockStatement"
      ? statement.consequent.body.at(-1)
      : statement.consequent;
  return body?.type === "ReturnStatement" || body?.type === "ThrowStatement";
}

function runtimeSide(test: AnyNode): "client" | "server" | undefined {
  if (test.type === "UnaryExpression" && test.operator === "!") {
    const side = runtimeSide(test.argument);
    return side && (side === "client" ? "server" : "client");
  }
  if (test.type === "LogicalExpression" && test.operator === "&&") {
    const left = runtimeSide(test.left);
    const right = runtimeSide(test.right);
    return left ?? right;
  }
  if (test.type === "BinaryExpression" && /^[!=]==?$/.test(test.operator)) {
    const [typeOf, literal] =
      test.left.type === "UnaryExpression" ? [test.left, test.right] : [test.right, test.left];
    if (
      typeOf.type !== "UnaryExpression" ||
      typeOf.operator !== "typeof" ||
      typeOf.argument.type !== "Identifier" ||
      !["window", "document"].includes(typeOf.argument.name) ||
      literal.value !== "undefined"
    )
      return undefined;
    return test.operator.startsWith("=") ? "server" : "client";
  }
  const name = memberPath(test);
  if (name && CLIENT_FLAGS.has(name)) return "client";
  if (name && SERVER_FLAGS.has(name)) return "server";
  return undefined;
}

function memberPath(node: AnyNode): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MetaProperty") return `${node.meta.name}.${node.property.name}`;
  if (node.type !== "MemberExpression" || node.computed) return undefined;
  const object = memberPath(node.object);
  return object && `${object}.${node.property.name}`;
}
