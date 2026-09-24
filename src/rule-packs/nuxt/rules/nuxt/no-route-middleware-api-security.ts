import { readFileSync } from "node:fs";
import { relative } from "pathe";
import { AnyNode, createRule, toPosixPath } from "./shared.js";
import { createNuxtRuntimeEvidence } from "./evidence.js";
import { diagnostics } from "../../diagnostics.js";

export const noRouteMiddlewareApiSecurity = createRule({
  meta: {
    id: "nuxt/middleware/no-route-middleware-api-security",
    title: "Route middleware does not secure API routes",
    category: "middleware",
    severity: "warn",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/directory-structure/app/middleware#when-middleware-runs",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    const evidence = createNuxtRuntimeEvidence(ctx);
    if (evidence.isContentDocsFile()) return;
    const hasServerHandlers =
      [...(ctx.project.nuxt?.serverDirs.api ?? []), ...(ctx.project.nuxt?.serverDirs.routes ?? [])]
        .length > 0;
    if (!hasServerHandlers) return;
    const relativePath = toPosixPath(ctx.file.relativePath);
    if (/(?:^|\/)server\/middleware\//.test(relativePath)) return;
    const isMiddlewareFile =
      relativePath.startsWith("middleware/") ||
      relativePath.startsWith("app/middleware/") ||
      relativePath.includes("/middleware/");
    if (!isMiddlewareFile || !isAuthLikeMiddleware(relativePath, ctx.file.text)) return;
    const unguarded = unguardedSensitiveHandlers(ctx);
    if (!unguarded.length) return;

    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        ctx.report(
          diagnostics.NUXT0037({
            why: `Route middleware only protects app navigation. These auth-sensitive server handlers have no visible server guard: ${unguarded.map((file) => toPosixPath(file).replace(`${toPosixPath(ctx.project.root)}/`, "")).join(", ")}.`,
            fix: "Add server-side auth checks to the listed handlers or protect them with server middleware.",
          }),
          {
            ruleId: "nuxt/middleware/no-route-middleware-api-security",
            severity: "warn",
            category: "middleware",
            file: ctx.file.path,
            related: unguarded.map((file) => ({ file, message: "No visible server auth guard" })),
            confidence: "heuristic-medium",
            evidence: unguarded.map((file) => ({
              kind: "facts",
              summary: "Auth-sensitive handler lacks a recognized local auth guard.",
              file,
            })),
          },
        );
      },
    };
  },
});

function isAuthLikeMiddleware(relativePath: string, text: string): boolean {
  const name = relativePath.split("/").pop() ?? "";
  if (!/auth|admin|protect|private|secure|session|login/i.test(name)) return false;
  if (/guest/i.test(name)) return false;
  return /defineNuxtRouteMiddleware|useUserSession|loggedIn|navigateTo|to\.meta|auth|session/i.test(
    text,
  );
}

function unguardedSensitiveHandlers(ctx: any): string[] {
  const dirs = ctx.project.nuxt?.serverDirs;
  const files = new Set<string>([...(dirs?.api ?? []), ...(dirs?.routes ?? [])]);
  return [...files].filter(
    (file) =>
      /(?:^|\/)(?:auth|admin|account|user|users|me|profile|session|private|billing|settings)(?:[./-]|$)/i.test(
        toPosixPath(relative(ctx.project.root, file)),
      ) && !hasAuthGuard(readProjectFile(file)),
  );
}

function hasAuthGuard(text: string): boolean {
  return /requireUserSession|requireMcpAdminToken|isAuthorizedAdmin|requireAuth|authorize|authGuard|protectRoute|getUserSession/i.test(
    text,
  );
}

function readProjectFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
