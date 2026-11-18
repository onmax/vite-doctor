import { readFileSync } from "node:fs";
import { Visitor, type AssignmentExpression, type Node, type ObjectExpression } from "oxc-parser";
import type { DoctorSerializableConfig } from "../primitives.js";
import { lineColumnAt } from "./line-index.js";
import { parseScriptSync } from "./script.js";

export class ViteConfigDoctorError extends Error {}

/**
 * Reads the `doctor` key of the project's `vite.config.*` without executing the file, the same way
 * Vite+ reads `defaultPackage`. The CLI never runs project code unasked, so the value must be a
 * literal, optionally wrapped in `defineDoctorConfig()`.
 */
export function readViteConfigDoctor(
  file: string,
): { config: DoctorSerializableConfig } | undefined {
  const source = readFileSync(file, "utf8");
  const { program, errors } = parseScriptSync(file, source);
  const viteHelpers = new Set<string>();
  const doctorHelpers = new Set<string>();
  const body: Node[] = program.body;
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
      const imported = propertyName(specifier.imported);
      const module = statement.source.value;
      if (imported === "defineConfig" && (module === "vite" || module === "vite-plus")) {
        viteHelpers.add(specifier.local.name);
      }
      if (
        imported === "defineDoctorConfig" &&
        (module === "vite-doctor" || module === "vite-doctor/config")
      ) {
        doctorHelpers.add(specifier.local.name);
      }
    }
  }

  const commonJsExports: AssignmentExpression[] = [];
  const identifiers = new Map<string, number[]>();
  let commonJsReferences = 0;
  let visibleDoctorKey: Node | undefined;
  new Visitor({
    Property(node) {
      if (propertyName(node.key, node.computed) === "doctor") visibleDoctorKey ??= node;
    },
    Identifier(node) {
      const positions = identifiers.get(node.name);
      if (positions) positions.push(node.start);
      else identifiers.set(node.name, [node.start]);
    },
    MemberExpression(node) {
      if (isCommonJsExport(node)) commonJsReferences++;
    },
    AssignmentExpression(node) {
      const left = node.left;
      if (left.type !== "MemberExpression") return;
      if (propertyName(left.property, left.computed) === "doctor") visibleDoctorKey ??= left;
      if (isCommonJsExport(left)) commonJsExports.push(node);
    },
  }).visit(program);

  const exported = exportedValue(body, commonJsExports, commonJsReferences);
  const config =
    exported && !errors.some((error) => error.severity === "Error")
      ? configObject(exported, body, viteHelpers, identifiers)
      : undefined;
  if (!config) {
    if (visibleDoctorKey)
      throw notLiteral(
        source,
        visibleDoctorKey,
        "must be in a supported static Vite config export",
      );
    return undefined;
  }
  let ambiguousProperty: Node | undefined;
  const property = config.object.properties.findLast((item) => {
    const name = item.type === "Property" ? propertyName(item.key, item.computed) : undefined;
    if (name === undefined) ambiguousProperty ??= item;
    return name === "doctor";
  });
  if (ambiguousProperty && (property || visibleDoctorKey)) {
    throw notLiteral(
      source,
      ambiguousProperty,
      "cannot be determined past a spread or computed key",
    );
  }
  if (!property || property.type !== "Property") return undefined;
  if (property.kind !== "init" || property.method || property.shorthand) {
    throw notLiteral(source, property, "must be a plain property with a literal value");
  }
  let value: Node = unwrap(property.value as Node);
  const argument = identityArgument(value, doctorHelpers);
  if (argument && value.type === "CallExpression" && value.callee.type === "Identifier") {
    const positions = identifiers.get(value.callee.name);
    if (
      !config.params.some((param) =>
        positions?.some((start) => start >= param.start && start < param.end),
      )
    ) {
      value = unwrap(argument);
    }
  }
  const literal = toLiteral(value, source);
  if (typeof literal !== "object" || literal === null || Array.isArray(literal)) {
    throw notLiteral(source, value, "must be an object");
  }
  return { config: literal as DoctorSerializableConfig };
}

function isCommonJsExport(node: Node): boolean {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "module" &&
    propertyName(node.property, node.computed) === "exports"
  );
}

function exportedValue(
  body: Node[],
  commonJsExports: AssignmentExpression[],
  commonJsReferences: number,
): Node | undefined {
  for (const statement of body) {
    if (statement.type === "ExportDefaultDeclaration") return statement.declaration;
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue;
    const specifier = statement.specifiers.find(
      (item) => propertyName(item.exported) === "default",
    );
    if (specifier?.local.type === "Identifier") return specifier.local;
  }
  const [assignment] = commonJsExports;
  return commonJsReferences === 1 &&
    assignment?.operator === "=" &&
    body.some((node) => node.type === "ExpressionStatement" && node.expression === assignment)
    ? assignment.right
    : undefined;
}

function configObject(
  exported: Node,
  body: Node[],
  helpers: ReadonlySet<string>,
  identifiers: ReadonlyMap<string, number[]>,
): { object: ObjectExpression; params: readonly Node[] } | undefined {
  let node = unwrap(exported);
  if (node.type === "Identifier") {
    const name = node.name;
    if (identifiers.get(name)?.length !== 2) return undefined;
    const declaration = body
      .flatMap((statement) =>
        statement.type === "VariableDeclaration" && statement.kind === "const"
          ? statement.declarations
          : [],
      )
      .find((item) => item.id.type === "Identifier" && item.id.name === name);
    if (!declaration?.init) return undefined;
    node = unwrap(declaration.init);
  }
  node = unwrap(identityArgument(node, helpers) ?? node);
  let params: readonly Node[] = [];
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  ) {
    if (!node.body || ("generator" in node && node.generator)) return undefined;
    params = node.params;
    if (node.body.type === "BlockStatement") {
      const [returned] = node.body.body;
      if (node.body.body.length !== 1 || returned?.type !== "ReturnStatement" || !returned.argument)
        return undefined;
      node = unwrap(returned.argument);
    } else {
      node = unwrap(node.body);
    }
  }
  return node.type === "ObjectExpression" ? { object: node, params } : undefined;
}

function identityArgument(node: Node, helpers: ReadonlySet<string>): Node | undefined {
  if (
    node.type !== "CallExpression" ||
    node.optional ||
    node.callee.type !== "Identifier" ||
    !helpers.has(node.callee.name) ||
    node.arguments.length !== 1
  ) {
    return undefined;
  }
  return node.arguments[0];
}

function unwrap(node: Node): Node {
  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    node = node.expression as Node;
  }
  return node;
}

function propertyName(key: Node, computed = false): string | undefined {
  if (!computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number"))
    return String(key.value);
  if (key.type === "TemplateLiteral" && !key.expressions.length)
    return key.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function toLiteral(node: Node, source: string): unknown {
  node = unwrap(node);
  switch (node.type) {
    case "Literal":
      if ("regex" in node || "bigint" in node) break;
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length) break;
      return node.quasis.map((quasi) => quasi.value.cooked).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "Literal") {
        const value = node.argument.value;
        if (typeof value === "number") return -value;
      }
      break;
    case "ArrayExpression":
      return node.elements.map((element) => {
        if (!element || element.type === "SpreadElement")
          throw notLiteral(source, element ?? node, "must not contain holes or spreads");
        return toLiteral(element as Node, source);
      });
    case "ObjectExpression": {
      const entries: [string, unknown][] = [];
      for (const property of node.properties) {
        const name =
          property.type === "Property" &&
          !property.computed &&
          !property.method &&
          !property.shorthand &&
          property.kind === "init"
            ? propertyName(property.key as Node)
            : undefined;
        if (property.type !== "Property" || name === undefined)
          throw notLiteral(source, property as Node, "must use plain keys, without spreads");
        if (name === "__proto__")
          throw notLiteral(source, property, "must not set an object prototype");
        entries.push([name, toLiteral(property.value as Node, source)]);
      }
      return Object.fromEntries(entries);
    }
  }
  throw notLiteral(source, node, "must be a literal");
}

function notLiteral(source: string, node: Node, reason: string): ViteConfigDoctorError {
  const { line, column } = lineColumnAt(source, node.start);
  return new ViteConfigDoctorError(
    `The doctor key ${reason} (line ${line}, column ${column}). Doctor reads vite.config without running it, so the doctor value can only hold strings, numbers, booleans, null, arrays, and objects. Pass Doctor Extensions and computed values to the doctor() plugin, or to doctor.config.ts with --config.`,
  );
}
