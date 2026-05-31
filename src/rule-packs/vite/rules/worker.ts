import { dirname, resolve } from "pathe";
import { createRule, type RuleContext } from "../../../core/index.js";
import { memberPath, readProjectSources, staticString, type AnyNode } from "./shared.js";
import { diagnostics } from "../../../diagnostics.js";

export const requireWorkerUrlPattern = createRule({
  meta: {
    id: "vite/worker/require-worker-url-pattern",
    title: "Use Vite's static worker URL pattern",
    category: "workers",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/features.html#web-workers",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!isWorkerConstructor(node)) return;
        if (isFixturePath(ctx.file.relativePath)) return;
        const first = node.arguments?.[0];
        if (isStaticNewUrlWithImportMeta(first)) return;
        if (!isStaticStringOrNewUrl(first)) return;
        ctx.report(
          diagnostics.VITE0021({
            why: "Worker paths should use new URL('./worker', import.meta.url) for Vite bundling.",
            fix: "Construct workers with new Worker(new URL('./worker.ts', import.meta.url)).",
          }),
          {
            ruleId: "vite/worker/require-worker-url-pattern",
            severity: ctx.severity,
            category: "workers",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const noDynamicWorkerUrl = createRule({
  meta: {
    id: "vite/worker/no-dynamic-worker-url",
    title: "Keep Vite worker URLs static",
    category: "workers",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/features.html#web-workers",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!isWorkerConstructor(node)) return;
        const first = node.arguments?.[0];
        if (isFixturePath(ctx.file.relativePath)) return;
        if (first?.type !== "NewExpression" || first.callee?.name !== "URL") return;
        if (staticString(first.arguments?.[0])) return;
        ctx.report(
          diagnostics.VITE0019({
            why: "Dynamic worker URLs cannot be statically bundled by Vite.",
            fix: "Use static worker paths or explicit worker entry imports.",
          }),
          {
            ruleId: "vite/worker/no-dynamic-worker-url",
            severity: ctx.severity,
            category: "workers",
            file: ctx.file.path,
            range: ctx.range(first),
          },
        );
      },
    };
  },
});

export const noNodeApiInWorker = createRule({
  meta: {
    id: "vite/worker/no-node-api-in-worker",
    title: "Do not use Node APIs in browser workers",
    category: "workers",
    severity: "error",
    docsUrl: "https://vite.dev/guide/features.html#web-workers",
    requires: { script: true },
  },
  async create(ctx) {
    if (isServerSidePath(ctx.file.relativePath)) return;
    const workerEntries = await browserWorkerEntries(ctx);
    if (!isExplicitWorkerEntry(ctx.file.relativePath) && !workerEntries.has(ctx.file.path)) return;
    return {
      ImportDeclaration(node: AnyNode) {
        const source = String(node.source?.value ?? "");
        if (!isNodeModule(source)) return;
        ctx.report(
          diagnostics.VITE0020({
            why: `Browser worker "${ctx.file.relativePath}" imports Node module "${source}".`,
            fix: "Move Node work to server code or replace it with browser-compatible APIs.",
          }),
          {
            ruleId: "vite/worker/no-node-api-in-worker",
            severity: ctx.severity,
            category: "workers",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || node.name !== "process") return;
        ctx.report(
          diagnostics.VITE0020({
            why: "Browser workers should not rely on process.",
            fix: "Use import.meta.env for compile-time public values.",
          }),
          {
            ruleId: "vite/worker/no-node-api-in-worker",
            severity: ctx.severity,
            category: "workers",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

function isWorkerConstructor(node: AnyNode): boolean {
  return (
    node?.type === "NewExpression" &&
    (node.callee?.name === "Worker" || node.callee?.name === "SharedWorker")
  );
}

function isStaticNewUrlWithImportMeta(node: AnyNode): boolean {
  return Boolean(
    node?.type === "NewExpression" &&
    node.callee?.name === "URL" &&
    staticString(node.arguments?.[0]) &&
    memberPath(node.arguments?.[1]) === "import.meta.url",
  );
}

function isStaticStringOrNewUrl(node: AnyNode): boolean {
  return Boolean(staticString(node) || node?.type === "NewExpression");
}

function isNodeModule(source: string): boolean {
  return (
    source.startsWith("node:") ||
    ["fs", "path", "crypto", "child_process", "worker_threads", "stream"].includes(source)
  );
}

function isExplicitWorkerEntry(path: string): boolean {
  return /\.worker\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)workers?\/.+\.[cm]?[jt]sx?$/.test(path);
}

function isServerSidePath(path: string): boolean {
  return /(?:^|\/)(?:src\/node|server|node|packages\/vite\/src\/node)\//.test(path);
}

function isFixturePath(path: string): boolean {
  return /(?:^|\/)(?:playground|fixtures?|test|tests|__tests__)\//.test(path);
}

async function browserWorkerEntries(ctx: RuleContext) {
  const cacheKey = "vite:browser-worker-entries";
  const cached = ctx.cache.get<Set<string>>(cacheKey);
  if (cached) return cached;
  const entries = new Set<string>();
  for (const source of await readProjectSources(ctx)) {
    if (isServerSidePath(source.file)) continue;
    for (const match of source.text.matchAll(
      /new\s+(?:Shared)?Worker\s*\(\s*new\s+URL\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g,
    )) {
      entries.add(resolve(dirname(source.file), match[1]!));
    }
    for (const match of source.text.matchAll(/from\s+["'`]([^"'`?]+)\?worker(?:&[^"'`]*)?["'`]/g)) {
      entries.add(resolve(dirname(source.file), match[1]!));
    }
  }
  ctx.cache.set(cacheKey, entries);
  return entries;
}
