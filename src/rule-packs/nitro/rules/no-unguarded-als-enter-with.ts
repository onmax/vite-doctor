import { join } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { owningWorkspacePackage } from "../../../core/internal/workspace-packages.js";
import { type AnyNode, createRule, report } from "./shared.js";

const RULE_ID = "nitro/cloudflare/no-unguarded-als-enterwith";
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const CLOUDFLARE_PACKAGES = [
  "wrangler",
  "miniflare",
  "@cloudflare/workers-types",
  "@cloudflare/vite-plugin",
  "@cloudflare/vitest-pool-workers",
  "@cloudflare/vitest-plugin",
  "nitro-cloudflare-dev",
];
const CLOUDFLARE_KEYWORDS = new Set(["cloudflare", "cloudflare-workers", "workerd"]);
const WRANGLER_CONFIGS = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
const HOST_CONFIGS = ["nitro", "nuxt", "vite"].flatMap((name) =>
  ["ts", "mts", "cts", "js", "mjs", "cjs"].map((extension) => `${name}.config.${extension}`),
);
const CLOUDFLARE_PRESET = /\bpreset\s*:\s*["'`]cloudflare/i;
const CLOUDFLARE_PRESET_ENV = /\bNITRO_PRESET=["']?cloudflare/i;
const CLOUDFLARE_MODULE = /\b(?:from|import|require)\s*\(?\s*["'`]cloudflare:/;
const ASYNC_LOCAL_STORAGE = /\bAsyncLocalStorage\b|\basync_hooks\b/;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|e2e)\/|\.(?:spec|test)\.[cm]?[jt]sx?$/;

export const noUnguardedAlsEnterWith = createRule({
  meta: {
    id: RULE_ID,
    title: "Guard AsyncLocalStorage#enterWith on Cloudflare",
    category: "runtime",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/",
    requires: { script: true, nitro: true },
    prefilter: { names: ["enterWith"] },
  },
  create(ctx) {
    if (TEST_FILE.test(ctx.file.relativePath.replace(/\\/g, "/"))) return;
    if (!ASYNC_LOCAL_STORAGE.test(ctx.file.text)) return;
    return {
      CallExpression(node: AnyNode) {
        const callee = node.callee;
        if (callee?.type !== "MemberExpression") return;
        const property = callee.computed ? staticKey(callee.property) : callee.property?.name;
        if (property !== "enterWith") return;
        if (isInsideTry(node) || !targetsCloudflare(ctx)) return;
        report(
          ctx,
          callee.property,
          RULE_ID,
          "error",
          "runtime",
          "AsyncLocalStorage#enterWith() is not implemented in workerd: Cloudflare Workers throw `asyncLocalStorage.enterWith() is not implemented` on this call, even with nodejs_compat.",
          "Run the work inside als.run(store, callback). If the call must stay, wrap it in try/catch and fall back to state that does not depend on enterWith().",
        );
      },
    };
  },
});

function isInsideTry(node: AnyNode) {
  for (let child = node, current = node.__doctorParent; current;) {
    if (FUNCTION_TYPES.has(current.type) && !isInvokedInPlace(current)) return false;
    if (current.type === "TryStatement" && current.block === child && current.handler)
      return !alwaysThrows(current.handler);
    child = current;
    current = current.__doctorParent;
  }
  return false;
}

// `(() => storage.enterWith(event))()` runs inside the surrounding try.
function isInvokedInPlace(fn: AnyNode) {
  if (fn.async || fn.generator) return false;
  let node = fn;
  let parent = fn.__doctorParent;
  while (parent?.type === "ParenthesizedExpression") {
    node = parent;
    parent = parent.__doctorParent;
  }
  return parent?.type === "CallExpression" && parent.callee === node;
}

function alwaysThrows(handler: AnyNode) {
  return (handler.body?.body ?? []).some(
    (statement: AnyNode) => statement.type === "ThrowStatement",
  );
}

// Project Inventory evidence that the code owned by this workspace package runs in workerd.
function targetsCloudflare(ctx: RuleContext) {
  if (CLOUDFLARE_MODULE.test(ctx.file.text)) return true;
  const packages = projectWorkspacePackages(ctx.project);
  const root = owningWorkspacePackage(packages, ctx.file.relativePath.replace(/\\/g, "/"));
  const key = `nitro:cloudflare-target:${root}`;
  let target = ctx.cache.get<boolean>(key);
  if (target === undefined) {
    target = hasCloudflareEvidence(
      ctx,
      root,
      packages.find((item) => item.root === root)?.packages ?? {},
    );
    ctx.cache.set(key, target);
  }
  return target;
}

function hasCloudflareEvidence(ctx: RuleContext, root: string, packages: Record<string, string>) {
  if (CLOUDFLARE_PACKAGES.some((name) => name in packages)) return true;
  const directory = join(ctx.project.root, root);
  if (WRANGLER_CONFIGS.some((file) => ctx.fs.exists(join(directory, file)))) return true;
  const manifest = ctx.fs.readJson(join(directory, "package.json")) as {
    keywords?: unknown;
  } | null;
  if (
    Array.isArray(manifest?.keywords) &&
    manifest.keywords.some(
      (keyword) => typeof keyword === "string" && CLOUDFLARE_KEYWORDS.has(keyword.toLowerCase()),
    )
  )
    return true;
  const scripts = Object.values((manifest as { scripts?: unknown } | null)?.scripts ?? {});
  if (scripts.some((script) => typeof script === "string" && CLOUDFLARE_PRESET_ENV.test(script)))
    return true;
  return HOST_CONFIGS.some((file) =>
    CLOUDFLARE_PRESET.test(stripComments(ctx.fs.readText(join(directory, file)) ?? "")),
  );
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function staticKey(node: AnyNode): string | undefined {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value?.cooked;
  return undefined;
}
