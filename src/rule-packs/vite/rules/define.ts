import { parseForESLint } from "@typescript-eslint/parser";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { walkScriptLocal } from "../../../core/rule-authoring.js";
import { diagnostics } from "../../../diagnostics.js";
import {
  isLiteralPrimitive,
  isViteConfigFile,
  readProjectSources,
  readViteConfigFacts,
  SECRET_NAME_RE,
  hasTypeDeclaration,
  propertyName,
  memberPath,
  type AnyNode,
} from "./shared.js";

export const noUnusedDefine = createRule({
  meta: {
    id: "vite/define/no-unused-define",
    title: "Remove unused Vite define constants",
    category: "configuration",
    severity: "info",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        const configs = await readViteConfigFacts(ctx);
        const sources = await readProjectSources(ctx);
        for (const config of configs) {
          for (const entry of config.define) {
            const used = sources.some(
              (source) => source.file !== config.file && source.text.includes(entry.key),
            );
            if (used) continue;
            ctx.report(
              diagnostics.VITE0007({
                why: `Vite define constant "${entry.key}" is configured but never referenced.`,
                fix: "Remove the stale define entry or use it from source code.",
              }),
              {
                ruleId: "vite/define/no-unused-define",
                severity: ctx.severity,
                category: "configuration",
                file: config.file,
                range: entry.range,
              },
            );
          }
        }
      },
    };
  },
});

export const noUntypedDefine = createRule({
  meta: {
    id: "vite/define/no-untyped-define",
    title: "Type custom Vite define globals",
    category: "types",
    severity: "warn",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        for (const config of await readViteConfigFacts(ctx)) {
          for (const entry of config.define) {
            if (entry.key.includes(".") || hasTypeDeclaration(ctx, entry.key)) continue;
            ctx.report(
              diagnostics.VITE0006({
                why: `Vite define global "${entry.key}" is not declared in a project .d.ts file.`,
                fix: `Add declare const ${entry.key}: <type> to vite-env.d.ts or env.d.ts.`,
              }),
              {
                ruleId: "vite/define/no-untyped-define",
                severity: ctx.severity,
                category: "types",
                file: config.file,
                range: entry.range,
              },
            );
          }
        }
      },
    };
  },
});

export const noRuntimeObjectDefine = createRule({
  meta: {
    id: "vite/define/no-runtime-object-define",
    title: "Avoid object values in Vite define",
    category: "configuration",
    severity: "warn",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node) {
        if ((node as { type?: string }).type !== "Program") return;
        for (const entry of readDefineEntriesFromCurrentFile(ctx, node)) {
          if (isLiteralPrimitive(entry.rawValue) || entry.rawValue.startsWith("JSON.stringify("))
            continue;
          ctx.report(
            diagnostics.VITE0004({
              why: `Vite define "${entry.key}" uses a non-primitive replacement value.`,
              fix: "Use stringified primitive define values, or import runtime configuration explicitly.",
            }),
            {
              ruleId: "vite/define/no-runtime-object-define",
              severity: ctx.severity,
              category: "configuration",
              file: ctx.file.path,
              range: entry.range,
            },
          );
        }
      },
    };
  },
});

export const noSecretDefine = createRule({
  meta: {
    id: "vite/define/no-secret-define",
    title: "Do not expose secrets through Vite define",
    category: "security",
    severity: "error",
    docsUrl: "https://vite.dev/config/shared-options.html#define",
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node) {
        if ((node as { type?: string }).type !== "Program") return;
        const { initializers, memberReturns } = readAliasInitializers(ctx.file.text);
        for (const entry of readDefineEntriesFromCurrentFile(ctx, node)) {
          if (
            !SECRET_NAME_RE.test(entry.key) &&
            !resolvesSecretAlias(
              entry.rawValue,
              entry.valueStart,
              ctx.file.text,
              initializers,
              memberReturns,
            )
          )
            continue;
          ctx.report(
            diagnostics.VITE0005({
              why: `Vite define "${entry.key}" looks like a secret and will be bundled into client code.`,
              fix: "Keep secrets on the server and expose only deliberate public values.",
            }),
            {
              ruleId: "vite/define/no-secret-define",
              severity: ctx.severity,
              category: "security",
              file: ctx.file.path,
              range: entry.range,
            },
          );
        }
      },
    };
  },
});

function readAliasInitializers(source: string) {
  const initializers = new Map<number, [number, number][]>();
  const memberReturns = new Map<
    number,
    { ranges: [number, number][]; async: boolean; generator: boolean }
  >();
  let parsed: ReturnType<typeof parseForESLint>;
  try {
    parsed = parseForESLint(source, { range: true, sourceType: "module" });
  } catch {
    return { initializers, memberReturns };
  }
  const { scopeManager } = parsed;
  for (const scope of scopeManager.scopes) {
    for (const reference of scope.references) {
      const definition = reference.resolved?.defs[0];
      if (
        reference.resolved?.defs.length === 1 &&
        definition?.type === "FunctionName" &&
        definition.node.type === "FunctionDeclaration" &&
        !reference.resolved.references.some((item) => item.isWrite())
      ) {
        initializers.set(reference.identifier.range[0], [definition.node.range]);
        continue;
      }
      if (
        reference.resolved?.defs.length !== 1 ||
        definition?.type !== "Variable" ||
        definition.parent.kind !== "const" ||
        !definition.node.init
      )
        continue;
      const { id, init } = definition.node;
      if (id.type === "Identifier") {
        initializers.set(reference.identifier.range[0], [init.range]);
      } else if (
        id.type === "ObjectPattern" &&
        init.type === "MemberExpression" &&
        !init.computed &&
        init.property.type === "Identifier" &&
        init.property.name === "env" &&
        ((init.object.type === "Identifier" && init.object.name === "process") ||
          (init.object.type === "MetaProperty" &&
            init.object.meta.name === "import" &&
            init.object.property.name === "meta"))
      ) {
        const property = id.properties.find((property) => {
          if (property.type !== "Property") return false;
          const binding =
            property.value.type === "AssignmentPattern" ? property.value.left : property.value;
          return binding.type === "Identifier" && binding.name === reference.identifier.name;
        });
        if (
          property?.type === "Property" &&
          ((!property.computed && property.key.type === "Identifier") ||
            (property.key.type === "Literal" && typeof property.key.value === "string"))
        ) {
          const ranges = [property.key.range];
          if (property.value.type === "AssignmentPattern") {
            ranges.push(property.value.right.range);
          }
          initializers.set(reference.identifier.range[0], ranges);
        }
      }
    }
  }
  const nodesByRange = new Map<string, AnyNode>();
  const members: AnyNode[] = [];
  function collect(node: AnyNode) {
    if (!node) return;
    nodesByRange.set(node.range.join(":"), node);
    if (node.type === "MemberExpression") members.push(node);
    for (const key of parsed.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(collect);
      else if (child) collect(child);
    }
  }
  collect(parsed.ast);
  function resolve(node: AnyNode, seen = new Set<AnyNode>()): AnyNode {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "Identifier") {
      const ranges = initializers.get(node.range[0]);
      if (ranges?.length === 1) return resolve(nodesByRange.get(ranges[0]!.join(":")), seen);
    }
    if (node.type === "MemberExpression") {
      const object = resolve(node.object, seen);
      const key = node.computed ? resolve(node.property, seen) : node.property;
      const name = key?.type === "Literal" ? String(key.value) : !node.computed ? key?.name : null;
      if (object?.type === "ObjectExpression" && name !== null) {
        const property = readProperties(object, new Set(seen)).findLast(
          (property: AnyNode) =>
            property.type === "Property" &&
            (property.computed
              ? resolve(property.key, new Set(seen))?.value
              : propertyName(property.key)) === name,
        );
        if (property) return resolve(property.value, seen);
      }
    }
    return node;
  }
  function readProperties(object: AnyNode, seen: Set<AnyNode>): AnyNode[] {
    return object.properties.flatMap((property: AnyNode) => {
      if (property.type !== "SpreadElement") return [property];
      const spread = resolve(property.argument, new Set(seen));
      if (spread?.type !== "ObjectExpression" || seen.has(spread)) return [];
      return readProperties(spread, new Set([...seen, spread]));
    });
  }
  for (const member of members) {
    const value = resolve(member);
    if (
      !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
        value?.type,
      )
    )
      continue;
    const ranges: [number, number][] = [];
    if (value.body.type === "BlockStatement")
      visitReturnValues(value.body, (node) => ranges.push(node.range));
    else ranges.push(value.body.range);
    memberReturns.set(member.range[0], { ranges, async: value.async, generator: value.generator });
  }
  return { initializers, memberReturns };
}

function resolvesSecretAlias(
  value: string,
  start: number,
  source: string,
  initializers: Map<number, [number, number][]>,
  memberReturns: Map<number, { ranges: [number, number][]; async: boolean; generator: boolean }>,
): boolean {
  const pending = [{ value, start, invoked: false, awaited: false }];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    let parsed: ReturnType<typeof parseForESLint>;
    try {
      parsed = parseForESLint(`(${current.value})`, { range: true });
    } catch {
      if (SECRET_NAME_RE.test(current.value)) return true;
      continue;
    }
    const identifiers = new Set<number>();
    const invokedNodes = new Set<unknown>();
    const awaitedNodes = new Set<unknown>();
    const awaitedReferences = new Set<number>();
    const invokedReferences = new Set<number>();
    if (current.invoked) {
      const statement = parsed.ast.body[0];
      if (statement?.type === "ExpressionStatement") {
        invokedNodes.add(statement.expression);
        if (current.awaited) awaitedNodes.add(statement.expression);
      }
    }
    const nodes: unknown[] = [parsed.ast];
    while (nodes.length) {
      const node = nodes.pop() as { type: string; range: [number, number]; [key: string]: unknown };
      if (node.type.startsWith("TS")) {
        if (node.expression) {
          if (invokedNodes.has(node)) invokedNodes.add(node.expression);
          if (awaitedNodes.has(node)) awaitedNodes.add(node.expression);
          nodes.push(node.expression);
        }
        continue;
      }
      if (
        (node.type === "UnaryExpression" &&
          ["typeof", "void", "!", "delete"].includes(node.operator as string)) ||
        (node.type === "BinaryExpression" &&
          ["==", "!=", "===", "!==", "<", ">", "<=", ">=", "in", "instanceof"].includes(
            node.operator as string,
          ))
      )
        continue;
      if (
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      ) {
        if (invokedNodes.has(node) && !node.generator && (!node.async || awaitedNodes.has(node))) {
          const body = node.body as AnyNode;
          if (body.type !== "BlockStatement") nodes.push(body);
          else visitReturnValues(body, (value) => nodes.push(value));
        }
        continue;
      }
      if (node.type === "AwaitExpression") awaitedNodes.add(node.argument);
      if (node.type === "CallExpression") {
        invokedNodes.add(node.callee);
        if (awaitedNodes.has(node)) awaitedNodes.add(node.callee);
      }
      if (node.type === "MemberExpression") {
        const member = memberReturns.get(current.start + node.range[0] - 1);
        if (invokedNodes.has(node) && member) {
          if (member.generator || (member.async && !awaitedNodes.has(node))) continue;
          for (const range of member.ranges) {
            const identity = `${range[0]}:return`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            pending.push({
              value: source.slice(...range),
              start: range[0],
              invoked: false,
              awaited: false,
            });
          }
          continue;
        }
        const property = node.property as AnyNode;
        if (
          (!node.computed && property.name === "length") ||
          (node.computed && property.value === "length")
        )
          continue;
      }
      if (node.type === "Property") {
        if (node.computed) nodes.push(node.key);
        nodes.push(node.value);
        continue;
      }
      if (
        (node.type === "Identifier" && SECRET_NAME_RE.test(node.name as string)) ||
        (node.type === "TemplateLiteral" &&
          (node.expressions as unknown[]).length === 0 &&
          SECRET_NAME_RE.test((node.quasis as AnyNode[])[0]?.value.cooked ?? "")) ||
        (node.type === "Literal" &&
          typeof node.value === "string" &&
          SECRET_NAME_RE.test(node.value))
      )
        return true;
      if (node.type === "ConditionalExpression") {
        nodes.push(node.consequent, node.alternate);
        continue;
      }
      if (node.type === "SequenceExpression") {
        nodes.push((node.expressions as unknown[]).at(-1));
        continue;
      }
      if (node.type === "Identifier") {
        identifiers.add(node.range[0]);
        if (invokedNodes.has(node)) invokedReferences.add(node.range[0]);
        if (awaitedNodes.has(node)) awaitedReferences.add(node.range[0]);
      }
      for (const key of parsed.visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) nodes.push(...child.filter(Boolean));
        else if (child) nodes.push(child);
      }
    }
    for (const scope of parsed.scopeManager.scopes) {
      for (const reference of scope.references) {
        if (!reference.isValueReference || !identifiers.has(reference.identifier.range[0]))
          continue;
        const ranges = initializers.get(current.start + reference.identifier.range[0] - 1);
        for (const range of ranges ?? []) {
          const invoked = invokedReferences.has(reference.identifier.range[0]);
          const awaited = awaitedReferences.has(reference.identifier.range[0]);
          const identity = `${range[0]}:${invoked}:${awaited}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          const initializer = source.slice(...range);
          pending.push({ value: initializer, start: range[0], invoked, awaited });
        }
      }
    }
  }
  return false;
}

function readDefineEntriesFromCurrentFile(ctx: RuleContext, program: unknown) {
  const text = ctx.file.text;
  const entries: Array<{ key: string; rawValue: string; valueStart: number; range: SourceRange }> =
    [];
  const { initializers } = readAliasInitializers(text);
  const nodesByRange = new Map<string, AnyNode>();
  walkScriptLocal(program, (node) => {
    nodesByRange.set(`${node.start}:${node.end}`, node);
  });
  const seen = new Set<AnyNode>();
  function resolve(node: AnyNode): AnyNode {
    const visited = new Set<AnyNode>();
    while (node && !visited.has(node)) {
      visited.add(node);
      if (
        (node.type.startsWith("TS") || node.type === "ParenthesizedExpression") &&
        node.expression
      )
        node = node.expression;
      else if (node.type === "Identifier") {
        const ranges = initializers.get(node.start);
        if (ranges?.length !== 1) break;
        node = nodesByRange.get(ranges[0]!.join(":"));
      } else break;
    }
    return node;
  }
  function keyOf(property: AnyNode): string | null {
    if (!property.computed) return propertyName(property.key);
    const key = resolve(property.key);
    return key?.type === "Literal" ? propertyName(key) : null;
  }
  function readOptions(input: AnyNode, visited = new Set<AnyNode>()): AnyNode[] {
    const node = resolve(input);
    if (node?.type !== "ObjectExpression" || visited.has(node)) return [];
    visited.add(node);
    const options = node.properties.flatMap((option: AnyNode) =>
      option.type === "SpreadElement" ? readOptions(option.argument, visited) : [option],
    );
    visited.delete(node);
    return options;
  }
  function readConfig(input: AnyNode) {
    const node = resolve(input);
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "CallExpression" && node.callee.name === "defineConfig") {
      readConfig(node.arguments[0]);
    } else if (
      ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
    ) {
      if (node.body.type !== "BlockStatement") readConfig(node.body);
      else visitReturnValues(node.body, readConfig);
    } else if (node.type === "ConditionalExpression") {
      readConfig(node.consequent);
      readConfig(node.alternate);
    } else if (node.type === "ObjectExpression") {
      const option = readOptions(node).findLast(
        (option) => option.type === "Property" && keyOf(option) === "define",
      );
      if (option) {
        const values = resolve(option.value);
        if (values?.type !== "ObjectExpression") return;
        const properties = new Map<string, AnyNode>();
        for (const property of readOptions(values)) {
          if (property.type !== "Property") continue;
          const key = keyOf(property);
          if (key !== null) properties.set(key, property);
        }
        for (const [key, property] of properties) {
          const valueStart = property.value.start;
          entries.push({
            key,
            rawValue: text.slice(valueStart, property.value.end),
            valueStart,
            range: ctx.helpers.rangeFromOffsets(
              ctx.file.path,
              text,
              property.key.start,
              property.key.end,
            ),
          });
        }
      }
    }
  }
  for (const statement of (program as AnyNode).body) {
    if (statement.type === "ExportDefaultDeclaration") readConfig(statement.declaration);
    else if (statement.type === "ExportNamedDeclaration" && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (propertyName(specifier.exported) === "default") readConfig(specifier.local);
      }
    } else if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AssignmentExpression" &&
      statement.expression.operator === "=" &&
      memberPath(statement.expression.left) === "module.exports"
    )
      readConfig(statement.expression.right);
  }
  return entries;
}

function visitReturnValues(node: AnyNode, visit: (value: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type))
    return;
  if (node.type === "ReturnStatement") {
    if (node.argument) visit(node.argument);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) value.forEach((child) => visitReturnValues(child, visit));
    else if (value && typeof value === "object") visitReturnValues(value, visit);
  }
}
