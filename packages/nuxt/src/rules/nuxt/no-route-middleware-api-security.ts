import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "pathe";
import { AnyNode, createRule, isContentDocsFile, toPosixPath } from "./shared.js";

export const noRouteMiddlewareApiSecurity = createRule({
  meta: {
    id: "nuxt/middleware/no-route-middleware-api-security",
    title: "Route middleware does not secure API routes",
    category: "middleware",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    if (isContentDocsFile(ctx)) return;
    const hasServerHandlers =
      [...(ctx.project.nuxt?.serverDirs.api ?? []), ...(ctx.project.nuxt?.serverDirs.routes ?? [])]
        .length > 0;
    if (!hasServerHandlers) return;
    const relativePath = toPosixPath(ctx.file.relativePath);
    const isMiddlewareFile =
      relativePath.startsWith("middleware/") ||
      relativePath.startsWith("app/middleware/") ||
      relativePath.includes("/middleware/");
    if (!isMiddlewareFile || !isAuthLikeMiddleware(relativePath, ctx.file.text)) return;
    if (hasServerSideAuthGuard(ctx)) return;

    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        ctx.report({
          ruleId: "nuxt/middleware/no-route-middleware-api-security",
          severity: "warn",
          category: "middleware",
          file: ctx.file.path,
          message:
            "Route middleware only protects app navigation. API/server routes need their own server-side auth checks.",
          suggestion: "Add auth checks inside server/api or server/routes handlers.",
        });
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

function hasServerSideAuthGuard(ctx: any): boolean {
  const files = new Set<string>();
  for (const file of [
    ...(ctx.project.nuxt?.serverDirs.api ?? []),
    ...(ctx.project.nuxt?.serverDirs.routes ?? []),
  ]) {
    files.add(file);
  }
  for (const handler of ctx.project.nuxt?.serverHandlers ?? []) {
    const relativePath = toPosixPath(handler.file ?? "");
    if (relativePath) files.add(join(ctx.project.root, relativePath));
  }
  collectServerFiles(join(ctx.project.root, "server"), files);
  collectServerFiles(join(ctx.project.root, "app/server"), files);
  return [...files].some((file) => hasAuthGuard(readProjectFile(file)));
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

function collectServerFiles(dir: string, files: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectServerFiles(path, files);
    } else if (/\.[cm]?[jt]s$/.test(path)) {
      files.add(path);
    }
  }
}
