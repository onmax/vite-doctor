import type { RuleContext } from "../../../../core/primitives.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "pathe";
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
    if (
      ctx.project.nuxt?.manifest?.isCurrent &&
      ctx.project.nuxt.layers.some((layer) =>
        toPosixPath(ctx.file.path).startsWith(
          `${resolve(ctx.project.root, layer.serverDir ?? resolve(ctx.project.root, layer.root, "server"))}/`,
        ),
      )
    )
      return;
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
  const resolvedHandlers = manifest?.isCurrent ? manifest.resolvedServerHandlers : undefined;
  const registered = manifest?.isCurrent ? (manifest.serverHandlers ?? []) : [];
  const middleware = resolvedHandlers
    ? resolvedHandlers
        .filter(
          (handler) =>
            handler.middleware && !handler.method && (!handler.route || handler.route === "/**"),
        )
        .map((handler) => handler.file)
    : (dirs?.middleware ?? []);
  if (middleware.some(hasUnconditionalAuthGuard)) return [];
  const candidates = resolvedHandlers
    ? resolvedHandlers.filter((handler) => !handler.middleware)
    : [
        ...[...(dirs?.api ?? []), ...(dirs?.routes ?? [])].map((file) => ({
          file,
          route: undefined,
          method: undefined,
        })),
        ...registered.filter((handler) => !handler.middleware),
      ];
  const sensitive =
    /(?:^|\/)(?:auth|sessions?|admin|accounts?|users?|me|profiles?|private|billing|settings)(?:[./-]|$)/i;
  const isSensitive = (path: string, method?: string, registeredRoute?: string): boolean => {
    const endpoint = registeredRoute ?? path.replace(/\.[cm]?[jt]s$/i, "");
    const suffix =
      registeredRoute === undefined
        ? endpoint.match(/\.(get|post|put|patch|delete|head|options)$/i)
        : null;
    let route = suffix ? endpoint.slice(0, -suffix[0].length) : endpoint;
    if (registeredRoute === undefined) route = route.replace(/\/index$/i, "");
    const verb = (method ?? suffix?.[1])?.toUpperCase();
    const publicOperation =
      (verb === "POST" &&
        /(?:^|\/)(?:auth\/(?:login|register|sign-up|signup|forgot-password|reset-password)|session\/create)$/i.test(
          route,
        )) ||
      (verb === "GET" && /(?:^|\/)auth\/(?:callback|verify-email)$/i.test(route));
    return sensitive.test(path) && !publicOperation;
  };
  return [
    ...new Set(
      candidates
        .filter(
          (handler) =>
            existsSync(handler.file) &&
            (isSensitive(
              resolvedHandlers
                ? (handler.route ?? "")
                : toPosixPath(relative(ctx.project.root, handler.file)),
              handler.method,
              handler.route,
            ) ||
              isSensitive(handler.route ?? "", handler.method, handler.route)) &&
            !isAuthProviderHandler(ctx, handler.file, handler.route) &&
            !hasUnconditionalAuthGuard(handler.file),
        )
        .map((handler) => handler.file),
    ),
  ];
}

function isAuthProviderHandler(ctx: RuleContext, file: string, route?: string): boolean {
  if (
    !/(?:^|\/)auth\/\[\.\.\.[^/\]]+\](?:\.[cm]?[jt]s)?$/.test(toPosixPath(file)) &&
    !/(?:^|\/)auth\/(?:\*\*|\[\.\.\.[^/\]]+\])$/.test(route ?? "")
  )
    return false;
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
      factory.callee.name !== "defineEventHandler"
    )
      return false;
    const callback = factory.arguments[0];
    if (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression")
      return false;
    const event = callback.params[0];
    if (event?.type !== "Identifier" || callback.params.length !== 1) return false;
    let body = callback.body;
    if (body.type === "BlockStatement") {
      if (body.body.length !== 1 || body.body[0].type !== "ReturnStatement") return false;
      body = body.body[0].argument;
    }
    if (body?.type === "AwaitExpression") body = body.argument;
    return (
      body?.type === "CallExpression" &&
      body.callee.type === "MemberExpression" &&
      !body.callee.computed &&
      body.callee.object.type === "Identifier" &&
      body.callee.property.type === "Identifier" &&
      body.callee.property.name === "handler" &&
      body.callee.object.name !== event.name &&
      isProviderBinding(ctx, file, parsed.program, body.callee.object.name) &&
      body.arguments.length === 1 &&
      isCurrentRequest(body.arguments[0], event.name) &&
      event.name !== "toWebRequest" &&
      callback.id?.name !== "toWebRequest" &&
      hasSupportedRequestConverter(parsed.program)
    );
  } catch {
    return false;
  }
}

function isCurrentRequest(node: AnyNode, event: string): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "toWebRequest" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Identifier" &&
    node.arguments[0].name === event
  );
}

function hasSupportedRequestConverter(program: AnyNode): boolean {
  const bindsConverter = (pattern: AnyNode): boolean => {
    if (!pattern) return false;
    if (pattern.type === "Identifier") return pattern.name === "toWebRequest";
    if (pattern.type === "ObjectPattern")
      return pattern.properties.some((item: AnyNode) =>
        bindsConverter(item.type === "RestElement" ? item.argument : item.value),
      );
    if (pattern.type === "ArrayPattern") return pattern.elements.some(bindsConverter);
    if (pattern.type === "AssignmentPattern") return bindsConverter(pattern.left);
    if (pattern.type === "RestElement") return bindsConverter(pattern.argument);
    return false;
  };
  const hasHoistedConverter = (node: AnyNode): boolean => {
    if (!node || typeof node !== "object") return false;
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
        "ClassDeclaration",
        "ClassExpression",
      ].includes(node.type)
    )
      return false;
    if (
      node.type === "VariableDeclaration" &&
      node.kind === "var" &&
      node.declarations.some((item: AnyNode) => bindsConverter(item.id))
    )
      return true;
    return Object.values(node).some((value) =>
      Array.isArray(value) ? value.some(hasHoistedConverter) : hasHoistedConverter(value),
    );
  };
  if (hasHoistedConverter(program)) return false;
  return program.body.every((statement: AnyNode) => {
    if (statement.type === "ImportDeclaration") {
      return statement.specifiers.every(
        (item: AnyNode) =>
          item.local.name !== "toWebRequest" ||
          (item.type === "ImportSpecifier" &&
            item.imported.name === "toWebRequest" &&
            ["h3", "#imports"].includes(statement.source.value)),
      );
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "VariableDeclaration")
      return declaration.declarations.every((item: AnyNode) => !bindsConverter(item.id));
    return !bindsConverter(declaration?.id);
  });
}

function createsProvider(program: AnyNode, name: string, exported = false): boolean {
  const factories = program.body.flatMap((node: AnyNode) =>
    node.type === "ImportDeclaration" && node.source.value === "better-auth"
      ? node.specifiers
          .filter(
            (item: AnyNode) =>
              item.type === "ImportSpecifier" && item.imported.name === "betterAuth",
          )
          .map((item: AnyNode) => item.local.name)
      : [],
  );
  return program.body.some((statement: AnyNode) => {
    if (exported && name === "default" && statement.type === "ExportDefaultDeclaration") {
      const value = statement.declaration;
      return value.type === "Identifier"
        ? createsProvider(program, value.name)
        : value.type === "CallExpression" &&
            value.callee.type === "Identifier" &&
            factories.includes(value.callee.name);
    }
    if (
      exported &&
      statement.type === "ExportNamedDeclaration" &&
      !statement.source &&
      statement.exportKind !== "type" &&
      statement.specifiers.some(
        (specifier: AnyNode) =>
          specifier.exportKind !== "type" &&
          (specifier.exported.name ?? specifier.exported.value) === name &&
          createsProvider(program, specifier.local.name),
      )
    )
      return true;
    if (exported && statement.type !== "ExportNamedDeclaration") return false;
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    return (
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const" &&
      declaration.declarations.some(
        (item: AnyNode) =>
          item.id.type === "Identifier" &&
          item.id.name === name &&
          item.init?.type === "CallExpression" &&
          item.init.callee.type === "Identifier" &&
          factories.includes(item.init.callee.name),
      )
    );
  });
}

function isProviderBinding(
  ctx: RuleContext,
  file: string,
  program: AnyNode,
  name: string,
): boolean {
  if (createsProvider(program, name)) return true;
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const binding = node.specifiers.find(
      (item: AnyNode) =>
        ["ImportSpecifier", "ImportDefaultSpecifier"].includes(item.type) &&
        item.local.name === name,
    );
    if (!binding) continue;
    const source = node.source.value as string;
    const aliases: Record<string, string> = {
      "~~": ctx.project.root,
      "@@": ctx.project.root,
      "~": ctx.project.nuxt!.appDir,
      "@": ctx.project.nuxt!.appDir,
      ...(ctx.project.nuxt?.manifest?.isCurrent ? ctx.project.nuxt.manifest.aliases : {}),
    };
    const alias = Object.keys(aliases)
      .sort((a, b) => b.length - a.length)
      .find((key) => source === key || source.startsWith(`${key}/`));
    const base = source.startsWith(".")
      ? resolve(dirname(file), source)
      : alias
        ? resolve(ctx.project.root, aliases[alias]!, source.slice(alias.length + 1))
        : undefined;
    if (!base) continue;
    const candidates = extname(base)
      ? [base]
      : [
          ...["ts", "js", "mts", "mjs", "cts", "cjs"].map((extension) => `${base}.${extension}`),
          ...["ts", "js", "mts", "mjs", "cts", "cjs"].map((extension) =>
            resolve(base, `index.${extension}`),
          ),
        ];
    const target = candidates.find((candidate) => existsSync(candidate));
    if (!target) return false;
    const parsed = parseSync(target, readProjectFile(target));
    if (parsed.errors.length) return false;
    return createsProvider(
      parsed.program,
      binding.type === "ImportDefaultSpecifier" ? "default" : binding.imported.name,
      true,
    );
  }
  return false;
}

function hasUnconditionalAuthGuard(file: string): boolean {
  try {
    const parsed = parseSync(file, readProjectFile(file));
    if (parsed.errors.length) return false;
    const declaration: AnyNode = parsed.program.body.find(
      (node) => node.type === "ExportDefaultDeclaration",
    );
    let factory = declaration?.declaration;
    const visited = new Set<string>();
    while (factory?.type === "Identifier") {
      if (visited.has(factory.name)) return false;
      visited.add(factory.name);
      const binding = parsed.program.body
        .filter((node) => node.type === "VariableDeclaration" && node.kind === "const")
        .flatMap((node: AnyNode) => node.declarations)
        .find((node: AnyNode) => node.id.type === "Identifier" && node.id.name === factory.name);
      factory = binding?.init;
    }
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
        if (statement.expression.type === "AwaitExpression" && isGuard(statement.expression))
          return true;
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

function readProjectFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
