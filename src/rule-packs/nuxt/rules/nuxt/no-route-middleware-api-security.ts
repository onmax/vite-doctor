import type { RuleContext, RuleFileSystem } from "../../../../core/primitives.js";
import { dirname, extname, join, relative, resolve } from "pathe";
import { parseScriptSync } from "../../../../core/internal/script.js";
import { AnyNode, createRule, toPosixPath } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";
import {
  autoRegisteredNuxtLayers,
  // oxlint-disable-next-line no-restricted-imports -- compares config mtimes, so the Rule declares cacheScope "none".
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
    cacheScope: "none",
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
          : rootMiddlewareConfiguration(ctx.fs, ctx.project.root);
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
          : autoRegisteredNuxtLayers(ctx.project.root, ctx.fs).map((name) => {
              const root = resolve(ctx.project.root, "layers", name);
              const config = rootMiddlewareConfiguration(ctx.fs, root);
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
          for (const entry of ctx.fs.readDirRecursive(directory) ?? []) {
            const file = resolve(directory, entry);
            if (/\.[cm]?[jt]s$/.test(file) && ctx.fs.stat(file)?.isFile())
              middlewareFiles.add(file);
          }
        }
        if (
          ![...middlewareFiles].some((file) =>
            isAuthLikeMiddleware(
              toPosixPath(relative(ctx.project.root, file)),
              ctx.fs.readText(file) ?? "",
            ),
          )
        )
          return;
        const unguarded = unguardedSensitiveHandlers(ctx, configurationCurrent);
        for (const file of unguarded) {
          const text = ctx.fs.readText(file) ?? "";
          ctx.report(
            diagnostics.NUXT0037({
              why: `Route middleware only protects app navigation. This auth-sensitive server handler has no visible server guard: ${toPosixPath(relative(ctx.project.root, file))}.`,
              fix: 'Await a server guard with the event at the top of the handler, or protect it with server middleware. If the handler already calls an app guard Doctor cannot follow, list it in this rule\'s guards option: ["warn", { guards: ["requireAdmin"] }].',
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

export function isPublicAuthOperation(path: string, method?: string): boolean {
  const endpoint = path.replace(/\.[cm]?[jt]s$/i, "");
  const suffix = endpoint.match(/\.(get|post|put|patch|delete|head|options)$/i);
  const route = (suffix ? endpoint.slice(0, -suffix[0].length) : endpoint).replace(/\/index$/i, "");
  const verb = (method ?? suffix?.[1])?.toUpperCase();
  return (
    (verb === "POST" &&
      /(?:^|\/)(?:auth\/(?:login|sign-in|signin|register|sign-up|signup|forgot-password|reset-password)|session\/create)$/i.test(
        route,
      )) ||
    (verb === "GET" && /(?:^|\/)auth\/(?:callback|verify-email)$/i.test(route))
  );
}

export function rootMiddlewareConfiguration(
  fs: RuleFileSystem,
  root: string,
): { srcDir: string; middleware: string; customServerRegistration: boolean } | null {
  const config = ["ts", "js", "mjs", "cjs", "mts", "cts"]
    .map((extension) => join(root, `nuxt.config.${extension}`))
    .find((file) => fs.exists(file));
  const parsed = config ? parseScriptSync(config, fs.readText(config) ?? "") : undefined;
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
  const nitro = property(options, "nitro");
  if (
    property(options, "serverDir") ||
    property(options, "extends") ||
    (srcDir && (srcDir.type !== "Literal" || typeof srcDir.value !== "string")) ||
    (directory && directory.type !== "ObjectExpression") ||
    (middleware && (middleware.type !== "Literal" || typeof middleware.value !== "string"))
  )
    return null;
  return {
    srcDir: srcDir?.value ?? defaultSourceDirectory(fs, root, middleware?.value ?? "middleware"),
    middleware: middleware?.value ?? "middleware",
    customServerRegistration: Boolean(
      (nitro &&
        (nitro.type !== "ObjectExpression" ||
          nitro.properties.some(
            (entry: AnyNode) =>
              entry.type !== "Property" ||
              entry.computed ||
              ["handlers", "scanDirs", "routes"].includes(entry.key.name ?? entry.key.value),
          ))) ||
      property(options, "serverHandlers") ||
      property(options, "devServerHandlers"),
    ),
  };
}

function defaultSourceDirectory(fs: RuleFileSystem, root: string, middleware: string): string {
  const app = join(root, "app");
  if (!fs.exists(app)) return ".";
  const contents = (fs.readDir(app) ?? [])
    .map((entry) => entry.name)
    .filter(
      (entry) => entry !== "spa-loading-template.html" && !entry.startsWith("router.options"),
    );
  if (
    contents.length === 0 &&
    ["app.vue", "App.vue", "assets", "layouts", middleware, "pages", "plugins"].some((entry) =>
      fs.exists(join(root, entry)),
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
      : autoRegisteredNuxtLayers(ctx.project.root, ctx.fs).map((name) => ({
          root: resolve(ctx.project.root, "layers", name),
          serverDir: undefined,
        }));
    for (const layer of layers) {
      const serverDir = resolve(ctx.project.root, layer.serverDir ?? join(layer.root, "server"));
      for (const category of ["api", "routes", "middleware"] as const) {
        const directory = join(serverDir, category);
        for (const entry of ctx.fs.readDirRecursive(directory) ?? []) {
          const file = resolve(directory, entry);
          if (/\.[cm]?[jt]s$/.test(file) && ctx.fs.stat(file)?.isFile()) {
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
        (handler) => handler.middleware && hasUnconditionalAuthGuard(ctx, handler.file),
      )
    : [];
  if (
    !resolvedHandlers &&
    [...(dirs?.middleware ?? []), ...layerFiles.middleware].some((file) =>
      hasUnconditionalAuthGuard(ctx, file),
    )
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
    return sensitive.test(path) && !isPublicAuthOperation(route, method ?? suffix?.[1]);
  };
  return [
    ...new Set(
      candidates
        .filter(
          (handler) =>
            ctx.fs.exists(handler.file) &&
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
            !hasUnconditionalAuthGuard(ctx, handler.file),
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
    const parsed = parseScriptSync(file, readProjectFile(ctx.fs, file));
    if (parsed.errors.length) return false;
    if (isPackageAuthMount(ctx, file, parsed.program)) return true;
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

// `export { default } from "vite-hub/auth/server"`: a framework module's Better Auth mount. Count it
// only when the specifier names an auth entry and the installed package depends on Better Auth.
function isPackageAuthMount(ctx: RuleContext, file: string, program: AnyNode): boolean {
  const statements = program.body.filter(
    (statement: AnyNode) =>
      !(
        (statement.type === "ExportNamedDeclaration" || statement.type === "ImportDeclaration") &&
        (statement.exportKind === "type" || statement.importKind === "type")
      ),
  );
  const [statement] = statements;
  if (
    statements.length !== 1 ||
    statement.type !== "ExportNamedDeclaration" ||
    !statement.source ||
    statement.specifiers.length !== 1
  )
    return false;
  const [specifier] = statement.specifiers;
  if (
    (specifier.local.name ?? specifier.local.value) !== "default" ||
    (specifier.exported.name ?? specifier.exported.value) !== "default"
  )
    return false;
  const source = String(statement.source.value);
  const match = source.match(/^((?:@[^/]+\/)?[^/.#~@][^/]*)(\/.*)?$/);
  if (!match || !/(?:^|[/@-])(?:auth|better-auth)(?:$|[/-])/.test(source)) return false;
  const manifest = installedPackageManifest(ctx, dirname(file), match[1]!);
  if (!manifest) return false;
  if (manifest.name === "better-auth" || dependsOn(manifest.json, "better-auth")) return true;
  // One hop for umbrella packages, such as vite-hub re-exporting @vite-hub/auth.
  return Object.keys({ ...manifest.json.dependencies, ...manifest.json.peerDependencies })
    .filter((name) => /(?:^|[/@-])auth(?:$|[/-])/.test(name))
    .some((name) => {
      const dependency = installedPackageManifest(ctx, dirname(manifest.path), name);
      return dependency !== undefined && dependsOn(dependency.json, "better-auth");
    });
}

function dependsOn(json: AnyNode, name: string): boolean {
  return [json?.dependencies, json?.peerDependencies].some(
    (dependencies) => dependencies && typeof dependencies === "object" && name in dependencies,
  );
}

function installedPackageManifest(
  ctx: RuleContext,
  from: string,
  name: string,
): { name: string; path: string; json: AnyNode } | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name, "package.json");
    if (ctx.fs.exists(candidate)) {
      const path = ctx.fs.realpath(candidate) ?? candidate;
      const json = ctx.fs.readJson(path) as AnyNode;
      return json && typeof json === "object"
        ? { name: typeof json.name === "string" ? json.name : name, path, json }
        : undefined;
    }
    if (dirname(directory) === directory) return undefined;
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
    if (
      exported &&
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration" &&
      node.type !== "ImportDeclaration"
    )
      continue;
    if (
      node.type !== "ImportDeclaration" &&
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration"
    )
      continue;
    if (node.type === "ExportNamedDeclaration" && (!node.source || node.exportKind === "type"))
      continue;
    if (node.type === "ExportAllDeclaration" && (!exported || node.exported || name === "default"))
      continue;
    const binding =
      node.type === "ExportAllDeclaration"
        ? undefined
        : node.specifiers.find((item: AnyNode) =>
            node.type === "ImportDeclaration"
              ? ["ImportSpecifier", "ImportDefaultSpecifier"].includes(item.type) &&
                (exported ? exportedImports!.has(item.local.name) : item.local.name === name)
              : item.type === "ExportSpecifier" &&
                item.exportKind !== "type" &&
                (item.exported.name ?? item.exported.value) === name,
          );
    if (node.type !== "ExportAllDeclaration" && !binding) continue;
    const target = resolveProjectModule(ctx, file, node.source.value as string);
    if (!target) continue;
    const parsed = parseScriptSync(target, readProjectFile(ctx.fs, target));
    if (parsed.errors.length) continue;
    const targetName =
      node.type === "ExportAllDeclaration"
        ? name
        : node.type === "ImportDeclaration" && binding.type === "ImportDefaultSpecifier"
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

const BUILT_IN_GUARDS = new Set([
  "requireUserSession",
  "requireMcpAdminToken",
  "requireAuth",
  "authGuard",
  "protectRoute",
]);
const H3_V1_HANDLER_FACTORIES = ["defineEventHandler", "eventHandler"];
const H3_V2_HANDLER_FACTORIES = ["defineHandler", "defineValidatedHandler"];
const NITRO_2_CACHED_HANDLER_FACTORIES = ["cachedEventHandler", "defineCachedEventHandler"];
const NITRO_3_CACHED_HANDLER_FACTORIES = ["defineCachedHandler"];

interface RouteSecurityOptions {
  guards?: unknown;
}

interface ParsedModule {
  file: string;
  program: AnyNode;
}

interface GuardFunction {
  module: ParsedModule;
  fn: AnyNode;
}

interface GuardResolver {
  ctx: RuleContext;
  configured: Set<string>;
  verdicts: Map<string, GuardVerdict | null>;
  modules: Map<string, ParsedModule | null>;
  autoImports?: Map<string, GuardFunction[]>;
}

// `sync` guards throw before returning, so a caller does not need to await them.
type GuardVerdict = { sync: boolean };

const resolvers = new WeakMap<RuleContext, GuardResolver>();

function guardResolver(ctx: RuleContext): GuardResolver {
  let resolver = resolvers.get(ctx);
  if (!resolver) {
    const guards = (ctx.options as RouteSecurityOptions | undefined)?.guards;
    resolver = {
      ctx,
      configured: new Set(
        Array.isArray(guards) ? guards.filter((name) => typeof name === "string") : [],
      ),
      verdicts: new Map(),
      modules: new Map(),
    };
    resolvers.set(ctx, resolver);
  }
  return resolver;
}

// Nitro 3 ships H3 v2, which added defineHandler and defineValidatedHandler and kept the v1
// names as aliases. Names a resolved older runtime does not export are someone else's function.
function handlerFactories(ctx: RuleContext): Set<string> {
  const major = (runtime: "h3" | "nitro") => {
    const instance = ctx.project.runtimeGraph?.packages[runtime];
    const value =
      instance?.state === "resolved" ? Number.parseInt(instance.version ?? "", 10) : NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  const h3 = major("h3");
  const nitro = major("nitro");
  return new Set([
    ...H3_V1_HANDLER_FACTORIES,
    ...NITRO_2_CACHED_HANDLER_FACTORIES,
    ...(h3 === undefined || h3 >= 2 ? H3_V2_HANDLER_FACTORIES : []),
    ...(nitro === undefined || nitro >= 3 ? NITRO_3_CACHED_HANDLER_FACTORIES : []),
  ]);
}

function handlerFromFactory(ctx: RuleContext, program: AnyNode, factory: AnyNode): AnyNode {
  if (factory?.type !== "CallExpression" || factory.callee.type !== "Identifier") return undefined;
  const imported = program.body
    .filter((node: AnyNode) => node.type === "ImportDeclaration")
    .flatMap((node: AnyNode) =>
      node.specifiers.map((specifier: AnyNode) => ({ source: node.source.value, specifier })),
    )
    .find(({ specifier }: AnyNode) => specifier.local.name === factory.callee.name);
  const name =
    imported?.specifier.type === "ImportSpecifier" &&
    ["h3", "nitro/h3", "nitro", "nitro/runtime", "nitropack/runtime", "#imports"].includes(
      imported.source,
    )
      ? (imported.specifier.imported.name ?? imported.specifier.imported.value)
      : factory.callee.name;
  if (!handlerFactories(ctx).has(name)) return undefined;
  const argument = factory.arguments[0];
  if (argument?.type !== "ObjectExpression") return argument;
  // Object form: defineHandler({ handler }), defineValidatedHandler({ validate, handler }).
  return argument.properties.find(
    (property: AnyNode) =>
      property.type === "Property" &&
      !property.computed &&
      (property.key.name ?? property.key.value) === "handler",
  )?.value;
}

function hasUnconditionalAuthGuard(ctx: RuleContext, file: string): boolean {
  try {
    const parsed = parseScriptSync(file, readProjectFile(ctx.fs, file));
    if (parsed.errors.length) return false;
    const resolver = guardResolver(ctx);
    const module = { file, program: parsed.program };
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
    const handler = handlerFromFactory(ctx, parsed.program, factory);
    if (handler?.type === "Identifier")
      return guardVerdict(resolver, module, handler.name) !== null;
    return isGuardedFunction(resolver, module, handler);
  } catch {
    return false;
  }
}

// A handler is guarded when it awaits a guard with its event before any control flow.
function isGuardedFunction(resolver: GuardResolver, module: ParsedModule, fn: AnyNode): boolean {
  if (!["ArrowFunctionExpression", "FunctionExpression"].includes(fn?.type)) return false;
  const event = fn.params[0];
  if (event?.type !== "Identifier") return false;
  const isGuard = (expression: AnyNode, mustSettle: boolean): boolean => {
    const awaited = expression?.type === "AwaitExpression";
    if (awaited) expression = expression.argument;
    if (
      expression?.type !== "CallExpression" ||
      expression.callee.type !== "Identifier" ||
      expression.arguments[0]?.type !== "Identifier" ||
      expression.arguments[0].name !== event.name
    )
      return false;
    // A declaration in the handler can shadow an imported or auto-imported guard.
    // Conservatively reject the call when the handler contains any same-named binding.
    if (hasHandlerBinding(fn, expression.callee.name)) return false;
    const verdict = guardVerdict(resolver, module, expression.callee.name);
    return verdict !== null && (!mustSettle || awaited || verdict.sync);
  };
  if (fn.body.type !== "BlockStatement") return isGuard(fn.body, false);
  for (const statement of fn.body.body) {
    if (statement.type === "ReturnStatement") return isGuard(statement.argument, false);
    if (statement.type === "ExpressionStatement") {
      if (isGuard(statement.expression, true)) return true;
    } else if (statement.type === "VariableDeclaration") {
      if (statement.declarations.some((item: AnyNode) => isGuard(item.init, true))) return true;
    } else if (statement.type !== "EmptyStatement") {
      // Stop before control flow that could bypass or catch a later guard.
      return false;
    }
  }
  return false;
}

function guardVerdict(
  resolver: GuardResolver,
  module: ParsedModule,
  name: string,
): GuardVerdict | null {
  if (BUILT_IN_GUARDS.has(name) || resolver.configured.has(name)) return { sync: false };
  const key = `${module.file}\0${name}`;
  if (resolver.verdicts.has(key)) return resolver.verdicts.get(key)!;
  resolver.verdicts.set(key, null);
  const guard = findGuardFunction(resolver, module, name);
  const verdict = guard ? guardFunctionVerdict(resolver, guard) : null;
  resolver.verdicts.set(key, verdict);
  return verdict;
}

// Evidence that an app function is a guard: it takes the event, throws a 401 or 403 HTTP error on
// a failing branch (or first awaits another guard), and never answers with a missing identity.
function guardFunctionVerdict(resolver: GuardResolver, guard: GuardFunction): GuardVerdict | null {
  const { fn } = guard;
  if (fn.params[0]?.type !== "Identifier") return null;
  if (fn.body.type !== "BlockStatement")
    return isGuardedFunction(resolver, guard.module, fn) ? { sync: false } : null;
  if (returnsEmpty(fn.body)) return null;
  if (throwsAuthError(fn.body.body)) return { sync: !fn.async };
  return isGuardedFunction(resolver, guard.module, fn) ? { sync: false } : null;
}

function throwsAuthError(statements: AnyNode[]): boolean {
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    if (statement?.type === "ThrowStatement" && isAuthHttpError(statement.argument)) return true;
    if (statement?.type === "BlockStatement" && throwsAuthError(statement.body)) return true;
    if (statement?.type !== "IfStatement") continue;
    if (isMissingIdentityCondition(statement.test)) {
      if (throwsAuthError([statement.consequent, statement.alternate].filter(Boolean))) return true;
      continue;
    }
    // Common proven-identity shape: `if (who) return who; throw 401`.
    // The return establishes identity on the truthy branch, while the following
    // auth throw rejects the only path that can continue without it.
    if (
      containsNonEmptyReturn(statement.consequent) &&
      throwsAuthError(statements.slice(index + 1))
    )
      return true;
  }
  return false;
}

function containsNonEmptyReturn(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "ReturnStatement")
    return (
      !!node.argument &&
      !(
        node.argument.type === "Literal" &&
        (node.argument.value == null || node.argument.value === false)
      )
    );
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type))
    return false;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" && value && typeof value === "object" && containsNonEmptyReturn(value),
  );
}

function isMissingIdentityCondition(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "UnaryExpression" && node.operator === "!")
    return (
      mentionsIdentity(node.argument) ||
      containsNamedProperty(
        node.argument,
        /(?:authorization|cookie|token|credential|apikey|api_key|bearer)/i,
      )
    );
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    const left = node.left;
    const right = node.right;
    const identity = mentionsIdentity(left) || mentionsIdentity(right);
    const nullish = [left, right].some(
      (value: AnyNode) =>
        value?.type === "Literal" && (value.value === null || value.value === undefined),
    );
    if (identity && nullish) return true;
    const credential = /(?:authorization|cookie|token|credential|apikey|api_key|bearer)/i;
    if (![left, right].some((value: AnyNode) => containsNamedProperty(value, credential)))
      return false;
    if (node.type !== "BinaryExpression") return true;
    // A missing credential is represented by inequality (or a nullish check).
    // Equality with a valid token is the success branch and must not prove a guard.
    if (nullish) return true;
    return node.operator === "!==" || node.operator === "!=";
  }
  return false;
}

function mentionsIdentity(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier")
    return /^(?:user|users|identity|who|session|auth)$/i.test(node.name);
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" && value && typeof value === "object" && mentionsIdentity(value),
  );
}

function containsNamedProperty(node: AnyNode, pattern: RegExp): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier" && pattern.test(node.name)) return true;
  if (node.type === "Literal" && typeof node.value === "string" && pattern.test(node.value))
    return true;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      value &&
      typeof value === "object" &&
      containsNamedProperty(value, pattern),
  );
}

function hasHandlerBinding(fn: AnyNode, name: string): boolean {
  const visit = (node: AnyNode): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(visit);
    if (node.type === "VariableDeclarator" && bindsName(node.id, name)) return true;
    if (node.type === "FunctionDeclaration" && node.id?.name === name) return true;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    )
      return (
        node.params?.some((param: AnyNode) => bindsName(param, name)) ||
        (node.body && visit(node.body))
      );
    if (node.type === "BlockStatement" || node.type === "Program") return node.body.some(visit);
    return Object.entries(node).some(
      ([key, value]) => key !== "parent" && value && typeof value === "object" && visit(value),
    );
  };
  return visit(fn.body);
}

function isAuthHttpError(node: AnyNode): boolean {
  const isAuthStatus = (value: AnyNode) =>
    value?.type === "Literal" && (value.value === 401 || value.value === 403);
  const hasAuthStatus = (argument: AnyNode) =>
    argument?.type === "ObjectExpression" &&
    argument.properties.some(
      (property: AnyNode) =>
        property.type === "Property" &&
        !property.computed &&
        ["status", "statusCode"].includes(property.key.name ?? property.key.value) &&
        isAuthStatus(property.value),
    );
  if (node?.type === "NewExpression" && node.callee.type === "Identifier")
    return (
      ["HTTPError", "H3Error"].includes(node.callee.name) && node.arguments.some(hasAuthStatus)
    );
  if (node?.type !== "CallExpression") return false;
  if (node.callee.type === "Identifier")
    return node.callee.name === "createError" && hasAuthStatus(node.arguments[0]);
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "HTTPError" &&
    node.callee.property.name === "status" &&
    isAuthStatus(node.arguments[0])
  );
}

function returnsEmpty(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(returnsEmpty);
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
  if (node.type === "ReturnStatement") {
    const value = node.argument;
    return (
      !value ||
      (value.type === "Literal" && (value.value === null || value.value === false)) ||
      (value.type === "Identifier" && value.name === "undefined")
    );
  }
  return Object.entries(node).some(
    ([key, value]) => key !== "parent" && value && typeof value === "object" && returnsEmpty(value),
  );
}

function parseModule(resolver: GuardResolver, file: string): ParsedModule | null {
  if (resolver.modules.has(file)) return resolver.modules.get(file)!;
  let module: ParsedModule | null = null;
  try {
    const parsed = parseScriptSync(file, readProjectFile(resolver.ctx.fs, file));
    if (!parsed.errors.length) module = { file, program: parsed.program };
  } catch {
    module = null;
  }
  resolver.modules.set(file, module);
  return module;
}

function findGuardFunction(
  resolver: GuardResolver,
  module: ParsedModule,
  name: string,
): GuardFunction | undefined {
  const local = localFunction(module, name);
  if (local !== undefined) return local ?? undefined;
  for (const statement of module.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    const specifier = statement.specifiers.find((item: AnyNode) => item.local.name === name);
    if (!specifier) continue;
    if (specifier.type === "ImportNamespaceSpecifier") return undefined;
    const target = resolveProjectModule(resolver.ctx, module.file, statement.source.value);
    const imported = target ? parseModule(resolver, target) : null;
    if (!imported) return undefined;
    return exportedFunction(
      resolver,
      imported,
      specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : (specifier.imported.name ?? specifier.imported.value),
      new Set(),
    );
  }
  // Unbound: Nitro auto-imports server utils, so accept one unambiguous exported definition.
  const candidates = serverUtilExports(resolver).get(name) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

// undefined when the module does not bind the name, null when it binds something else.
function localFunction(module: ParsedModule, name: string): GuardFunction | null | undefined {
  for (let statement of module.program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.declaration)
      statement = statement.declaration;
    if (statement.type === "FunctionDeclaration" && statement.id?.name === name)
      return statement.body ? { module, fn: statement } : null;
    if (statement.type === "ClassDeclaration" && statement.id?.name === name) return null;
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of statement.declarations) {
      if (!bindsName(declarator.id, name)) continue;
      return statement.kind === "const" &&
        declarator.id.type === "Identifier" &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(declarator.init?.type)
        ? { module, fn: declarator.init }
        : null;
    }
  }
  return undefined;
}

function exportedFunction(
  resolver: GuardResolver,
  module: ParsedModule,
  name: string,
  visited: Set<string>,
): GuardFunction | undefined {
  const key = `${module.file}\0${name}`;
  if (visited.has(key)) return undefined;
  visited.add(key);
  for (const statement of module.program.body) {
    if (name === "default" && statement.type === "ExportDefaultDeclaration") {
      const value = statement.declaration;
      if (
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
          value.type,
        )
      )
        return value.body ? { module, fn: value } : undefined;
      return value.type === "Identifier"
        ? (localFunction(module, value.name) ?? undefined)
        : undefined;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    if (statement.declaration) {
      const local = localFunction({ ...module, program: { body: [statement] } }, name);
      if (local) return { module, fn: local.fn };
      continue;
    }
    const specifier = statement.specifiers.find(
      (item: AnyNode) =>
        item.exportKind !== "type" && (item.exported.name ?? item.exported.value) === name,
    );
    if (!specifier) continue;
    const local = specifier.local.name ?? specifier.local.value;
    if (!statement.source) return findGuardFunction(resolver, module, local);
    const target = resolveProjectModule(resolver.ctx, module.file, statement.source.value);
    const reexported = target ? parseModule(resolver, target) : null;
    return reexported ? exportedFunction(resolver, reexported, local, visited) : undefined;
  }
  return undefined;
}

function serverUtilExports(resolver: GuardResolver): Map<string, GuardFunction[]> {
  if (resolver.autoImports) return resolver.autoImports;
  const { ctx } = resolver;
  const exports = new Map<string, GuardFunction[]>();
  const directories = new Set([
    resolve(ctx.project.root, "server/utils"),
    ...(ctx.project.nuxt?.layers ?? []).map((layer) =>
      resolve(ctx.project.root, layer.serverDir ?? join(layer.root, "server"), "utils"),
    ),
  ]);
  for (const directory of directories) {
    for (const entry of ctx.fs.readDirRecursive(directory) ?? []) {
      const file = resolve(directory, entry);
      if (!/\.[cm]?[jt]s$/.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
      const module = parseModule(resolver, file);
      if (!module) continue;
      for (const statement of module.program.body) {
        if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) continue;
        const declaration = statement.declaration;
        const names =
          declaration.type === "FunctionDeclaration"
            ? [declaration.id?.name]
            : declaration.type === "VariableDeclaration"
              ? declaration.declarations.map((item: AnyNode) => item.id.name)
              : [];
        for (const name of names) {
          const fn = name && localFunction(module, name);
          if (!fn) continue;
          exports.set(name, [...(exports.get(name) ?? []), fn]);
        }
      }
    }
  }
  resolver.autoImports = exports;
  return exports;
}

function resolveProjectModule(ctx: RuleContext, file: string, source: string): string | undefined {
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
  if (!base) return undefined;
  const candidates = extname(base)
    ? [base]
    : [
        ...["ts", "js", "mts", "mjs", "cts", "cjs"].map((extension) => `${base}.${extension}`),
        ...["ts", "js", "mts", "mjs", "cts", "cjs"].map((extension) =>
          resolve(base, `index.${extension}`),
        ),
      ];
  return candidates.find((candidate) => ctx.fs.exists(candidate));
}

function readProjectFile(fs: RuleFileSystem, file: string): string {
  return fs.readText(file) ?? "";
}
