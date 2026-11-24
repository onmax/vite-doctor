import { resolve } from "pathe";
import type { RuleContext } from "../../../../core/index.js";
import { propertyName, unwrap } from "./nuxt-config-ast.js";
import { type AnyNode, createRule, resolveSameFile, walkScriptLocal } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/routing/no-global-middleware-redirect-loop";
const NUXT_IMPORT_SOURCES = new Set(["#app", "#imports", "nuxt/app", "#app/composables/router"]);
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

type Scan = Redirect | "continue" | "stop";

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
        const pathname = redirect.target.split(/[?#]/, 1)[0]!;
        const example = /^\/[\w./~-]*$/.test(pathname)
          ? `, for example \`if (to.path === ${JSON.stringify(pathname)}) return\``
          : "";
        ctx.report(
          diagnostics.NUXT0107({
            why: `Nuxt runs the global middleware '${entry.name}' on every navigation, including the redirect to '${redirect.target}'. Nothing on the way to this navigateTo() reads the destination, so the navigation to '${redirect.target}' redirects to '${redirect.target}' again, and the redirects never settle. vue-router aborts after 30 in development and loops in production.`,
            fix: `Return early when the navigation already goes to the target${example}, or guard the redirect with a condition that reads \`to\`, such as \`to.meta.auth\`.`,
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
  let readsRoute = false;
  walkScriptLocal(fn.body, (node) => {
    if (node.type !== "Identifier" || !isReference(node)) return;
    if (node.name === to?.name || LOCATION_GLOBALS.has(node.name)) readsRoute = true;
  });
  if (readsRoute) return null;
  if (fn.body.type !== "BlockStatement") return redirectCall(fn.body, bindings);
  for (const client of [true, false]) {
    const result = scanStatements(fn.body.body, bindings, client);
    if (typeof result === "object") return result;
  }
  return null;
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
function scanStatements(statements: AnyNode[], bindings: Bindings, client: boolean): Scan {
  for (const statement of statements) {
    const result = scanStatement(statement, bindings, client);
    if (result !== "continue") return result;
  }
  return "continue";
}

function scanStatement(statement: AnyNode, bindings: Bindings, client: boolean): Scan {
  switch (statement.type) {
    case "EmptyStatement":
      return "continue";
    case "BlockStatement":
      return scanStatements(statement.body, bindings, client);
    case "ReturnStatement":
      return redirectCall(statement.argument, bindings) ?? "stop";
    case "VariableDeclaration":
      return statement.declarations.every(
        (declarator: AnyNode) =>
          declarator.id.type === "Identifier" &&
          (!declarator.init || isStaticValue(declarator.init)),
      )
        ? "continue"
        : "stop";
    case "IfStatement": {
      const test = branchCondition(statement.test, client);
      if (test === undefined) return "stop";
      const branch = test ? statement.consequent : statement.alternate;
      return branch ? scanStatement(branch, bindings, client) : "continue";
    }
    default:
      return "stop";
  }
}

function branchCondition(node: AnyNode, client: boolean): boolean | undefined {
  const test = unwrap(node);
  if (test.type === "Literal") return Boolean(test.value);
  if (test.type === "UnaryExpression" && test.operator === "!") {
    const operand = branchCondition(test.argument, client);
    return operand === undefined ? undefined : !operand;
  }
  if (
    test.type === "MemberExpression" &&
    !test.computed &&
    test.object.type === "MetaProperty" &&
    test.object.meta.name === "import" &&
    test.object.property.name === "meta"
  ) {
    if (test.property.name === "client") return client;
    if (test.property.name === "server") return !client;
  }
}

function redirectCall(node: AnyNode, bindings: Bindings): Redirect | null {
  let call = unwrap(node);
  if (call?.type === "AwaitExpression") call = unwrap(call.argument);
  if (call?.type !== "CallExpression" || !isNuxtCall(call, "navigateTo", bindings)) return null;
  if (call.arguments.length > 2) return null;
  if (!call.arguments.every(isStaticValue)) return null;
  const target = staticTarget(unwrap(call.arguments[0]));
  if (!target) return null;
  const options = call.arguments[1] && unwrap(call.arguments[1]);
  if (options && !isInternalRedirectOptions(options)) return null;
  return { call, target };
}

function staticString(node: AnyNode): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return internalPath(node.value);
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return internalPath(node.quasis[0]?.value.cooked);
  return null;
}

function staticTarget(node: AnyNode): string | null {
  if (node?.type !== "ObjectExpression") return staticString(node);
  let path: string | null = null;
  for (const property of node.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init") return null;
    const key = propertyName(property);
    if (key === "path") path = staticString(unwrap(property.value));
    else if (key !== "query" && key !== "hash" && key !== "replace") return null;
  }
  return path;
}

function internalPath(value: unknown): string | null {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
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

function isStaticValue(node: AnyNode): boolean {
  const value = unwrap(node);
  switch (value?.type) {
    case "Literal":
      return value.value === null || ["string", "boolean", "number"].includes(typeof value.value);
    case "TemplateLiteral":
      return value.expressions.length === 0;
    case "ArrayExpression":
      return value.elements.every(isStaticValue);
    case "ObjectExpression":
      return value.properties.every(
        (property: AnyNode) =>
          property.type === "Property" &&
          !property.computed &&
          property.kind === "init" &&
          propertyName(property) !== "__proto__" &&
          isStaticValue(property.value),
      );
    default:
      return false;
  }
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
