import { parseSync } from "oxc-parser";
import { join, resolve } from "pathe";
import {
  createRule,
  defineRulePack,
  type DoctorRule,
  type NuxtProjectInfo,
  type RuleContext,
} from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

// Modules that mount the Better Auth handler at /api/auth/** themselves; nuxt-better-auth does it
// through its nitro-better-auth Nitro module.
const HANDLER_MODULES = new Set(["@nuxtjs/better-auth", "nuxt-better-auth"]);
const HANDLER_MODULE_TEXT = /["'](?:@nuxtjs\/better-auth|nuxt-better-auth)["']/;
const SCRIPT = "{ts,js,mts,mjs,cts,cjs}";
// Where Better Auth's CLI looks for the auth instance, plus the Nitro server directory.
const INSTANCE_GLOBS = [
  `server/**/*.${SCRIPT}`,
  ...["", "app/", "src/"].flatMap((dir) => [
    `${dir}{lib,utils}/**/*.${SCRIPT}`,
    `${dir}auth.${SCRIPT}`,
  ]),
];
const NUXT_CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (extension) => `nuxt.config.${extension}`,
);
const AUTH_CATCH_ALL_ROUTE = /^\/api\/auth\/(?:\*\*(?::\w+)?|\[\.\.\.\w*\])$/;

export const requireStandardAuthHandlerMount = createRule({
  meta: {
    id: "nuxt-better-auth/require-standard-auth-handler-mount",
    title: "Mount Better Auth at the standard catch-all route",
    category: "auth",
    severity: "warn",
    fixable: "suggestion",
    execution: "manifest",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    return {
      NuxtManifest(nuxt) {
        const root = resolve(ctx.project.root, nuxt.layers[0]?.root ?? ".");
        // An installed Better Auth package is not evidence: without a server instance there is
        // nothing to mount.
        const instance = findAuthInstance(ctx, root);
        if (!instance || hasAuthHandler(ctx, nuxt, root)) return;
        ctx.report(
          diagnostics.NUXT0003({
            why: "Nuxt Better Auth should expose the standard server/api/auth/[...all] handler.",
            fix: "Add server/api/auth/[...all].ts using the Better Auth Nuxt handler, or register @nuxtjs/better-auth, which mounts it.",
          }),
          {
            ruleId: "nuxt-better-auth/require-standard-auth-handler-mount",
            severity: "warn",
            category: "auth",
            file: instance.file,
            range: instance.range,
          },
        );
      },
    };
  },
});

function hasAuthHandler(ctx: RuleContext, nuxt: NuxtProjectInfo, root: string): boolean {
  if (
    [...nuxt.serverDirs.api, ...nuxt.serverDirs.routes].some((file) =>
      /server\/api\/auth\/\[\.\.\.all\]\.[cm]?[jt]s$/.test(file),
    )
  )
    return true;
  const manifest = nuxt.manifest?.isCurrent ? nuxt.manifest : undefined;
  if (
    [...(manifest?.serverHandlers ?? []), ...(manifest?.resolvedServerHandlers ?? [])].some(
      (handler) => !handler.middleware && AUTH_CATCH_ALL_ROUTE.test(handler.route ?? ""),
    )
  )
    return true;
  const layerRoots = [root, ...nuxt.layers.map((layer) => resolve(ctx.project.root, layer.root))];
  return [...new Set(layerRoots)].some((layer) =>
    NUXT_CONFIG_FILES.some((name) => registersHandlerModule(join(layer, name), ctx)),
  );
}

/** Whether a Nuxt config's `modules` names a handler module; unreadable `modules` counts. */
function registersHandlerModule(file: string, ctx: RuleContext): boolean {
  const text = ctx.fs.readText(file);
  if (text === undefined || !HANDLER_MODULE_TEXT.test(text)) return false;
  const modules = configModules(file, text);
  if (!modules) return true;
  return modules.some((name) => HANDLER_MODULES.has(name));
}

/** Statically named entries of `modules`, or `undefined` when they cannot be read. */
function configModules(file: string, text: string): string[] | undefined {
  const program = parseProgram(file, text);
  if (!program) return undefined;
  const imports = new Map<string, string>();
  for (const statement of program.body)
    if (statement.type === "ImportDeclaration")
      for (const specifier of statement.specifiers)
        if (specifier.type === "ImportDefaultSpecifier")
          imports.set(specifier.local.name, statement.source.value);
  let config = program.body.find(
    (statement: AnyNode) => statement.type === "ExportDefaultDeclaration",
  )?.declaration;
  while (
    ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(config?.type)
  )
    config = config.expression;
  if (config?.type === "CallExpression" && config.arguments.length === 1)
    config = config.arguments[0];
  if (config?.type !== "ObjectExpression") return undefined;
  let modules: AnyNode;
  for (const property of config.properties) {
    if (property.type !== "Property" || property.computed) return undefined;
    if ((property.key.name ?? property.key.value) === "modules") modules = property.value;
  }
  if (!modules) return [];
  if (modules.type !== "ArrayExpression") return undefined;
  const names: string[] = [];
  for (const entry of modules.elements) {
    const name = entry?.type === "ArrayExpression" ? entry.elements[0] : entry;
    if (name?.type === "Literal" && typeof name.value === "string") names.push(name.value);
    else if (name?.type === "Identifier") {
      const source = imports.get(name.name);
      if (source === undefined) return undefined;
      names.push(source);
    } else if (name?.type !== "CallExpression") return undefined;
  }
  return names;
}

function parseProgram(file: string, text: string): AnyNode {
  try {
    const parsed = parseSync(file, text, { sourceType: "module", lang: "ts" });
    return parsed.errors.length ? undefined : parsed.program;
  } catch {
    return undefined;
  }
}

/** The first call to `betterAuth` imported from better-auth, under any local name. */
function betterAuthCall(file: string, text: string): { start: number; end: number } | undefined {
  if (!text.includes("better-auth")) return undefined;
  const program = parseProgram(file, text);
  if (!program) return undefined;
  const callees = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "better-auth")
      continue;
    if (statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
      else if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        (specifier.imported.name ?? specifier.imported.value) === "betterAuth"
      )
        callees.add(specifier.local.name);
    }
  }
  if (!callees.size && !namespaces.size) return undefined;
  let found: AnyNode;
  const visit = (node: AnyNode) => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const callee = node.type === "CallExpression" ? node.callee : undefined;
    if (
      (callee?.type === "Identifier" && callees.has(callee.name)) ||
      (callee?.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name) &&
        callee.property.name === "betterAuth")
    ) {
      found = callee;
      return;
    }
    for (const key in node) visit(node[key]);
  };
  visit(program.body);
  return found && { start: found.start, end: found.end };
}

/** The first `betterAuth()` call, the server instance whose handler must be mounted. */
function findAuthInstance(ctx: RuleContext, root: string) {
  for (const pattern of INSTANCE_GLOBS) {
    for (const file of ctx.fs.glob(pattern, { cwd: root, exclude: ["**/node_modules/**"] })) {
      const text = ctx.fs.readText(file);
      const call = text === undefined ? undefined : betterAuthCall(file, text);
      if (text !== undefined && call)
        return { file, range: ctx.helpers.rangeFromOffsets(file, text, call.start, call.end) };
    }
  }
  return undefined;
}

export const rules: DoctorRule[] = [requireStandardAuthHandlerMount];

export const nuxtBetterAuthRulePack = defineRulePack({
  name: "vite-doctor/nuxt-better-auth",
  version: "0.0.0",
  activation: {
    nuxt: ">=4",
    packages: ["better-auth", "nuxt-better-auth"],
    modules: ["nuxt-better-auth"],
  },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default nuxtBetterAuthRulePack;
