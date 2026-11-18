import { readFileSync } from "node:fs";
import { Visitor, type AssignmentExpression, type Node, type ObjectExpression } from "oxc-parser";
import type { DoctorSerializableConfig } from "../primitives.js";
import { lineColumnAt } from "./line-index.js";
import { parseScriptSync } from "./script.js";
import { analyzeScriptProgram, type ScopeReference, type ScopeVariable } from "./script-scope.js";

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
  const { program, errors } = parseScriptSync(file, source, {
    astType: "ts",
    range: true,
    preserveParens: false,
  });
  const invalid = errors.some((error) => error.severity === "Error");
  const references = new Map<unknown, ScopeReference>();
  if (!invalid) {
    const sourceType = program.sourceType === "module" ? "module" : "script";
    for (const scope of analyzeScriptProgram(program, sourceType).scopes) {
      for (const reference of scope.references) references.set(reference.identifier, reference);
    }
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
      if (imported === "defineConfig" && (module === "vite" || module === "vite-plus")) {
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

  const commonJsExports: AssignmentExpression[] = [];
  let commonJsReferences = 0;
  let commonJsDoctor: Node | undefined;
  const memberWrites = new Map<ScopeVariable, Node>();
  const bindingWrites = new Map<ScopeVariable, Node[]>();
  const addBindingWrite = (identifier: Node, value: Node) => {
    const target = binding(identifier);
    if (!target) return;
    const writes = bindingWrites.get(target);
    if (writes) writes.push(value);
    else bindingWrites.set(target, [value]);
  };
  const returns = new Map<Node, Node[]>();
  const functions: Node[] = [];
  const enterFunction = (node: Node) => functions.push(node);
  const leaveFunction = () => functions.pop();
  const commonJsExport = (node: Node): boolean => isCommonJsExport(node) && !binding(node.object);
  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": leaveFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": leaveFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": leaveFunction,
    ReturnStatement(node) {
      const owner = functions.at(-1);
      if (!owner || !node.argument) return;
      const values = returns.get(owner);
      if (values) values.push(node.argument);
      else returns.set(owner, [node.argument]);
    },
    MemberExpression(node) {
      if (commonJsExport(node)) commonJsReferences++;
    },
    AssignmentPattern(node) {
      if (node.left.type === "Identifier") addBindingWrite(node.left, node.right);
    },
    AssignmentExpression(node) {
      const left = node.left;
      if (left.type === "Identifier") addBindingWrite(left, node.right);
      if (left.type !== "MemberExpression") return;
      if (commonJsExport(left)) commonJsExports.push(node);
      if (propertyName(left.property, left.computed) !== "doctor") return;
      if (commonJsExport(left.object)) commonJsDoctor ??= left;
      if (left.object.type !== "Identifier") return;
      const target = binding(left.object);
      if (target && !memberWrites.has(target)) memberWrites.set(target, left);
    },
  }).visit(program);

  const esmExport = defaultExport(body);
  const [assignment] = commonJsExports;
  const exported =
    esmExport ??
    (commonJsReferences === 1 &&
    assignment?.operator === "=" &&
    body.some((node) => node.type === "ExpressionStatement" && node.expression === assignment)
      ? assignment.right
      : undefined);
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
  const seen = new Set<Node>();
  function findDoctorEvidence(value: Node): Node | undefined {
    const node = unwrap(value);
    if (seen.has(node)) return undefined;
    seen.add(node);
    switch (node.type) {
      case "ObjectExpression":
        for (const property of node.properties) {
          const evidence =
            property.type === "SpreadElement"
              ? findDoctorEvidence(property.argument)
              : propertyName(property.key, property.computed) === "doctor"
                ? property
                : undefined;
          if (evidence) return evidence;
        }
        return undefined;
      case "Identifier": {
        const target = binding(node);
        if (!target) return undefined;
        const write = memberWrites.get(target);
        if (write) return write;
        for (const definition of target.defs) {
          const value =
            definition.type === "FunctionName"
              ? definition.node
              : definition.type === "Variable" && definition.node.id.type === "Identifier"
                ? definition.node.init
                : undefined;
          if (value) {
            const evidence = findDoctorEvidence(value as unknown as Node);
            if (evidence) return evidence;
          }
        }
        return firstEvidence(bindingWrites.get(target) ?? []);
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression":
      case "FunctionDeclaration":
        return node.body && node.body.type !== "BlockStatement"
          ? findDoctorEvidence(node.body)
          : firstEvidence(returns.get(node) ?? []);
      case "CallExpression":
        return firstEvidence(node.arguments);
      case "SpreadElement":
        return findDoctorEvidence(node.argument);
      case "ConditionalExpression":
        return findDoctorEvidence(node.consequent) ?? findDoctorEvidence(node.alternate);
      case "LogicalExpression":
        return findDoctorEvidence(node.left) ?? findDoctorEvidence(node.right);
      case "SequenceExpression": {
        const last = node.expressions.at(-1);
        return last && findDoctorEvidence(last);
      }
      case "AssignmentExpression":
        return findDoctorEvidence(node.right);
      default:
        return undefined;
    }
  }
  function firstEvidence(values: readonly Node[]): Node | undefined {
    for (const value of values) {
      const evidence = findDoctorEvidence(value);
      if (evidence) return evidence;
    }
    return undefined;
  }
  const config =
    exported && !invalid
      ? configObject(exported, body, references, (node) => helperArgument(node, viteHelpers))
      : undefined;
  if (!config) {
    const visibleDoctorKey = esmExport
      ? findDoctorEvidence(esmExport)
      : (commonJsDoctor ?? firstEvidence(commonJsExports.map((item) => item.right)));
    if (visibleDoctorKey)
      throw notLiteral(
        source,
        visibleDoctorKey,
        "must be in a supported static Vite config export",
      );
    return undefined;
  }
  let ambiguousProperty: Node | undefined;
  const property = config.properties.findLast((item) => {
    const name = item.type === "Property" ? propertyName(item.key, item.computed) : undefined;
    if (name === undefined) ambiguousProperty ??= item;
    return name === "doctor";
  });
  if (ambiguousProperty && (property || findDoctorEvidence(config))) {
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
  const argument = helperArgument(value, doctorHelpers);
  if (argument) value = unwrap(argument);
  const literal = toLiteral(value, source);
  if (typeof literal !== "object" || literal === null || Array.isArray(literal)) {
    throw notLiteral(source, value, "must be an object");
  }
  return { config: literal as DoctorSerializableConfig };
}

function isCommonJsExport(node: Node): node is Extract<Node, { type: "MemberExpression" }> {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "module" &&
    propertyName(node.property, node.computed) === "exports"
  );
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

function configObject(
  exported: Node,
  body: Node[],
  references: ReadonlyMap<unknown, ScopeReference>,
  helperArgument: (node: Node) => Node | undefined,
): ObjectExpression | undefined {
  let node = unwrap(exported);
  if (node.type === "Identifier") {
    const target = references.get(node)?.resolved;
    const [definition, extra] = target?.defs ?? [];
    if (
      !target ||
      !definition ||
      extra ||
      definition.type !== "Variable" ||
      definition.parent.kind !== "const" ||
      !body.some((statement) => statement === (definition.parent as unknown)) ||
      definition.node.id.type !== "Identifier" ||
      !definition.node.init ||
      target.references.some(
        (reference) =>
          reference.isValueReference &&
          !reference.init &&
          reference.identifier !== (node as unknown),
      )
    )
      return undefined;
    node = unwrap(definition.node.init as unknown as Node);
  }
  node = unwrap(helperArgument(node) ?? node);
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  ) {
    if (!node.body || ("generator" in node && node.generator)) return undefined;
    if (node.body.type === "BlockStatement") {
      const [returned] = node.body.body;
      if (node.body.body.length !== 1 || returned?.type !== "ReturnStatement" || !returned.argument)
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
