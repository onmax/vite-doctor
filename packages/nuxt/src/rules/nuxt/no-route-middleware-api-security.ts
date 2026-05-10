import { AnyNode, createRule } from "./shared.js";

export const noRouteMiddlewareApiSecurity = createRule({
  meta: {
    id: "nuxt/middleware/no-route-middleware-api-security",
    title: "Route middleware does not secure API routes",
    category: "middleware",
    severity: "blocker",
    fixable: "suggestion",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    const hasServerHandlers =
      [...(ctx.project.nuxt?.serverDirs.api ?? []), ...(ctx.project.nuxt?.serverDirs.routes ?? [])]
        .length > 0;
    if (!hasServerHandlers) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const isMiddlewareFile =
          ctx.file.relativePath.startsWith("middleware/") ||
          ctx.file.relativePath.startsWith("app/middleware/") ||
          ctx.file.relativePath.includes("/middleware/");
        const hasRouteMiddleware =
          isMiddlewareFile || /defineNuxtRouteMiddleware|middleware\/.*auth/i.test(ctx.file.text);
        if (
          hasRouteMiddleware &&
          !/requireAuth|authorize|authGuard|protectRoute|getUserSession/i.test(ctx.file.text)
        ) {
          ctx.report({
            ruleId: "nuxt/middleware/no-route-middleware-api-security",
            severity: "blocker",
            category: "middleware",
            file: ctx.file.path,
            message:
              "Route middleware only protects app navigation. API/server routes need their own server-side auth checks.",
            suggestion: "Add auth checks inside server/api or server/routes handlers.",
          });
        }
      },
    };
  },
});
