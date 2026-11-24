import { join } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { createRule } from "./shared.js";
import {
  hasCustomScanIgnore,
  isNitroScannedScript,
  nitro3ScanPath,
  nitroRouteFile,
  runtimeMajor,
} from "./server-layout.js";

const RULE_ID = "nitro/routes/no-shadowed-file-handler";
const NITRO2_SUFFIX =
  /(\.(?<method>connect|delete|get|head|options|patch|post|put|trace))?(\.(?<env>dev|prod|prerender))?$/;

export const noShadowedFileHandler = createRule({
  meta: {
    id: RULE_ID,
    title: "Don't let two route files resolve to the same route",
    category: "routing",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/routing#filesystem-routing",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    const routeFile = nitroRouteFile(ctx, ctx.file.path);
    if (!routeFile || hasCustomScanIgnore(ctx)) return;
    return {
      Program() {
        const winner = shadowingFile(ctx, routeFile.serverDir, routeFile.dir, routeFile.path);
        if (!winner) return;
        ctx.helpers.report(
          ctx,
          null,
          diagnostics.NITRO0031({
            why: `${routeFile.path} resolves to the same route, method and environment as ${winner}. Nitro registers the first file it scans for each route and silently drops the others, so ${winner} serves this route and this file never runs.`,
            fix: "Delete or rename one of the two files. Keep one handler per route, or add a method suffix such as .get.ts or .post.ts when the files handle different methods.",
          }),
          { ruleId: RULE_ID, severity: "error", category: "routing", range: ctx.range(0) },
        );
      },
    };
  },
});

/** The file in the same scan directory that Nitro keeps for this file's route, if any. */
function shadowingFile(ctx: RuleContext, serverDir: string, dir: string, path: string) {
  const version = (runtimeMajor(ctx.project, "nitro") ?? 2) >= 3 ? 3 : 2;
  const own = routeKey(path.slice(dir.length + 1), version);
  if (own === undefined) return undefined;
  const root = join(serverDir, dir);
  const cacheKey = `nitro:route-candidates:${version}:${root}`;
  let candidates = ctx.cache.get<Map<string, string[]>>(cacheKey);
  if (!candidates) {
    candidates = new Map();
    for (const relativePath of ctx.fs.readDirRecursive(root) ?? []) {
      if (!isNitroScannedScript(ctx, `${dir}/${relativePath}`)) continue;
      const key = routeKey(relativePath, version);
      if (key === undefined) continue;
      const files = candidates.get(key);
      if (files) files.push(relativePath);
      else candidates.set(key, [relativePath]);
    }
    for (const files of candidates.values())
      files.sort((first, second) => first.localeCompare(second));
    ctx.cache.set(cacheKey, candidates);
  }
  for (const candidate of candidates.get(own) ?? []) {
    const winner = `${dir}/${candidate}`;
    if (winner === path) return undefined;
    if (ctx.fs.stat(join(root, candidate))?.isFile()) return winner;
  }
  return undefined;
}

/** Nitro's dedupe key for a scanned route file: route, method and env. */
function routeKey(path: string, version: 2 | 3): string | undefined {
  return version === 2 ? nitro2RouteKey(path.replace(/\.[A-Za-z]+$/, "")) : nitro3RouteKey(path);
}

/** nitropack `scanServerRoutes`: params and groups first, then the method and env suffixes. */
function nitro2RouteKey(name: string) {
  let route = `/${name
    .replace(/\(([^(/\\]+)\)[/\\]/g, "")
    .replace(/\[\.{3}]/g, "**")
    .replace(/\[\.{3}(\w+)]/g, "**:$1")
    .replace(/\[([^/\]]+)]/g, ":$1")}`.replace(/\/+$/, "");
  const match = route.match(NITRO2_SUFFIX);
  const method = match?.groups?.method;
  const env = match?.groups?.env;
  if (match?.index) route = route.slice(0, match.index);
  route = route.replace(/\/index$/, "") || "/";
  return `${route}\0${method}\0${env}`;
}

function nitro3RouteKey(path: string) {
  const scanned = nitro3ScanPath(path, true);
  if (!scanned) return undefined;
  const { name, method, env } = scanned;
  const route =
    `/${name
      .replace(/\(([^(/\\]+)\)[/\\]/g, "")
      .replace(/\[\.{3}]/g, "**")
      .replace(/\[\.{3}([^\]]+)]/g, (_, param: string) => `:${param.replace(/\W/g, "_")}(.*)`)
      .replace(/\[([^/\]]+)]/g, (_, param: string) => `:${param.replace(/\W/g, "_")}`)}`
      .replace(/\/+$/, "")
      .replace(/\/index$/, "") || "/";
  return `${route}\0${method}\0${env}`;
}
