import { join } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { createRule } from "./shared.js";
import {
  hasCustomScanIgnore,
  isNitroScannedScript,
  nitroRouteFile,
  runtimeMajor,
} from "./server-layout.js";

const RULE_ID = "nitro/routes/no-shadowed-file-handler";
const NITRO2_SUFFIX =
  /(\.(?<method>connect|delete|get|head|options|patch|post|put|trace))?(\.(?<env>dev|prod|prerender))?$/;
const NITRO3_METHODS = new Set([
  "connect",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "query",
  "trace",
]);
const NITRO3_ENVS = new Set(["dev", "prod", "prerender"]);
const LAST_SUFFIX = /(?<=[^/])\.([a-z]+)$/;

export const noShadowedFileHandler = createRule({
  meta: {
    id: RULE_ID,
    title: "Don't let two route files resolve to the same route",
    category: "routing",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/routing#filesystem-routing",
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
  const colliding: string[] = [];
  for (const entry of ctx.fs.readDirRecursive(root) ?? []) {
    const relativePath = entry.replace(/\\/g, "/");
    if (!isNitroScannedScript(ctx, `${dir}/${relativePath}`)) continue;
    if (!ctx.fs.stat(join(root, relativePath))?.isFile()) continue;
    if (routeKey(relativePath, version) === own) colliding.push(relativePath);
  }
  const first = colliding.sort((a, b) => a.localeCompare(b))[0];
  return first && `${dir}/${first}` !== path ? `${dir}/${first}` : undefined;
}

/** Nitro's dedupe key for a scanned route file: route, method and env. */
function routeKey(path: string, version: 2 | 3): string | undefined {
  const name = path.replace(/\.[A-Za-z]+$/, "");
  return version === 2 ? nitro2RouteKey(name) : nitro3RouteKey(name);
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

/** nitro `parseScanPath` then `scanServerRoutes`; files that keep a dotted suffix are left out. */
function nitro3RouteKey(name: string) {
  let env: string | undefined;
  let method: string | undefined;
  const envSuffix = name.match(LAST_SUFFIX)?.[1];
  if (envSuffix && NITRO3_ENVS.has(envSuffix)) {
    env = envSuffix;
    name = name.slice(0, -envSuffix.length - 1);
  }
  const methodSuffix = name.match(LAST_SUFFIX)?.[1];
  if (methodSuffix && NITRO3_METHODS.has(methodSuffix)) {
    method = methodSuffix;
    name = name.slice(0, -methodSuffix.length - 1);
  }
  // Nitro 3 keeps, ignores or rejects other dotted suffixes depending on config and mode.
  if (LAST_SUFFIX.test(name)) return undefined;
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
