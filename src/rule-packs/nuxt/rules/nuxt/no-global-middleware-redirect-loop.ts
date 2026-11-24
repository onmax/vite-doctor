import { resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { propertyName, unwrap } from "./nuxt-config-ast.js";
import { type AnyNode, createRule, resolveSameFile, walkScriptLocal } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/routing/no-global-middleware-redirect-loop";
const NUXT_IMPORT_SOURCES = new Set(["#app", "#imports", "nuxt/app", "#app/composables/router"]);
// Nuxt composables whose value cannot change between two navigations of one redirect chain.
const STABLE_COMPOSABLES = new Set(["useState", "useCookie", "useRuntimeConfig", "useAppConfig"]);
// Globals that describe the browser location, which a guard may compare against the target.
const LOCATION_GLOBALS = new Set([
  "arguments",
  "document",
  "globalThis",
  "history",
  "location",
  "self",
  "window",
]);
const GLOBAL_MIDDLEWARE_FILE_RE = /\.global\.[cm]?[jt]sx?$/;
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

interface Redirect {
  call: AnyNode;
  target: string;
}

type Scan = { kind: "redirect"; redirect: Redirect } | { kind: "clean" } | { kind: "unsafe" };

export const noGlobalMiddlewareRedirectLoop = createRule({
  meta: {
    id: RULE_ID,
    title: "Guard global middleware redirects against the target route",
    category: "routing",
    severity: "error",
    confidence: "manifest-backed",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/directory-structure/app/middleware",
    requires: { script: true, nuxt: true },
    prefilter: { calls: ["navigateTo"] },
  },
  create(ctx) {
    const program = ctx.file.scriptAst;
    if (!program) return;
    return {
      ExportDefaultDeclaration(node: AnyNode) {
        const redirect = loopingRedirect(program, node.declaration);
        if (!redirect) return;
        const file = resolve(ctx.project.root, ctx.file.path);
        const manifest = ctx.project.nuxt?.manifest;
        const middleware = manifest?.isCurrent ? manifest.middleware : undefined;
        if (!middleware) {
          if (GLOBAL_MIDDLEWARE_FILE_RE.test(file)) reportMissingMiddleware(ctx);
          return;
        }
        const entry = middleware.find(
          (candidate) => candidate.global && resolveSameFile(candidate.path, file),
        );
        if (!entry) return;
        ctx.report(
          diagnostics.NUXT0107({
            why: `Nuxt runs the global middleware '${entry.name}' on every navigation, including the redirect to '${redirect.target}'. Nothing on the way to this navigateTo() reads the destination, so the navigation to '${redirect.target}' redirects to '${redirect.target}' again, and the redirects never settle. vue-router aborts after 30 in development and loops in production.`,
            fix: `Return early when the navigation already goes to the target, for example \`if (to.path === '${redirect.target}') return\`, or guard the redirect with a condition that reads \`to\`, such as \`to.meta.auth\`.`,
          }),
          {
            ruleId: RULE_ID,
            severity: ctx.severity,
            category: "routing",
            file: ctx.file.path,
            range: ctx.range(redirect.call),
            confidence: "manifest-backed",
            evidence: [
              {
                kind: "manifest",
                summary: `Nuxt resolved '${entry.name}' as global route middleware.`,
              },
              {
                kind: "ast",
                summary: `The middleware returns navigateTo('${redirect.target}') on a path that never reads the destination route.`,
              },
            ],
          },
        );
      },
    };
  },
});

function reportMissingMiddleware(ctx: RuleContext) {
  ctx.project.evidenceGaps = [
    ...(ctx.project.evidenceGaps ?? []),
    {
      source: "vite-doctor/nuxt-global-middleware",
      message: `${ctx.file.relativePath} may redirect every navigation to the same route, but Doctor needs Nuxt's resolved middleware to prove it runs globally. Run nuxi prepare or nuxi dev to refresh the Doctor manifest.`,
      files: [".nuxt/doctor.manifest.json"],
    },
  ];
}

function loopingRedirect(program: AnyNode, declaration: AnyNode): Redirect | null {
  const bindings = fileBindings(program);
  const fn = middlewareFunction(declaration, bindings);
  if (!fn || fn.params.length > 2) return null;
  const [to, from] = fn.params;
  if ((to && to.type !== "Identifier") || (from && from.type !== "Identifier")) return null;
  const locals = new Set<string>(from ? [from.name] : []);
  let readsRoute = false;
  walkScriptLocal(fn.body, (node) => {
    if (node.type !== "Identifier" || !isReference(node)) return;
    if (node.name === to?.name || LOCATION_GLOBALS.has(node.name)) readsRoute = true;
  });
  if (readsRoute) return null;
  if (fn.body.type !== "BlockStatement") return redirectCall(fn.body, bindings);
  const result = scanStatements(fn.body.body, bindings, locals);
  return result.kind === "redirect" ? result.redirect : null;
}

function middlewareFunction(declaration: AnyNode, bindings: Bindings): AnyNode {
  let node = unwrap(declaration);
  if (node?.type === "CallExpression") {
    if (!isNuxtCall(node, "defineNuxtRouteMiddleware", bindings) || node.arguments.length !== 1)
      return null;
    node = unwrap(node.arguments[0]);
  }
  return FUNCTION_TYPES.has(node?.type) && !node.generator ? node : null;
}

// Each statement before the redirect runs again on the next navigation, so it may only read
// values that stay the same between the two.
function scanStatements(statements: AnyNode[], bindings: Bindings, locals: Set<string>): Scan {
  for (const statement of statements) {
    const result = scanStatement(statement, bindings, locals);
    if (result.kind !== "clean") return result;
  }
  return { kind: "clean" };
}

function scanStatement(statement: AnyNode, bindings: Bindings, locals: Set<string>): Scan {
  switch (statement.type) {
    case "EmptyStatement":
      return { kind: "clean" };
    case "BlockStatement":
      return scanStatements(statement.body, bindings, new Set(locals));
    case "ReturnStatement": {
      const redirect = statement.argument ? redirectCall(statement.argument, bindings) : null;
      return redirect ? { kind: "redirect", redirect } : { kind: "unsafe" };
    }
    case "VariableDeclaration":
      for (const declarator of statement.declarations) {
        if (!declarator.init || !isStable(declarator.init, bindings, locals))
          return { kind: "unsafe" };
        for (const name of patternNames(declarator.id)) locals.add(name);
      }
      return { kind: "clean" };
    case "ExpressionStatement":
      return isConsoleCall(statement.expression, bindings, locals)
        ? { kind: "clean" }
        : { kind: "unsafe" };
    case "IfStatement": {
      if (!isStable(statement.test, bindings, locals)) return { kind: "unsafe" };
      const branches = [statement.consequent, statement.alternate].filter(Boolean);
      for (const branch of branches) {
        const result = scanStatement(branch, bindings, new Set(locals));
        if (result.kind === "redirect") return result;
      }
      // A branch that leaves the middleware ends this navigation's run before the redirect,
      // and its stable condition takes it the same way on the next run.
      return branches.every(
        (branch) =>
          alwaysExits(branch) || scanStatement(branch, bindings, new Set(locals)).kind === "clean",
      )
        ? { kind: "clean" }
        : { kind: "unsafe" };
    }
    default:
      return { kind: "unsafe" };
  }
}

function alwaysExits(statement: AnyNode): boolean {
  if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") return true;
  if (statement.type !== "BlockStatement" || !statement.body.length) return false;
  if (containsLoopControl(statement)) return false;
  return alwaysExits(statement.body[statement.body.length - 1]);
}

function containsLoopControl(node: AnyNode): boolean {
  let found = false;
  walkScriptLocal(node, (child) => {
    if (child.type === "BreakStatement" || child.type === "ContinueStatement") found = true;
  });
  return found;
}

function redirectCall(node: AnyNode, bindings: Bindings): Redirect | null {
  let call = unwrap(node);
  if (call?.type === "AwaitExpression") call = unwrap(call.argument);
  if (call?.type !== "CallExpression" || !isNuxtCall(call, "navigateTo", bindings)) return null;
  if (call.arguments.length > 2) return null;
  const target = staticTarget(unwrap(call.arguments[0]));
  if (!target) return null;
  const options = call.arguments[1] && unwrap(call.arguments[1]);
  if (options && !isInternalRedirectOptions(options)) return null;
  return { call, target };
}

function staticTarget(node: AnyNode): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return internalPath(node.value);
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return internalPath(node.quasis[0]?.value.cooked);
  if (node?.type !== "ObjectExpression") return null;
  let path: string | null = null;
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") return null;
    const key = propertyName(property);
    if (key === "path") path = staticTarget(unwrap(property.value));
    else if (key !== "query" && key !== "hash" && key !== "replace") return null;
  }
  return path;
}

function internalPath(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : null;
}

// `external` and `open` leave the router, so only these options keep the redirect inside it.
function isInternalRedirectOptions(node: AnyNode): boolean {
  if (node.type !== "ObjectExpression") return false;
  return node.properties.every(
    (property: AnyNode) =>
      property.type === "Property" &&
      !property.computed &&
      ["replace", "redirectCode"].includes(propertyName(property) ?? ""),
  );
}

function isStable(node: AnyNode, bindings: Bindings, locals: Set<string>): boolean {
  const value = unwrap(node);
  if (!value) return true;
  switch (value.type) {
    case "Literal":
    case "Identifier":
    case "MetaProperty":
    case "ThisExpression":
      return true;
    case "TemplateLiteral":
      return value.expressions.every((child: AnyNode) => isStable(child, bindings, locals));
    case "MemberExpression":
      return (
        isStable(value.object, bindings, locals) &&
        (!value.computed || isStable(value.property, bindings, locals))
      );
    case "ChainExpression":
      return isStable(value.expression, bindings, locals);
    case "UnaryExpression":
      return value.operator !== "delete" && isStable(value.argument, bindings, locals);
    case "BinaryExpression":
    case "LogicalExpression":
      return isStable(value.left, bindings, locals) && isStable(value.right, bindings, locals);
    case "ConditionalExpression":
      return [value.test, value.consequent, value.alternate].every((child) =>
        isStable(child, bindings, locals),
      );
    case "ArrayExpression":
      return value.elements.every(
        (child: AnyNode) => child?.type !== "SpreadElement" && isStable(child, bindings, locals),
      );
    case "CallExpression":
      return (
        value.callee?.type === "Identifier" &&
        STABLE_COMPOSABLES.has(value.callee.name) &&
        !locals.has(value.callee.name) &&
        isNuxtBinding(value.callee.name, bindings) &&
        value.arguments.every(
          (argument: AnyNode) =>
            FUNCTION_TYPES.has(unwrap(argument)?.type) ||
            unwrap(argument)?.type === "ObjectExpression" ||
            isStable(argument, bindings, locals),
        )
      );
    default:
      return false;
  }
}

function isConsoleCall(node: AnyNode, bindings: Bindings, locals: Set<string>): boolean {
  const call = unwrap(node);
  return (
    call?.type === "CallExpression" &&
    call.callee?.type === "MemberExpression" &&
    call.callee.object?.type === "Identifier" &&
    call.callee.object.name === "console" &&
    !bindings.has("console") &&
    call.arguments.every((argument: AnyNode) => isStable(argument, bindings, locals))
  );
}

function isNuxtCall(node: AnyNode, name: string, bindings: Bindings): boolean {
  return (
    node.callee?.type === "Identifier" && node.callee.name === name && isNuxtBinding(name, bindings)
  );
}

// Unbound names are Nuxt auto-imports; anything declared in the file must come from Nuxt.
function isNuxtBinding(name: string, bindings: Bindings): boolean {
  const binding = bindings.get(name);
  return binding === undefined || (binding !== null && NUXT_IMPORT_SOURCES.has(binding));
}

/** Every name the file declares, mapped to its import source, or null for local declarations. */
type Bindings = Map<string, string | null>;

function fileBindings(program: AnyNode): Bindings {
  const bindings: Bindings = new Map();
  walkScriptLocal(program, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers ?? []) {
        const imported = specifier.imported?.name ?? specifier.imported?.value;
        bindings.set(
          specifier.local.name,
          specifier.type === "ImportSpecifier" && imported === specifier.local.name
            ? node.source.value
            : null,
        );
      }
    } else if (node.type === "VariableDeclarator") {
      for (const name of patternNames(node.id)) bindings.set(name, null);
    } else if (FUNCTION_TYPES.has(node.type)) {
      if (node.id?.name) bindings.set(node.id.name, null);
      for (const param of node.params ?? []) {
        for (const name of patternNames(param)) bindings.set(name, null);
      }
    } else if (node.type === "ClassDeclaration" && node.id?.name) {
      bindings.set(node.id.name, null);
    } else if (node.type === "CatchClause" && node.param) {
      for (const name of patternNames(node.param)) bindings.set(name, null);
    }
  });
  return bindings;
}

function patternNames(pattern: AnyNode): string[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property: AnyNode) =>
        patternNames(property.type === "RestElement" ? property.argument : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element: AnyNode) => patternNames(element));
    case "RestElement":
      return patternNames(pattern.argument);
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "TSParameterProperty":
      return patternNames(pattern.parameter);
    default:
      return [];
  }
}

function isReference(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression") return parent.object === node || parent.computed;
  if (parent?.type === "Property" || parent?.type === "MethodDefinition")
    return parent.key !== node || parent.computed || parent.shorthand;
  return true;
}
