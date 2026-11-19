import { readFileSync } from "node:fs";
import { Visitor, type Node, type ObjectExpression, type Program } from "oxc-parser";
import type { DoctorSerializableConfig } from "../primitives.js";
import { loadTypeScript } from "./lazy-parsers.js";
import { lineColumnAt } from "./line-index.js";
import { parseScriptSync } from "./script.js";
import { analyzeScriptProgram, type ScopeReference } from "./script-scope.js";

export class ViteConfigDoctorError extends Error {}

/**
 * Returns undefined when a supported export shape has no `doctor` key, or when the file never
 * names a `doctor` key or `defineDoctorConfig` and its top-level config has no unresolved computed
 * key. Otherwise an indeterminate export or a nonliteral setting is a config error.
 */
export function readViteConfigDoctor(
  file: string,
): { config: DoctorSerializableConfig } | undefined {
  const source = readFileSync(file, "utf8");
  const { program, errors } = parseScriptSync(file, source, {
    astType: "ts",
    range: true,
    preserveParens: false,
  });
  const error = errors.find((item) => item.severity === "Error");
  if (error) {
    if (!malformedConfigNamesDoctorKey(file, source)) return undefined;
    throw indeterminate(source, error.labels[0]?.start ?? 0, "could not parse the file");
  }
  // Config that never names the key can only supply it through a computed key, so other export
  // shapes it can't read don't matter.
  const named = namesDoctorKey(program);
  const references = new Map<unknown, ScopeReference>();
  const sourceType = program.sourceType === "module" ? "module" : "script";
  for (const scope of analyzeScriptProgram(program, sourceType).scopes) {
    for (const reference of scope.references) references.set(reference.identifier, reference);
  }
  const binding = (node: Node) => references.get(node)?.resolved;
  const viteHelpers = new Set<unknown>();
  const doctorHelpers = new Set<unknown>();
  const body: Node[] = program.body;
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
      const imported = propertyName(specifier.imported);
      const module = statement.source.value;
      if (imported === "defineConfig" && viteConfigModules.has(module)) {
        viteHelpers.add(specifier);
      }
      if (
        imported === "defineDoctorConfig" &&
        (module === "vite-doctor" || module === "vite-doctor/config")
      ) {
        doctorHelpers.add(specifier);
      }
    }
  }

  const exported = defaultExport(body) ?? commonJsExport(program, references);
  const helperArgument = (node: Node, helpers: ReadonlySet<unknown>) => {
    if (
      node.type !== "CallExpression" ||
      node.optional ||
      node.callee.type !== "Identifier" ||
      node.arguments.length !== 1
    )
      return undefined;
    const [definition, extra] = binding(node.callee)?.defs ?? [];
    return definition && !extra && helpers.has(definition.node) ? node.arguments[0] : undefined;
  };
  const configRoot =
    exported &&
    resolveConfigRoot(exported, body, references, (node) => helperArgument(node, viteHelpers));
  const config = configRoot && configObject(configRoot);
  if (!config) {
    if (named)
      throw indeterminate(
        source,
        exported?.start ?? 0,
        "the export is not a supported static form",
      );
    return undefined;
  }

  const property = config.properties.findLast((item) => {
    const name = item.type === "Property" ? propertyName(item.key, item.computed) : undefined;
    if (
      name === undefined ||
      (name === "__proto__" && item.type === "Property" && !item.computed)
    ) {
      if (!named && !(item.type === "Property" && name === undefined)) return false;
      throw indeterminate(
        source,
        item.start,
        "a spread, computed key, or custom prototype may supply it",
      );
    }
    return name === "doctor";
  });
  if (!property || property.type !== "Property") return undefined;
  if (property.kind !== "init" || property.method || property.shorthand) {
    throw notLiteral(source, property, "must be a plain property with a literal value");
  }
  let value: Node = unwrap(property.value as Node);
  const argument = helperArgument(value, doctorHelpers);
  if (argument) value = unwrap(argument);
  const literal = toLiteral(value, source);
  if (typeof literal !== "object" || literal === null || Array.isArray(literal)) {
    throw notLiteral(source, value, "must be an object");
  }
  return { config: literal as DoctorSerializableConfig };
}

const viteConfigModules = new Set(["vite", "vite-plus", "vitest/config"]);

// Importing vite-doctor or the doctor() plugin cannot add a `doctor` key, and neither can a
// "doctor" string value. A key, a member write, or defineDoctorConfig() can.
function namesDoctorKey(program: Program): boolean {
  let found = false;
  const checkKey = (key: Node, computed: boolean) => {
    found ||= propertyName(key, computed) === "doctor";
  };
  new Visitor({
    Property: (node) => checkKey(node.key, node.computed),
    PropertyDefinition: (node) => checkKey(node.key, node.computed),
    MethodDefinition: (node) => checkKey(node.key, node.computed),
    MemberExpression: (node) => checkKey(node.property, node.computed),
    Identifier: (node) => {
      found ||= node.name === "defineDoctorConfig";
    },
  }).visit(program);
  return found;
}

function malformedConfigNamesDoctorKey(file: string, source: string): boolean {
  const ts = loadTypeScript();
  const program = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const name = (
    node: import("typescript").Node | undefined,
    computed = false,
  ): string | undefined => {
    if (!node) return undefined;
    if (ts.isComputedPropertyName(node)) return name(node.expression, true);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return name(node.expression, computed);
    if (ts.isStringLiteralLike(node) || (!computed && ts.isIdentifier(node))) return node.text;
    return undefined;
  };
  const visit = (node: import("typescript").Node): true | undefined => {
    const key = ts.isBindingElement(node)
      ? ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken
        ? (node.propertyName ?? node.name)
        : undefined
      : ts.isObjectLiteralElementLike(node) ||
          ts.isClassElement(node) ||
          ts.isPropertyAccessExpression(node)
        ? node.name
        : undefined;
    if (
      name(key) === "doctor" ||
      (ts.isElementAccessExpression(node) && name(node.argumentExpression, true) === "doctor") ||
      (ts.isIdentifier(node) && node.text === "defineDoctorConfig")
    )
      return true;
    return ts.forEachChild(node, visit);
  };
  return visit(program) === true;
}

const commonJsMetadata = new Set(["filename", "id", "loaded", "path"]);

function commonJsExport(
  program: Program,
  references: ReadonlyMap<unknown, ScopeReference>,
): Node | undefined {
  const modules = new Set<unknown>(
    [...references.values()]
      .filter(
        (reference) =>
          reference.isValueReference &&
          !reference.resolved &&
          reference.identifier.name === "module",
      )
      .map((reference) => reference.identifier),
  );
  if (modules.size > 1) {
    const mutations = new Set<Node>();
    const markMutation = (target: Node) => {
      target = unwrap(target);
      switch (target.type) {
        case "MemberExpression":
          mutations.add(target);
          break;
        case "ChainExpression":
          markMutation(target.expression);
          break;
        case "ArrayPattern":
          for (const item of target.elements) if (item) markMutation(item);
          break;
        case "ObjectPattern":
          for (const item of target.properties) {
            markMutation(item.type === "Property" ? item.value : item);
          }
          break;
        case "AssignmentPattern":
          markMutation(target.left);
          break;
        case "RestElement":
          markMutation(target.argument);
          break;
      }
    };
    new Visitor({
      AssignmentExpression: (node) => markMutation(node.left),
      UpdateExpression: (node) => markMutation(node.argument),
      UnaryExpression: (node) => {
        if (node.operator === "delete") markMutation(node.argument);
      },
      ForInStatement: (node) => markMutation(node.left),
      ForOfStatement: (node) => markMutation(node.left),
      MemberExpression: (node) => {
        if (!modules.has(node.object) || mutations.has(node)) return;
        const key = propertyName(node.property, node.computed);
        if (key !== undefined && commonJsMetadata.has(key)) modules.delete(node.object);
      },
    }).visit(program);
  }
  if (modules.size !== 1) return undefined;
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement") continue;
    const assignment = statement.expression;
    if (assignment.type !== "AssignmentExpression" || assignment.operator !== "=") continue;
    const left = assignment.left;
    if (
      left.type === "MemberExpression" &&
      modules.has(left.object) &&
      propertyName(left.property, left.computed) === "exports"
    )
      return assignment.right;
  }
}

function defaultExport(body: Node[]): Node | undefined {
  for (const statement of body) {
    if (statement.type === "ExportDefaultDeclaration") return statement.declaration;
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue;
    const specifier = statement.specifiers.find(
      (item) => propertyName(item.exported) === "default",
    );
    if (specifier?.local.type === "Identifier") return specifier.local;
  }
}

function topLevelConstValue(
  identifier: Node,
  body: Node[],
  references: ReadonlyMap<unknown, ScopeReference>,
): Node | undefined {
  const target = references.get(identifier)?.resolved;
  const [definition, extra] = target?.defs ?? [];
  if (
    !target ||
    !definition ||
    extra ||
    definition.type !== "Variable" ||
    definition.parent.kind !== "const" ||
    target.references.some(
      (reference) =>
        reference.isValueReference &&
        !reference.init &&
        reference.identifier !== (identifier as unknown),
    )
  )
    return undefined;
  const declaration = body.find((statement) => statement === (definition.parent as unknown));
  if (declaration?.type !== "VariableDeclaration") return undefined;
  const declarator = declaration.declarations.find((item) => item === (definition.node as unknown));
  if (declarator?.id.type !== "Identifier" || !declarator.init) return undefined;
  return unwrap(declarator.init);
}

function resolveConfigRoot(
  exported: Node,
  body: Node[],
  references: ReadonlyMap<unknown, ScopeReference>,
  helperArgument: (node: Node) => Node | undefined,
): Node | undefined {
  const resolveConst = (node: Node) =>
    node.type === "Identifier" ? topLevelConstValue(node, body, references) : node;
  const node = resolveConst(unwrap(exported));
  return node && resolveConst(unwrap(helperArgument(node) ?? node));
}

function isConfigFunction(
  node: Node,
): node is Extract<
  Node,
  { type: "ArrowFunctionExpression" | "FunctionExpression" | "FunctionDeclaration" }
> {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

function configObject(node: Node): ObjectExpression | undefined {
  if (isConfigFunction(node)) {
    if (!node.body || ("generator" in node && node.generator)) return undefined;
    if (node.body.type === "BlockStatement") {
      const returned = node.body.body.at(-1);
      if (
        returned?.type !== "ReturnStatement" ||
        !returned.argument ||
        !node.body.body
          .slice(0, -1)
          .every(
            (statement) =>
              statement.type === "VariableDeclaration" || statement.type === "ExpressionStatement",
          )
      )
        return undefined;
      node = unwrap(returned.argument);
    } else {
      node = unwrap(node.body);
    }
  }
  return node.type === "ObjectExpression" ? node : undefined;
}

function unwrap(node: Node): Node {
  while (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    node = node.expression as Node;
  }
  return node;
}

function propertyName(key: Node, computed = false): string | undefined {
  if (computed) key = unwrap(key);
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

function indeterminate(source: string, start: number, reason: string): ViteConfigDoctorError {
  const { line, column } = lineColumnAt(source, start);
  return new ViteConfigDoctorError(
    `Cannot determine whether vite.config provides a doctor key: ${reason} (line ${line}, column ${column}). Use a supported static export or select your Doctor config explicitly with --config <file>.`,
  );
}
