import { readFileSync } from "node:fs";
import type { Node, ObjectExpression } from "oxc-parser";
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
  if (!/\bdoctor\b/.test(source)) return undefined;
  const { program, errors } = parseScriptSync(file, source, { sourceType: "module" });
  if (errors.some((error) => error.severity === "Error")) return undefined;
  const config = exportedConfigObject(program.body as Node[]);
  if (!config) return undefined;
  const property = config.properties.find(
    (item) => item.type === "Property" && !item.computed && propertyName(item.key) === "doctor",
  );
  if (!property || property.type !== "Property") return undefined;
  let value: Node = unwrap(property.value as Node);
  if (
    value.type === "CallExpression" &&
    value.callee.type === "Identifier" &&
    value.callee.name === "defineDoctorConfig" &&
    value.arguments.length === 1
  ) {
    value = unwrap(value.arguments[0] as Node);
  }
  const literal = toLiteral(value, source);
  if (typeof literal !== "object" || literal === null || Array.isArray(literal)) {
    throw notLiteral(source, value, "must be an object");
  }
  return { config: literal as DoctorSerializableConfig };
}

function exportedConfigObject(body: Node[]): ObjectExpression | undefined {
  const exported = body.find((node) => node.type === "ExportDefaultDeclaration");
  if (!exported || exported.type !== "ExportDefaultDeclaration") return undefined;
  return configObject(exported.declaration as Node, body);
}

function configObject(node: Node, body: Node[]): ObjectExpression | undefined {
  node = unwrap(node);
  if (node.type === "ObjectExpression") return node;
  if (node.type === "CallExpression" && node.arguments.length >= 1)
    return configObject(node.arguments[0] as Node, body);
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    if (node.body?.type !== "BlockStatement") return configObject(node.body as Node, body);
    const returned = node.body.body.find((statement) => statement.type === "ReturnStatement");
    return returned?.type === "ReturnStatement" && returned.argument
      ? configObject(returned.argument as Node, body)
      : undefined;
  }
  if (node.type === "Identifier") {
    for (const statement of body) {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && declarator.id.name === node.name)
          return declarator.init ? configObject(declarator.init as Node, body) : undefined;
      }
    }
  }
  return undefined;
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

function propertyName(key: Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
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
      const object: Record<string, unknown> = {};
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
        object[name] = toLiteral(property.value as Node, source);
      }
      return object;
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
