import type { RuleContext } from "../../../../core/primitives.js";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "pathe";
import { parseSync } from "oxc-parser";
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

function unguardedSensitiveHandlers(ctx: RuleContext): string[] {
  const dirs = ctx.project.nuxt?.serverDirs;
  const manifest = ctx.project.nuxt?.manifest;
  const registered = manifest?.isCurrent ? (manifest.serverHandlers ?? []) : [];
  // Manifest timestamps cannot prove module-provided middleware is still registered.
  if ((dirs?.middleware ?? []).some(hasUnconditionalMiddlewareGuard)) return [];
  const candidates = [
    ...[...(dirs?.api ?? []), ...(dirs?.routes ?? [])].map((file) => ({ file, route: undefined })),
    ...registered.filter((handler) => !handler.middleware),
  ];
  const sensitive =
    /(?:^|\/)(?:auth|sessions?|admin|accounts?|users?|me|profiles?|private|billing|settings)(?:[./-]|$)/i;
  const isSensitive = (path: string): boolean =>
    sensitive.test(path) &&
    !/(?:^|\/)auth\/(?:login|callback)(?:\.(?:get|post))?(?:\.[cm]?[jt]s)?$|(?:^|\/)session\/create(?:\.post)?(?:\.[cm]?[jt]s)?$/i.test(
      path,
    );
  return [
    ...new Set(
      candidates
        .filter(
          (handler) =>
            existsSync(handler.file) &&
            (isSensitive(toPosixPath(relative(ctx.project.root, handler.file))) ||
              isSensitive(handler.route ?? "")) &&
            !hasAuthGuard(readProjectFile(handler.file)),
        )
        .map((handler) => handler.file),
    ),
  ];
}

function hasUnconditionalMiddlewareGuard(file: string): boolean {
  try {
    const parsed = parseSync(file, readProjectFile(file));
    if (parsed.errors.length) return false;
    const declaration: AnyNode = parsed.program.body.find(
      (node) => node.type === "ExportDefaultDeclaration",
    );
    const factory = declaration?.declaration;
    if (
      factory?.type !== "CallExpression" ||
      factory.callee.type !== "Identifier" ||
      !["defineEventHandler", "eventHandler"].includes(factory.callee.name)
    )
      return false;
    const handler = factory.arguments[0];
    const guardName =
      /^(?:requireUserSession|requireMcpAdminToken|requireAuth|authGuard|protectRoute)$/;
    if (handler?.type === "Identifier") return guardName.test(handler.name);
    if (!["ArrowFunctionExpression", "FunctionExpression"].includes(handler?.type)) return false;
    const isGuard = (expression: AnyNode): boolean => {
      if (expression?.type === "AwaitExpression") expression = expression.argument;
      return (
        expression?.type === "CallExpression" &&
        expression.callee.type === "Identifier" &&
        guardName.test(expression.callee.name) &&
        handler.params[0]?.type === "Identifier" &&
        expression.arguments[0]?.type === "Identifier" &&
        expression.arguments[0].name === handler.params[0].name
      );
    };
    if (handler.body.type !== "BlockStatement") return isGuard(handler.body);
    for (const statement of handler.body.body) {
      if (statement.type === "ReturnStatement") return isGuard(statement.argument);
      if (statement.type === "ExpressionStatement") {
        if (isGuard(statement.expression)) return true;
      } else if (statement.type === "VariableDeclaration") {
        if (
          statement.declarations.some(
            (declaration: AnyNode) =>
              declaration.init?.type === "AwaitExpression" && isGuard(declaration.init),
          )
        )
          return true;
      } else if (statement.type !== "EmptyStatement") {
        // Stop before control flow that could bypass or catch a later guard.
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
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
