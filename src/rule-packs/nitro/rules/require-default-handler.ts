import { relative } from "pathe";
import type { ProjectInfo, RuleContext } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { type AnyNode, createRule } from "./shared.js";
import { type NitroServerFile, nitroRouteFile, runtimeMajor } from "./server-layout.js";

const RULE_ID = "nitro/routes/require-default-handler";
const METHOD_OR_ENV_SUFFIX =
  /(?:\.(?:connect|delete|get|head|options|patch|post|put|trace))?(?:\.(?:dev|prod|prerender))?$/;

interface RuntimeExport {
  node: AnyNode;
  names: string[];
}

interface RequireDefaultHandlerOptions {
  allowedExports?: string[];
}

const NON_EVENT_TYPE_KEYWORDS = new Set([
  "TSArrayType",
  "TSBigIntKeyword",
  "TSBooleanKeyword",
  "TSLiteralType",
  "TSNumberKeyword",
  "TSStringKeyword",
  "TSSymbolKeyword",
  "TSTupleType",
]);
const NON_EVENT_TYPE_NAMES = new Set(["Array", "Date", "Map", "ReadonlyArray", "Record", "Set"]);

export const requireDefaultHandler = createRule({
  meta: {
    id: RULE_ID,
    title: "Default-export a handler from every Nitro route file",
    category: "routing",
    severity: "error",
    fixable: "suggestion",
    diagnosticCodes: ["NITRO0019", "NITRO0020"],
    docsUrl: "https://nitro.build/docs/routing",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    const route = nitroRouteFile(ctx, ctx.file.path);
    if (!route) return;
    const allowedExports = new Set(allowedExportsOption(ctx.options));
    return {
      Program(node: AnyNode) {
        const { defaultExport, defaultLocal, defaultValue, runtimeExports } = moduleExports(node);
        if (!defaultExport) {
          if (hasCommonJsDefault(node)) return;
          reportMissingHandler(ctx, route, runtimeExports);
          return;
        }
        const notHandler = defaultValue && nonHandlerDescription(defaultValue, node);
        if (notHandler) {
          reportNonHandlerDefault(ctx, route, defaultValue, notHandler);
          return;
        }
        for (const runtimeExport of runtimeExports) {
          const names = runtimeExport.names.filter(
            (name) => name !== defaultLocal && !allowedExports.has(name),
          );
          if (!names.length) continue;
          reportExtraExports(ctx, route, runtimeExport.node, names);
        }
      },
    };
  },
});

function reportMissingHandler(
  ctx: RuleContext,
  route: NitroServerFile,
  runtimeExports: RuntimeExport[],
) {
  const names = runtimeExports.flatMap((item) => item.names);
  const exported = names.length
    ? `exports ${formatNames(names)} but has no default export`
    : "has no default export";
  const handler =
    (runtimeMajor(ctx.project, "nitro") ?? 2) >= 3 ? "defineHandler" : "defineEventHandler";
  ctx.helpers.report(
    ctx,
    null,
    diagnostics.NITRO0019({
      why: `Nitro registers this file as the ${routePath(route)} route, but it ${exported}. The route has no working handler.`,
      fix: names.length
        ? `Move ${formatNames(names)} to ${utilsDir(ctx.project, route)}/ and import them where needed, or default-export a ${handler}() if this file should serve ${routePath(route)}.`
        : `Default-export a ${handler}() if this file should serve ${routePath(route)}; otherwise move it out of ${route.dir}/.`,
    }),
    {
      ruleId: RULE_ID,
      severity: "error",
      category: "routing",
      range: ctx.range(runtimeExports[0]?.node ?? 0),
    },
  );
}

function reportNonHandlerDefault(
  ctx: RuleContext,
  route: NitroServerFile,
  node: AnyNode,
  description: { label: string; name?: string },
) {
  const handler =
    (runtimeMajor(ctx.project, "nitro") ?? 2) >= 3 ? "defineHandler" : "defineEventHandler";
  const moved = description.name ?? "this module";
  ctx.helpers.report(
    ctx,
    node,
    diagnostics.NITRO0019({
      why: `Nitro registers this file as the ${routePath(route)} route, but its default export is ${description.label}, not an event handler. The route has no working handler.`,
      fix: `Move ${moved} to ${utilsDir(ctx.project, route)}/ and import it where needed, or default-export a ${handler}() if this file should serve ${routePath(route)}.`,
    }),
    { ruleId: RULE_ID, severity: "error", category: "routing" },
  );
}

function reportExtraExports(
  ctx: RuleContext,
  route: NitroServerFile,
  node: AnyNode,
  names: string[],
) {
  ctx.helpers.report(
    ctx,
    node,
    diagnostics.NITRO0020({
      why: `This ${routePath(route)} route module also exports ${formatNames(names)}. Nitro only uses the default export, so these exports are only reachable by importing the route module, which also loads its handler and dependencies.`,
      fix: `Move ${formatNames(names)} to ${utilsDir(ctx.project, route)}/ and keep the handler as this file's only runtime export. Type-only exports can stay. If a build step reads these exports intentionally, list them in this rule's allowedExports option.`,
    }),
    { ruleId: RULE_ID, severity: "warn", category: "routing" },
  );
}

function moduleExports(program: AnyNode) {
  let defaultExport = false;
  let defaultLocal: string | undefined;
  let defaultValue: AnyNode;
  const runtimeExports: RuntimeExport[] = [];
  for (const statement of program.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      defaultExport = true;
      defaultLocal = declaredName(statement.declaration);
      defaultValue = statement.declaration;
    } else if (statement.type === "TSExportAssignment") {
      defaultExport = true;
    } else if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") continue;
      const exported = moduleExportName(statement.exported);
      if (exported === "default") defaultExport = true;
      else
        runtimeExports.push({
          node: statement,
          names: [exported ?? `* from "${statement.source?.value}"`],
        });
    } else if (statement.type === "ExportNamedDeclaration") {
      if (statement.exportKind === "type") continue;
      const names: string[] = [];
      if (statement.declaration) {
        if (!isTypeOnlyDeclaration(statement.declaration))
          names.push(...declarationNames(statement.declaration));
      }
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.exportKind === "type") continue;
        const exported = moduleExportName(specifier.exported);
        if (exported === "default") {
          defaultExport = true;
          if (!statement.source) {
            defaultLocal = moduleExportName(specifier.local);
            defaultValue = specifier.local;
          }
        } else if (exported) names.push(exported);
      }
      if (names.length) runtimeExports.push({ node: statement, names });
    }
  }
  return { defaultExport, defaultLocal, defaultValue, runtimeExports };
}

function allowedExportsOption(options: unknown): string[] {
  const allowed = (options as RequireDefaultHandlerOptions | undefined)?.allowedExports;
  return Array.isArray(allowed) ? allowed.filter((name) => typeof name === "string") : [];
}

// Unknown calls and imports may produce handlers, so only shapes that can never serve an event count.
function nonHandlerDescription(
  node: AnyNode,
  program: AnyNode,
  resolved = false,
): { label: string; name?: string } | undefined {
  const value = unwrapExpression(node);
  if (value?.type === "Identifier") {
    if (resolved) return undefined;
    const binding = localBinding(program, value.name);
    const description = binding && nonHandlerDescription(binding, program, true);
    return description && { ...description, name: description.name ?? value.name };
  }
  if (
    value?.type === "FunctionDeclaration" ||
    value?.type === "FunctionExpression" ||
    value?.type === "ArrowFunctionExpression"
  ) {
    if (!hasNonEventParameters(value.params ?? [])) return undefined;
    const name = moduleExportName(value.id);
    const params = (value.params ?? []).flatMap(patternNames).join(", ");
    return { label: `${name ? `${name}(), ` : ""}a function that takes (${params})`, name };
  }
  if (value?.type === "ClassDeclaration" || value?.type === "ClassExpression") {
    const name = moduleExportName(value.id);
    return { label: name ? `the class ${name}` : "a class", name };
  }
  if (value?.type === "ObjectExpression") {
    return isHandlerObject(value) ? undefined : { label: "a plain object" };
  }
  if (value?.type === "ArrayExpression") return { label: "an array" };
  if (value?.type === "Literal" || value?.type === "TemplateLiteral")
    return { label: "a constant value" };
  return undefined;
}

function unwrapExpression(node: AnyNode): AnyNode {
  let current = node;
  while (
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression"
  )
    current = current.expression;
  return current;
}

function localBinding(program: AnyNode, name: string): AnyNode {
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
      declaration.id?.name === name
    )
      return declaration;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type === "Identifier" && declarator.id.name === name)
        return declarator.init ?? undefined;
    }
  }
  return undefined;
}

// Nitro calls a route handler with the event alone, so a second required parameter is never filled.
function hasNonEventParameters(params: AnyNode[]) {
  const [first, second] = params;
  if (second && isRequiredParameter(second)) return true;
  if (!first) return false;
  if (first.type === "ArrayPattern") return true;
  const type = first.typeAnnotation?.typeAnnotation;
  if (!type) return false;
  if (NON_EVENT_TYPE_KEYWORDS.has(type.type)) return true;
  return (
    type.type === "TSTypeReference" &&
    type.typeName?.type === "Identifier" &&
    NON_EVENT_TYPE_NAMES.has(type.typeName.name)
  );
}

function isRequiredParameter(param: AnyNode) {
  if (param.type === "AssignmentPattern" || param.type === "RestElement") return false;
  if (param.type === "TSParameterProperty") return false;
  return param.optional !== true;
}

function isHandlerObject(node: AnyNode) {
  return (node.properties ?? []).some((property: AnyNode) => {
    if (property.type !== "Property") return true;
    const key = property.computed ? undefined : moduleExportName(property.key);
    return key === undefined || key === "handler" || key === "fetch";
  });
}

function hasCommonJsDefault(program: AnyNode) {
  return (program.body ?? []).some((statement: AnyNode) => {
    const expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;
    if (expression?.type !== "AssignmentExpression") return false;
    const left = expression.left;
    if (left?.type !== "MemberExpression" || left.computed) return false;
    const object = left.object;
    const property = left.property;
    return (
      (object?.type === "Identifier" &&
        object.name === "module" &&
        property?.type === "Identifier" &&
        property.name === "exports") ||
      (object?.type === "Identifier" &&
        object.name === "exports" &&
        property?.type === "Identifier" &&
        property.name === "default")
    );
  });
}

function isTypeOnlyDeclaration(declaration: AnyNode) {
  return (
    declaration.declare === true ||
    declaration.type === "TSTypeAliasDeclaration" ||
    declaration.type === "TSInterfaceDeclaration" ||
    (declaration.type === "TSEnumDeclaration" && declaration.const === true)
  );
}

function declarationNames(declaration: AnyNode): string[] {
  if (declaration.type === "VariableDeclaration")
    return declaration.declarations.flatMap((item: AnyNode) => patternNames(item.id));
  const name = declaredName(declaration) ?? moduleExportName(declaration.id);
  return name ? [name] : [];
}

function declaredName(node: AnyNode): string | undefined {
  if (node?.type === "Identifier") return node.name;
  if (
    node?.type === "FunctionDeclaration" ||
    node?.type === "ClassDeclaration" ||
    node?.type === "TSEnumDeclaration" ||
    node?.type === "TSModuleDeclaration"
  )
    return moduleExportName(node.id);
  return undefined;
}

function patternNames(pattern: AnyNode): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((property: AnyNode) =>
      patternNames(property.type === "RestElement" ? property.argument : property.value),
    );
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(patternNames);
  if (pattern.type === "AssignmentPattern") return patternNames(pattern.left);
  if (pattern.type === "RestElement") return patternNames(pattern.argument);
  return [];
}

function moduleExportName(node: AnyNode): string | undefined {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

function routePath(route: NitroServerFile) {
  const prefix = route.dir === "api" ? "/api" : "";
  const path = route.path
    .slice(route.dir.length + 1)
    .replace(/\.[A-Za-z]+$/, "")
    .replace(/\(([^(/\\]+)\)[/\\]/g, "")
    .replace(/\[\.{3}]/g, "**")
    .replace(/\[\.{3}(\w+)]/g, "**:$1")
    .replace(/\[([^/\]]+)]/g, ":$1")
    .replace(METHOD_OR_ENV_SUFFIX, "");
  return `${prefix}/${path}`.replace(/\/index$/, "") || "/";
}

function utilsDir(project: ProjectInfo, route: NitroServerFile) {
  const serverDir = relative(project.root, route.serverDir);
  return serverDir && serverDir !== "." ? `${serverDir}/utils` : "utils";
}

function formatNames(names: string[]) {
  const quoted = names.map((name) => (name.startsWith("* from") ? `export ${name}` : name));
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}
