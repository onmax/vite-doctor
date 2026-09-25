import type { RuleContext } from "../../../../core/primitives.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "pathe";
import { parseSync } from "oxc-parser";
import { AnyNode, createRule, toPosixPath } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";
import {
  autoRegisteredNuxtLayers,
  isNuxtManifestConfigurationCurrent,
} from "../../../../core/internal/runtime-graph.js";

export const noRouteMiddlewareApiSecurity = createRule({
  meta: {
    id: "nuxt/middleware/no-route-middleware-api-security",
    title: "Route middleware does not secure API routes",
    category: "middleware",
    severity: "warn",
    fixable: "suggestion",
    docsUrl:
      "https://nuxt.com/docs/4.x/guide/directory-structure/app/middleware#when-middleware-runs",
    execution: "manifest",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    return {
      onProjectEnd() {
        const nuxt = ctx.project.nuxt;
        if (!nuxt) return;
        const middlewareFiles = new Set<string>();
        const configurationCurrent = nuxt.manifest?.hasManifest
          ? nuxt.manifest.isCurrent ||
            isNuxtManifestConfigurationCurrent(ctx.project.root, nuxt.manifestPath)
          : false;
        const rootConfig = configurationCurrent
          ? undefined
          : rootMiddlewareConfiguration(ctx.project.root);
        if (rootConfig === null) {
          ctx.project.evidenceGaps = [
            ...(ctx.project.evidenceGaps ?? []),
            {
              source: "vite-doctor/nuxt-middleware-api-security",
              message:
                "Nuxt middleware or server directories cannot be resolved from configuration. Generate the Doctor manifest before reviewing server authorization.",
              files: [".nuxt/doctor.manifest.json"],
            },
          ];
          return;
        }
        const rootAppDir = rootConfig ? resolve(ctx.project.root, rootConfig.srcDir) : nuxt.appDir;
        const rootMiddlewareDir = configurationCurrent
          ? undefined
          : resolve(rootAppDir, rootConfig!.middleware);
        const layers = configurationCurrent
          ? nuxt.layers
          : autoRegisteredNuxtLayers(ctx.project.root).map((name) => {
              const root = resolve(ctx.project.root, "layers", name);
              const config = rootMiddlewareConfiguration(root);
              return config === null
                ? null
                : {
                    root,
                    srcDir: resolve(root, config.srcDir),
                    appMiddlewareDir: resolve(root, config.srcDir, config.middleware),
                    priority: 0,
                  };
            });
        if (layers.some((layer) => layer === null)) {
          ctx.project.evidenceGaps = [
            ...(ctx.project.evidenceGaps ?? []),
            {
              source: "vite-doctor/nuxt-middleware-api-security",
              message: "Nuxt layer directories cannot be resolved without a Doctor manifest.",
              files: [".nuxt/doctor.manifest.json"],
            },
          ];
          return;
        }
        for (const layer of [
          {
            root: ctx.project.root,
            srcDir: rootAppDir,
            appMiddlewareDir: rootMiddlewareDir,
            priority: -1,
          },
          ...layers.filter((layer) => layer !== null),
        ]) {
          const appDir =
            layer.srcDir ??
            (resolve(ctx.project.root, layer.root) === ctx.project.root
              ? rootAppDir
              : resolve(ctx.project.root, layer.root, "app"));
          const directory = resolve(
            ctx.project.root,
            layer.appMiddlewareDir ?? resolve(ctx.project.root, appDir, "middleware"),
          );
          if (!existsSync(directory)) continue;
          for (const entry of readdirSync(directory, { recursive: true })) {
            const file = resolve(directory, String(entry));
            if (/\.[cm]?[jt]s$/.test(file) && statSync(file).isFile()) middlewareFiles.add(file);
          }
        }
        if (
          ![...middlewareFiles].some((file) =>
            isAuthLikeMiddleware(
              toPosixPath(relative(ctx.project.root, file)),
              readFileSync(file, "utf8"),
            ),
          )
        )
          return;
        const unguarded = unguardedSensitiveHandlers(ctx, configurationCurrent);
        for (const file of unguarded) {
          const text = readFileSync(file, "utf8");
          ctx.report(
            diagnostics.NUXT0037({
              why: `Route middleware only protects app navigation. This auth-sensitive server handler has no visible server guard: ${toPosixPath(relative(ctx.project.root, file))}.`,
              fix: "Add server-side auth checks to the handler or protect it with server middleware.",
            }),
            {
              ruleId: "nuxt/middleware/no-route-middleware-api-security",
              severity: "warn",
              category: "middleware",
              file,
              range: ctx.helpers.rangeFromOffsets(file, text, 0, Math.max(1, text.length)),
              related: [{ file, message: "No visible server auth guard" }],
              confidence: "heuristic-medium",
              evidence: [
                {
                  kind: "facts",
                  summary: "Auth-sensitive handler lacks a recognized local auth guard.",
                  file,
                },
              ],
            },
          );
        }
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

export function rootMiddlewareConfiguration(
  root: string,
): { srcDir: string; middleware: string } | null {
  const config = ["ts", "js", "mjs", "cjs", "mts", "cts"]
    .map((extension) => join(root, `nuxt.config.${extension}`))
    .find(existsSync);
  const parsed = config ? parseSync(config, readFileSync(config, "utf8")) : undefined;
  if (parsed?.errors.length) return null;
  const exported: AnyNode = parsed?.program.body.find(
    (statement: AnyNode) => statement.type === "ExportDefaultDeclaration",
  );
  const value = exported?.declaration;
  const options = value?.type === "CallExpression" ? value.arguments[0] : value;
  if (config && options?.type !== "ObjectExpression") return null;
  const property = (object: AnyNode, name: string): AnyNode =>
    object?.type === "ObjectExpression"
      ? object.properties.find(
          (entry: AnyNode) =>
            entry.type === "Property" &&
            !entry.computed &&
            (entry.key.name ?? entry.key.value) === name,
        )?.value
      : undefined;
  const srcDir = property(options, "srcDir");
  const directory = property(options, "dir");
  const middleware = property(directory, "middleware");
  if (
    property(options, "serverDir") ||
    property(options, "extends") ||
    (srcDir && (srcDir.type !== "Literal" || typeof srcDir.value !== "string")) ||
    (directory && directory.type !== "ObjectExpression") ||
    (middleware && (middleware.type !== "Literal" || typeof middleware.value !== "string"))
  )
    return null;
  return {
    srcDir: srcDir?.value ?? defaultSourceDirectory(root, middleware?.value ?? "middleware"),
    middleware: middleware?.value ?? "middleware",
  };
}

function defaultSourceDirectory(root: string, middleware: string): string {
  const app = join(root, "app");
  if (!existsSync(app)) return ".";
  const contents = readdirSync(app).filter(
    (entry) => entry !== "spa-loading-template.html" && !entry.startsWith("router.options"),
  );
  if (
    contents.length === 0 &&
    ["app.vue", "App.vue", "assets", "layouts", middleware, "pages", "plugins"].some((entry) =>
      existsSync(join(root, entry)),
    )
  )
    return ".";
  return "app";
}

function unguardedSensitiveHandlers(ctx: RuleContext, configurationCurrent: boolean): string[] {
  const dirs = ctx.project.nuxt?.serverDirs;
  const manifest = ctx.project.nuxt?.manifest;
  const resolvedHandlers = manifest?.isCurrent ? manifest.resolvedServerHandlers : undefined;
  const layerFiles = { api: [] as string[], routes: [] as string[], middleware: [] as string[] };
  const layerPaths = new Map<string, string>();
  if (!resolvedHandlers) {
    const layers = configurationCurrent
      ? (ctx.project.nuxt?.layers ?? [])
      : autoRegisteredNuxtLayers(ctx.project.root).map((name) => ({
          root: resolve(ctx.project.root, "layers", name),
          serverDir: undefined,
        }));
    for (const layer of layers) {
      const serverDir = resolve(ctx.project.root, layer.serverDir ?? join(layer.root, "server"));
      for (const category of ["api", "routes", "middleware"] as const) {
        const directory = join(serverDir, category);
        if (!existsSync(directory)) continue;
        for (const entry of readdirSync(directory, { recursive: true })) {
          const file = resolve(directory, String(entry));
          if (/\.[cm]?[jt]s$/.test(file) && statSync(file).isFile()) {
            layerFiles[category].push(file);
            if (category !== "middleware")
              layerPaths.set(
                file,
                `${category === "api" ? "/api" : ""}/${toPosixPath(relative(directory, file))}`,
              );
          }
        }
      }
    }
  }
  const registered =
    manifest?.isCurrent && configurationCurrent ? (manifest.serverHandlers ?? []) : [];
  const middleware = resolvedHandlers
    ? resolvedHandlers.filter(
        (handler) => handler.middleware && hasUnconditionalAuthGuard(handler.file),
      )
    : [];
  if (
    !resolvedHandlers &&
    [...(dirs?.middleware ?? []), ...layerFiles.middleware].some(hasUnconditionalAuthGuard)
  )
    return [];
  const candidates = resolvedHandlers
    ? resolvedHandlers.filter((handler) => !handler.middleware)
    : [
        ...[
          ...(dirs?.api ?? []),
          ...(dirs?.routes ?? []),
          ...layerFiles.api,
          ...layerFiles.routes,
        ].map((file) => ({
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
        /(?:^|\/)(?:auth\/(?:login|sign-in|signin|register|sign-up|signup|forgot-password|reset-password)|session\/create)$/i.test(
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
                : (layerPaths.get(handler.file) ??
                    toPosixPath(relative(ctx.project.root, handler.file))),
              handler.method,
              handler.route,
            ) ||
              isSensitive(handler.route ?? "", handler.method, handler.route)) &&
            !isAuthProviderHandler(ctx, handler.file, handler.route) &&
            !middleware.some((guard) => middlewareCoversHandler(guard, handler)) &&
            !hasUnconditionalAuthGuard(handler.file),
        )
        .map((handler) => handler.file),
    ),
  ];
}

function middlewareCoversHandler(
  middleware: { route?: string; method?: string },
  handler: { route?: string; method?: string },
): boolean {
  if (middleware.method && middleware.method !== handler.method) return false;
  if (!middleware.route || middleware.route === "/**") return true;
  if (!handler.route) return false;
  return (
    middleware.route === handler.route ||
    (middleware.route.endsWith("/**") && handler.route.startsWith(middleware.route.slice(0, -2)))
  );
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
      !["defineEventHandler", "eventHandler"].includes(factory.callee.name) ||
      (factory.callee.name === "eventHandler" &&
        !hasFrameworkEventHandlerBinding(parsed.program, factory.callee.name))
    )
      return false;
    const callback = factory.arguments[0];
    if (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression")
      return false;
    const event = callback.params[0];
    if (event?.type !== "Identifier" || callback.params.length !== 1) return false;
    let body = callback.body;
    if (body.type === "BlockStatement") {
      if (
        !body.body.length ||
        !body.body
          .slice(0, -1)
          .every((statement: AnyNode) =>
            ["ExpressionStatement", "VariableDeclaration"].includes(statement.type),
          ) ||
        body.body.at(-1)?.type !== "ReturnStatement"
      )
        return false;
      body = body.body.at(-1).argument;
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
      callback.id?.name !== body.callee.object.name &&
      !callback.body.body?.some(
        (statement: AnyNode) =>
          statement.type === "VariableDeclaration" &&
          statement.declarations.some((declaration: AnyNode) =>
            bindsName(declaration.id, body.callee.object.name),
          ),
      ) &&
      isProviderBinding(ctx, file, parsed.program, body.callee.object.name) &&
      body.arguments.length === 1 &&
      isCurrentRequest(body.arguments[0], event.name) &&
      event.name !== body.arguments[0].callee.name &&
      callback.id?.name !== body.arguments[0].callee.name &&
      !callback.body.body?.some(
        (statement: AnyNode) =>
          statement.type === "VariableDeclaration" &&
          statement.declarations.some((declaration: AnyNode) =>
            bindsName(declaration.id, body.arguments[0].callee.name),
          ),
      ) &&
      hasSupportedRequestConverter(parsed.program, body.arguments[0].callee.name)
    );
  } catch {
    return false;
  }
}

function hasFrameworkEventHandlerBinding(program: AnyNode, name: string): boolean {
  const hasHoistedBinding = (node: AnyNode): boolean => {
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
      node.declarations.some((item: AnyNode) => bindsName(item.id, name))
    )
      return true;
    return Object.values(node).some((value) =>
      Array.isArray(value) ? value.some(hasHoistedBinding) : hasHoistedBinding(value),
    );
  };
  if (hasHoistedBinding(program)) return false;
  return program.body.every((statement: AnyNode) => {
    if (statement.type === "ImportDeclaration")
      return statement.specifiers.every(
        (specifier: AnyNode) =>
          specifier.local.name !== name ||
          (specifier.type === "ImportSpecifier" &&
            specifier.imported.name === "eventHandler" &&
            ["h3", "#imports"].includes(statement.source.value)),
      );
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration")
      return declaration.declarations.every((item: AnyNode) => !bindsName(item.id, name));
    return !bindsName(declaration?.id, name);
  });
}

function bindsName(pattern: AnyNode, name: string): boolean {
  if (!pattern) return false;
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "ObjectPattern")
    return pattern.properties.some((item: AnyNode) =>
      bindsName(item.type === "RestElement" ? item.argument : item.value, name),
    );
  if (pattern.type === "ArrayPattern")
    return pattern.elements.some((item: AnyNode) => bindsName(item, name));
  if (pattern.type === "AssignmentPattern") return bindsName(pattern.left, name);
  if (pattern.type === "RestElement") return bindsName(pattern.argument, name);
  return false;
}

function isCurrentRequest(node: AnyNode, event: string): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Identifier" &&
    node.arguments[0].name === event
  );
}

function hasSupportedRequestConverter(program: AnyNode, converter: string): boolean {
  const bindsConverter = (pattern: AnyNode): boolean => {
    if (!pattern) return false;
    if (pattern.type === "Identifier") return pattern.name === converter;
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
  let imported = false;
  const validBindings = program.body.every((statement: AnyNode) => {
    if (statement.type === "ImportDeclaration") {
      return statement.specifiers.every((item: AnyNode) => {
        if (item.local.name !== converter) return true;
        const supported =
          item.type === "ImportSpecifier" &&
          item.imported.name === "toWebRequest" &&
          ["h3", "#imports"].includes(statement.source.value);
        imported ||= supported;
        return supported;
      });
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "VariableDeclaration")
      return declaration.declarations.every((item: AnyNode) => !bindsConverter(item.id));
    return !bindsConverter(declaration?.id);
  });
  return validBindings && (converter === "toWebRequest" || imported);
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
  visited = new Set<string>(),
  exported = false,
): boolean {
  if (visited.has(`${file}:${name}`)) return false;
  visited.add(`${file}:${name}`);
  if (createsProvider(program, name, exported)) return true;
  const exportedImports = exported
    ? new Set(
        program.body.flatMap((statement: AnyNode) =>
          statement.type === "ExportNamedDeclaration" &&
          !statement.source &&
          statement.exportKind !== "type"
            ? statement.specifiers
                .filter(
                  (specifier: AnyNode) =>
                    specifier.exportKind !== "type" &&
                    (specifier.exported.name ?? specifier.exported.value) === name,
                )
                .map((specifier: AnyNode) => specifier.local.name)
            : [],
        ),
      )
    : undefined;
  for (const node of program.body) {
    if (exported && node.type !== "ExportNamedDeclaration" && node.type !== "ImportDeclaration")
      continue;
    if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration") continue;
    if (node.type === "ExportNamedDeclaration" && (!node.source || node.exportKind === "type"))
      continue;
    const binding = node.specifiers.find((item: AnyNode) =>
      node.type === "ImportDeclaration"
        ? ["ImportSpecifier", "ImportDefaultSpecifier"].includes(item.type) &&
          (exported ? exportedImports!.has(item.local.name) : item.local.name === name)
        : item.type === "ExportSpecifier" &&
          item.exportKind !== "type" &&
          (item.exported.name ?? item.exported.value) === name,
    );
    if (!binding) continue;
    const source = node.source.value as string;
    const layer = [...ctx.project.nuxt!.layers]
      .filter((layer) => {
        const root = resolve(ctx.project.root, layer.root);
        return root !== ctx.project.root && file.startsWith(`${root}/`);
      })
      .sort((a, b) => b.root.length - a.root.length)[0];
    const aliases: Record<string, string> = {
      "~~": ctx.project.root,
      "@@": ctx.project.root,
      "~": ctx.project.nuxt!.appDir,
      "@": ctx.project.nuxt!.appDir,
      ...(ctx.project.nuxt?.manifest?.isCurrent ? ctx.project.nuxt.manifest.aliases : {}),
      ...(layer && ctx.project.nuxt!.localLayerAliases === true
        ? {
            "~~": resolve(ctx.project.root, layer.root),
            "@@": resolve(ctx.project.root, layer.root),
            "~": resolve(ctx.project.root, layer.srcDir ?? layer.root),
            "@": resolve(ctx.project.root, layer.srcDir ?? layer.root),
          }
        : {}),
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
    if (!target) continue;
    const parsed = parseSync(target, readProjectFile(target));
    if (parsed.errors.length) continue;
    const targetName =
      node.type === "ImportDeclaration" && binding.type === "ImportDefaultSpecifier"
        ? "default"
        : node.type === "ImportDeclaration"
          ? binding.imported.name
          : binding.local.name;
    if (
      createsProvider(parsed.program, targetName, true) ||
      isProviderBinding(ctx, target, parsed.program, targetName, visited, true)
    )
      return true;
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
        if (isGuard(statement.expression) && statement.expression.type === "AwaitExpression")
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
