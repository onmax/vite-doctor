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
        const {
          initializers,
          memberReturns,
          localCalls,
          shadowedPromises,
          serializationHooks,
          bindingKeys,
        } = readAliasInitializers(ctx.file.text);
        for (const entry of readDefineEntriesFromCurrentFile(ctx, node)) {
          if (
            !SECRET_NAME_RE.test(entry.key) &&
            !resolvesSecretAlias(
              entry.rawValue,
              entry.valueStart,
              ctx.file.text,
              initializers,
              memberReturns,
              localCalls,
              shadowedPromises,
              serializationHooks,
              bindingKeys,
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
  const serializationHooks = new Map<
    number,
    { range: [number, number]; prefix: string; getter?: boolean }
  >();
  const namespaces = new Set<number>();
  const bindingKeys = new Map<number, string>();
  const configHelpers = new Set<number>();
  const mergeHelpers = new Set<number>();
  const shadowedPromises = new Set<number>();
  const localCalls = new Set<number>();
  const memberReturns = new Map<
    number,
    { range: [number, number]; getter: boolean; prefix: string }
  >();
  let parsed: ReturnType<typeof parseForESLint>;
  try {
    parsed = parseForESLint(source, { range: true, sourceType: "module" });
  } catch {
    return {
      initializers,
      bindingKeys,
      serializationHooks,
      memberReturns,
      configHelpers,
      mergeHelpers,
      shadowedPromises,
      localCalls,
    };
  }
  const { scopeManager } = parsed;
  const references = new Map(
    scopeManager.scopes.flatMap((scope) =>
      scope.references.map((reference) => [reference.identifier.range[0], reference] as const),
    ),
  );
  function resolveImmutable(node: AnyNode, seen = new Set<AnyNode>()): AnyNode {
    if (node.type !== "Identifier" || seen.has(node)) return node;
    seen.add(node);
    const reference = references.get(node.range[0]);
    const definition = reference?.resolved?.defs[0];
    if (
      reference?.resolved?.defs.length === 1 &&
      definition?.type === "Variable" &&
      definition.parent.kind === "const" &&
      definition.node.id.type === "Identifier" &&
      definition.node.init
    )
      return resolveImmutable(definition.node.init, seen);
    return node;
  }
  for (const scope of scopeManager.scopes) {
    for (const reference of scope.references) {
      const definition = reference.resolved?.defs[0];
      bindingKeys.set(
        reference.identifier.range[0],
        reference.resolved
          ? `binding:${reference.resolved.identifiers[0]?.range[0]}`
          : `global:${reference.identifier.name}`,
      );
      if (
        definition?.type === "ImportBinding" &&
        definition.parent.type === "ImportDeclaration" &&
        definition.parent.source.value === "vite" &&
        definition.node.type === "ImportNamespaceSpecifier"
      )
        namespaces.add(reference.identifier.range[0]);
      if (reference.identifier.name === "Promise" && definition)
        shadowedPromises.add(reference.identifier.range[0]);
      if (
        definition?.type === "ImportBinding" &&
        definition.parent.type === "ImportDeclaration" &&
        definition.parent.source.value === "vite" &&
        definition.node.type === "ImportSpecifier" &&
        ["defineConfig", "mergeConfig"].includes(propertyName(definition.node.imported) ?? "")
      )
        (propertyName(definition.node.imported) === "mergeConfig"
          ? mergeHelpers
          : configHelpers
        ).add(reference.identifier.range[0]);
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
      const { id } = definition.node;
      const init =
        id.type === "ObjectPattern" ? resolveImmutable(definition.node.init) : definition.node.init;
      if (
        init.type === "CallExpression" &&
        init.callee.type === "Identifier" &&
        init.callee.name === "require" &&
        !references.get(init.callee.range[0])?.resolved &&
        init.arguments.length === 1 &&
        init.arguments[0]?.type === "Literal" &&
        init.arguments[0].value === "vite"
      ) {
        if (id.type === "Identifier") namespaces.add(reference.identifier.range[0]);
        if (id.type === "ObjectPattern") {
          const property = id.properties.find(
            (item) =>
              item.type === "Property" &&
              item.value.type === "Identifier" &&
              item.value.name === reference.identifier.name,
          );
          const name = property?.type === "Property" ? propertyName(property.key) : null;
          if (name === "defineConfig") configHelpers.add(reference.identifier.range[0]);
          if (name === "mergeConfig") mergeHelpers.add(reference.identifier.range[0]);
        }
      }
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
        const key =
          property?.type === "Property"
            ? property.computed
              ? resolveImmutable(property.key)
              : property.key
            : undefined;
        if (
          property?.type === "Property" &&
          key &&
          ((!property.computed && key.type === "Identifier") ||
            (key.type === "Literal" && typeof key.value === "string") ||
            (key.type === "TemplateLiteral" && key.expressions.length === 0))
        ) {
          const ranges = [key.range];
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
  const calls: AnyNode[] = [];
  function collect(node: AnyNode) {
    if (!node) return;
    nodesByRange.set(node.range.join(":"), node);
    if (node.type === "MemberExpression") members.push(node);
    if (node.type === "CallExpression") calls.push(node);
    for (const key of parsed.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(collect);
      else if (child) collect(child);
    }
  }
  collect(parsed.ast);
  const getters = new Set<AnyNode>();
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
        if (property) {
          if (property.kind === "get") getters.add(property.value);
          return resolve(property.value, seen);
        }
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
  for (const object of nodesByRange.values()) {
    if (object.type !== "ObjectExpression") continue;
    const hook = readProperties(object, new Set([object])).findLast(
      (property) =>
        property.type === "Property" &&
        (property.computed ? resolve(property.key)?.value : propertyName(property.key)) ===
          "toJSON",
    );
    const value = hook && ["init", "get"].includes(hook.kind) && resolve(hook.value);
    if (
      !value ||
      !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(value.type)
    )
      continue;
    const prefix =
      value.type === "FunctionExpression" && source[value.range[0]] === "("
        ? `${value.async ? "async " : ""}function${value.generator ? "*" : ""}`
        : "";
    serializationHooks.set(object.range[0], {
      range: value.range,
      prefix,
      getter: hook.kind === "get",
    });
  }
  for (const call of calls) {
    const callee = resolve(call.callee);
    if (
      ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
        callee?.type,
      )
    )
      localCalls.add(call.range[0]);
  }
  for (const member of members) {
    if (namespaces.has(member.object.range[0])) {
      const name = member.computed ? member.property.value : member.property.name;
      if (name === "defineConfig") configHelpers.add(member.range[0]);
      if (name === "mergeConfig") mergeHelpers.add(member.range[0]);
    }
    const value = resolve(member);
    if (
      !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
        value?.type,
      )
    )
      continue;
    // Method ranges omit the function keyword; restore it for expression parsing.
    const prefix =
      value.type === "FunctionExpression" && source[value.range[0]] === "("
        ? `${value.async ? "async " : ""}function${value.generator ? "*" : ""}`
        : "";
    memberReturns.set(member.range[0], { range: value.range, getter: getters.has(value), prefix });
  }
  return {
    initializers,
    bindingKeys,
    serializationHooks,
    memberReturns,
    configHelpers,
    mergeHelpers,
    shadowedPromises,
    localCalls,
  };
}

function resolvesSecretAlias(
  value: string,
  start: number,
  source: string,
  initializers: Map<number, [number, number][]>,
  memberReturns: Map<number, { range: [number, number]; getter: boolean; prefix: string }>,
  localCalls: Set<number>,
  shadowedPromises: Set<number>,
  serializationHooks: Map<number, { range: [number, number]; prefix: string; getter?: boolean }>,
  bindingKeys: Map<number, string>,
): boolean {
  type Range = [number, number];
  type Trace = {
    value: string;
    start: number;
    invoked: boolean;
    serialized?: boolean;
    serializationKey?: string;
    propertyList?: string[];
    replacer?: Range;
    replacerApplied?: boolean;
    awaited: boolean;
    args: Range[];
    following?: Range[][];
    receiver?: Range;
    bindings: Map<number, Range[]>;
  };
  const pending: Trace[] = [
    { value, start, invoked: false, awaited: false, args: [], bindings: new Map() },
  ];
  const seen = new Set<string>();
  const restReferences = new Set<number>();
  const undefinedRange: Range = [source.length, source.length + 9];
  source += "undefined";
  const literals = new Map<string, Range>();
  function literalRange(value: string): Range {
    if (literals.has(value)) return literals.get(value)!;
    const start = source.length;
    source += JSON.stringify(value);
    const range: Range = [start, source.length];
    literals.set(value, range);
    return range;
  }
  function readValue(
    range: Range,
    bindings: Trace["bindings"],
    visited = new Set<string>(),
  ): { node: AnyNode; offset: number } | undefined {
    const identity = range.join(":");
    if (visited.has(identity)) return;
    visited.add(identity);
    const offset = range[0] - 1;
    try {
      const ast = parseForESLint(`(${source.slice(...range)})`, { range: true }).ast;
      let node = (ast.body[0] as AnyNode).expression;
      while (node?.type.startsWith("TS") && node.expression) node = node.expression;
      if (node?.type === "Identifier" || node?.type === "ThisExpression") {
        const ranges =
          bindings.get(offset + node.range[0]) ?? initializers.get(offset + node.range[0]);
        if (ranges?.length === 1) return readValue(ranges[0]!, bindings, visited);
      }
      if (node?.type === "MemberExpression") {
        const object = readValue(
          [offset + node.object.range[0], offset + node.object.range[1]],
          bindings,
          new Set(visited),
        );
        const property = node.computed
          ? readValue(
              [offset + node.property.range[0], offset + node.property.range[1]],
              bindings,
              new Set(visited),
            )?.node
          : node.property;
        const key = node.computed
          ? property?.type === "Literal"
            ? String(property.value)
            : null
          : property?.name;
        if (object && key != null) {
          let selected: AnyNode;
          let selectedOffset = object.offset;
          if (object.node.type === "ObjectExpression") {
            const properties = serializedProperties(object.node, object.offset, bindings);
            const entry = properties.findLast((item) => item.key === key);
            if (!entry && !properties.some((item) => item.key === null))
              return {
                node: { type: "Identifier", name: "undefined", range: [1, 10] },
                offset: undefinedRange[0] - 1,
              };
            if (
              entry &&
              entry.node.kind !== "get" &&
              !properties.some((item) => item.key === null)
            ) {
              selected = entry.node.value;
              selectedOffset = entry.offset;
            }
          } else if (
            object.node.type === "ArrayExpression" &&
            !object.node.elements.some((item: AnyNode) => item?.type === "SpreadElement")
          ) {
            const index = Number(key);
            if (
              Number.isInteger(index) &&
              index >= 0 &&
              index < 2 ** 32 - 1 &&
              String(index) === key
            ) {
              selected = object.node.elements[index];
              if (!selected)
                return {
                  node: { type: "Identifier", name: "undefined", range: [1, 10] },
                  offset: undefinedRange[0] - 1,
                };
            }
          }
          if (selected)
            return readValue(
              [selectedOffset + selected.range[0], selectedOffset + selected.range[1]],
              bindings,
              visited,
            );
        }
      }
      return { node, offset };
    } catch {
      return;
    }
  }
  function serializedProperties(
    node: AnyNode,
    offset: number,
    bindings: Trace["bindings"],
    visited = new Set<number>(),
  ): Array<{ node: AnyNode; offset: number; key: string | null }> {
    const properties = new Map<unknown, { node: AnyNode; offset: number; key: string | null }>();
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        const range: Range = [
          offset + property.argument.range[0],
          offset + property.argument.range[1],
        ];
        if (visited.has(range[0])) continue;
        const value = readValue(range, bindings);
        if (value?.node.type === "ObjectExpression") {
          for (const item of serializedProperties(
            value.node,
            value.offset,
            bindings,
            new Set([...visited, range[0]]),
          ))
            properties.set(item.key ?? item.node, item);
        } else {
          properties.set(property, {
            node: { type: "Property", value: property.argument },
            offset,
            key: null,
          });
        }
      } else {
        const resolved = property.computed
          ? readValue([offset + property.key.range[0], offset + property.key.range[1]], bindings)
              ?.node
          : undefined;
        const key = property.computed
          ? resolved?.type === "Literal"
            ? String(resolved.value)
            : null
          : propertyName(property.key);
        properties.set(key ?? property, { node: property, offset, key });
      }
    }
    return [...properties.values()];
  }
  while (pending.length) {
    const current = pending.pop()!;
    let parsed: ReturnType<typeof parseForESLint>;
    try {
      parsed = parseForESLint(`(${current.value})`, { range: true });
    } catch {
      if (SECRET_NAME_RE.test(current.value)) return true;
      continue;
    }
    const serializedNodes = new Set<unknown>();
    const serializationKeys = new Map<unknown, string>();
    const propertyLists = new Map<unknown, string[]>();
    const replacers = new Map<unknown, Range>();
    const replaced = new Set<unknown>();
    function serialize(from: unknown, to: unknown, key = serializationKeys.get(from) ?? "") {
      if (!serializedNodes.has(from)) return;
      serializedNodes.add(to);
      const replacer = replacers.get(from);
      if (replacer) replacers.set(to, replacer);
      if (replaced.has(from)) replaced.add(to);
      serializationKeys.set(to, key);
      const list = propertyLists.get(from);
      if (list) propertyLists.set(to, list);
    }
    const identifiers = new Set<number>();
    const invokedNodes = new Set<unknown>();
    const awaitedNodes = new Set<unknown>();
    const awaitedReferences = new Set<number>();
    const invokedReferences = new Set<number>();
    const callArguments = new Map<unknown, [number, number][]>();
    const followingCalls = new Map<unknown, Range[][]>();
    if (current.invoked || current.awaited || current.serialized) {
      const statement = parsed.ast.body[0];
      if (statement?.type === "ExpressionStatement") {
        if (current.serialized) serializedNodes.add(statement.expression);
        if (current.replacer) replacers.set(statement.expression, current.replacer);
        if (current.replacerApplied) replaced.add(statement.expression);
        serializationKeys.set(statement.expression, current.serializationKey ?? "");
        if (current.propertyList) propertyLists.set(statement.expression, current.propertyList);
        if (current.invoked) invokedNodes.add(statement.expression);
        callArguments.set(statement.expression, current.args);
        followingCalls.set(statement.expression, current.following ?? []);
        if (current.awaited) awaitedNodes.add(statement.expression);
      }
    }
    const nodes: unknown[] = [parsed.ast];
    while (nodes.length) {
      const node = nodes.pop() as AnyNode;
      if (node.type.startsWith("TS")) {
        if (node.expression) {
          serialize(node, node.expression);
          if (invokedNodes.has(node)) invokedNodes.add(node.expression);
          callArguments.set(node.expression, callArguments.get(node) ?? []);
          followingCalls.set(node.expression, followingCalls.get(node) ?? []);
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
      const replacerRange = replacers.get(node);
      if (
        serializedNodes.has(node) &&
        replacerRange &&
        !replaced.has(node) &&
        !invokedNodes.has(node) &&
        ![
          "Identifier",
          "CallExpression",
          "AwaitExpression",
          "ConditionalExpression",
          "LogicalExpression",
          "SequenceExpression",
        ].includes(node.type) &&
        !(
          node.type === "ObjectExpression" &&
          serializationHooks.has(current.start + node.range[0] - 1)
        )
      ) {
        pending.push({
          ...current,
          value: source.slice(...replacerRange),
          start: replacerRange[0],
          invoked: true,
          serialized: true,
          replacer: replacerRange,
          replacerApplied: true,
          serializationKey: serializationKeys.get(node),
          propertyList: propertyLists.get(node),
          args: [
            literalRange(serializationKeys.get(node) ?? ""),
            [current.start + node.range[0] - 1, current.start + node.range[1] - 1],
          ],
          bindings: new Map(current.bindings),
        });
        continue;
      }
      if (
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      ) {
        if (invokedNodes.has(node) && !node.generator && (!node.async || awaitedNodes.has(node))) {
          const body = node.body as AnyNode;
          if (current.receiver && node.type !== "ArrowFunctionExpression") {
            const receiver = current.receiver;
            const bindThis = (child: AnyNode) => {
              if (["FunctionExpression", "FunctionDeclaration"].includes(child.type)) return;
              if (child.type === "ThisExpression")
                current.bindings.set(current.start + child.range[0] - 1, [receiver]);
              for (const key of parsed.visitorKeys[child.type] ?? []) {
                const value = child[key];
                if (Array.isArray(value)) value.filter(Boolean).forEach(bindThis);
                else if (value) bindThis(value);
              }
            };
            bindThis(body);
          }
          const args = callArguments.get(node) ?? [];
          const params = node.params as AnyNode[];
          const bindings = new Map<string, Range[]>();
          function bind(pattern: AnyNode, range?: Range) {
            if (pattern.type === "AssignmentPattern") {
              if (!range || source.slice(...range) === "undefined")
                range = [
                  current.start + pattern.right.range[0] - 1,
                  current.start + pattern.right.range[1] - 1,
                ];
              bind(pattern.left, range);
            } else if (pattern.type === "Identifier") {
              bindings.set(pattern.name, range ? [range] : []);
            } else if (pattern.type === "ObjectPattern" || pattern.type === "ArrayPattern") {
              function readValue(range: Range | undefined, visited = new Set<number>()) {
                let value: AnyNode;
                let offset = 0;
                while (range && !visited.has(range[0])) {
                  visited.add(range[0]);
                  offset = range[0] - 1;
                  try {
                    const parsed = parseForESLint(`(${source.slice(...range)})`, { range: true });
                    const statement = parsed.ast.body[0];
                    value =
                      statement?.type === "ExpressionStatement" ? statement.expression : undefined;
                  } catch {
                    break;
                  }
                  if (value?.type !== "Identifier") break;
                  const ranges =
                    current.bindings.get(offset + value.range[0]) ??
                    initializers.get(offset + value.range[0]);
                  if (ranges?.length !== 1) break;
                  range = ranges[0];
                }
                return { value, offset, visited };
              }
              const { value, offset } = readValue(range);
              function properties(
                range: Range | undefined,
                visited = new Set<number>(),
              ): Array<{ node: AnyNode; offset: number }> {
                const resolved = readValue(range, visited);
                if (resolved.value?.type !== "ObjectExpression") return [];
                return resolved.value.properties.flatMap((node: AnyNode) =>
                  node.type === "SpreadElement"
                    ? properties(
                        [
                          resolved.offset + node.argument.range[0],
                          resolved.offset + node.argument.range[1],
                        ],
                        new Set(resolved.visited),
                      )
                    : [{ node, offset: resolved.offset }],
                );
              }
              if (pattern.type === "ObjectPattern") {
                for (const property of pattern.properties) {
                  if (property.type !== "Property") continue;
                  const key =
                    !property.computed || property.key.type === "Literal"
                      ? propertyName(property.key)
                      : null;
                  const match =
                    value?.type === "ObjectExpression" && key !== null
                      ? properties(range).findLast(
                          ({ node: item }) =>
                            item.type === "Property" &&
                            (!item.computed || item.key.type === "Literal") &&
                            propertyName(item.key) === key,
                        )
                      : undefined;
                  bind(
                    property.value,
                    match
                      ? [
                          match.offset + match.node.value.range[0],
                          match.offset + match.node.value.range[1],
                        ]
                      : undefined,
                  );
                }
              } else {
                pattern.elements.forEach((element: AnyNode, index: number) => {
                  const match =
                    value?.type === "ArrayExpression" ? value.elements[index] : undefined;
                  if (element)
                    bind(
                      element,
                      match ? [offset + match.range[0], offset + match.range[1]] : undefined,
                    );
                });
              }
            }
          }
          params.forEach((param, index) => {
            if (param.type === "RestElement" && param.argument.type === "Identifier")
              bindings.set(param.argument.name, args.slice(index));
            else bind(param, args[index]);
          });
          for (const scope of parsed.scopeManager.scopes) {
            for (const reference of scope.references) {
              const definition = reference.resolved?.defs[0];
              if (definition?.type !== "Parameter" || definition.node !== node) continue;
              if (
                params.some(
                  (param) =>
                    param.type === "RestElement" &&
                    param.argument.name === reference.identifier.name,
                )
              )
                restReferences.add(current.start + reference.identifier.range[0] - 1);
              current.bindings.set(
                current.start + reference.identifier.range[0] - 1,
                bindings.get(reference.identifier.name) ?? [],
              );
            }
          }
          const visit = (value: AnyNode) => {
            if (awaitedNodes.has(node)) awaitedNodes.add(value);
            const following = followingCalls.get(node) ?? [];
            if (following.length) {
              invokedNodes.add(value);
              callArguments.set(value, following[0]!);
              followingCalls.set(value, following.slice(1));
            }
            serialize(node, value);
            nodes.push(value);
          };
          if (body.type !== "BlockStatement") visit(body);
          else visitReturnValues(body, visit);
        }
        continue;
      }
      if (node.type === "ObjectExpression" && serializedNodes.has(node)) {
        const hook = serializationHooks.get(current.start + node.range[0] - 1);
        if (hook) {
          const identity = `serialization:${JSON.stringify([serializationKeys.get(node), propertyLists.get(node)])}:${hook.range[0]}:${JSON.stringify([...current.bindings])}`;
          if (!seen.has(identity)) {
            seen.add(identity);
            pending.push({
              value: hook.prefix + source.slice(...hook.range),
              start: hook.range[0] - hook.prefix.length,
              invoked: true,
              serialized: true,
              awaited: false,
              args: hook.getter ? [] : [literalRange(serializationKeys.get(node) ?? "")],
              following: hook.getter
                ? [[literalRange(serializationKeys.get(node) ?? "")]]
                : undefined,
              receiver: [current.start + node.range[0] - 1, current.start + node.range[1] - 1],
              serializationKey: serializationKeys.get(node),
              propertyList: propertyLists.get(node),
              replacer: replacers.get(node),
              replacerApplied: replaced.has(node),
              bindings: new Map(current.bindings),
            });
          }
          continue;
        }
        for (const property of serializedProperties(node, current.start - 1, current.bindings)) {
          const list = propertyLists.get(node);
          if (list && property.key !== null && !list.includes(property.key)) continue;
          if (property.node.computed && property.key === null) {
            const keyRange: Range = [
              property.offset + property.node.key.range[0],
              property.offset + property.node.key.range[1],
            ];
            pending.push({
              ...current,
              value: source.slice(...keyRange),
              start: keyRange[0],
              serialized: false,
              invoked: false,
              replacer: undefined,
              args: [],
            });
          }
          const value = property.node.value;
          const range: Range = [property.offset + value.range[0], property.offset + value.range[1]];
          const prefix = property.node.method || property.node.kind === "get" ? "function" : "";
          pending.push({
            ...current,
            value: prefix + source.slice(...range),
            start: range[0] - prefix.length,
            serialized: true,
            serializationKey: property.key ?? "",
            propertyList: list,
            invoked: property.node.kind === "get",
            args: [],
            replacer: replacers.get(node),
            replacerApplied: false,
          });
        }
        continue;
      }
      if (node.type === "Property" && node.kind === "get" && serializedNodes.has(node))
        invokedNodes.add(node.value);
      if (node.type === "AwaitExpression") awaitedNodes.add(node.argument);
      if (node.type === "CallExpression") {
        if (
          memberPath(node.callee) === "JSON.stringify" &&
          node.arguments[0] &&
          bindingKeys.get(current.start + node.callee.object.range[0] - 1) === "global:JSON"
        ) {
          const argument = node.arguments[0];
          serializedNodes.add(argument);
          serializationKeys.set(argument, "");
          let replacer = node.arguments[1];
          let offset = current.start - 1;
          const visited = new Set<number>();
          while (replacer?.type === "Identifier") {
            const position = offset + replacer.range[0];
            if (visited.has(position)) break;
            visited.add(position);
            const ranges = current.bindings.get(position) ?? initializers.get(position);
            if (ranges?.length !== 1) break;
            offset = ranges[0]![0] - 1;
            try {
              const ast = parseForESLint(`(${source.slice(...ranges[0]!)})`, { range: true }).ast;
              replacer = (ast.body[0] as AnyNode).expression;
            } catch {
              break;
            }
          }
          if (replacer?.type === "ArrayExpression") {
            const keys: string[] = [];
            const visitedArrays = new Set<number>();
            const collectKeys = (array: AnyNode, offset: number): boolean => {
              if (visitedArrays.has(offset + array.range[0])) return false;
              visitedArrays.add(offset + array.range[0]);
              for (const element of array.elements) {
                if (!element) continue;
                const value = element.type === "SpreadElement" ? element.argument : element;
                const resolved = readValue(
                  [offset + value.range[0], offset + value.range[1]],
                  current.bindings,
                );
                if (element.type === "SpreadElement") {
                  if (
                    resolved?.node.type !== "ArrayExpression" ||
                    !collectKeys(resolved.node, resolved.offset)
                  )
                    return false;
                } else if (resolved?.node.type === "Literal") {
                  if (["string", "number"].includes(typeof resolved.node.value))
                    keys.push(String(resolved.node.value));
                } else return false;
              }
              return true;
            };
            if (collectKeys(replacer, offset)) propertyLists.set(argument, keys);
          } else if (
            replacer &&
            [
              "ArrowFunctionExpression",
              "FunctionExpression",
              "FunctionDeclaration",
              "Identifier",
              "MemberExpression",
              "CallExpression",
            ].includes(replacer.type)
          ) {
            replacers.set(argument, [offset + replacer.range[0], offset + replacer.range[1]]);
          }
          nodes.push(argument);
          continue;
        }
        if (
          memberPath(node.callee as AnyNode) === "Promise.resolve" &&
          !shadowedPromises.has(current.start + node.callee.object.range[0] - 1)
        ) {
          if (awaitedNodes.has(node)) {
            const argument = (node.arguments as AnyNode[])[0];
            if (argument) {
              awaitedNodes.add(argument);
              nodes.push(argument);
            }
          }
          continue;
        }
        if (
          memberPath(node.callee as AnyNode) === "Promise.reject" &&
          !shadowedPromises.has(current.start + node.callee.object.range[0] - 1)
        )
          continue;
        callArguments.set(
          node.callee,
          (node.arguments as AnyNode[]).map((argument) => [
            current.start + argument.range[0] - 1,
            current.start + argument.range[1] - 1,
          ]),
        );
        followingCalls.set(
          node.callee,
          invokedNodes.has(node)
            ? [callArguments.get(node) ?? [], ...(followingCalls.get(node) ?? [])]
            : [],
        );
        serialize(node, node.callee);
        invokedNodes.add(node.callee);
        if (awaitedNodes.has(node)) awaitedNodes.add(node.callee);
        if (localCalls.has(current.start + node.range[0] - 1)) {
          nodes.push(node.callee);
          continue;
        }
      }
      if (node.type === "MemberExpression") {
        const position = current.start + node.object.range[0] - 1;
        if (
          node.object.type === "Identifier" &&
          restReferences.has(position) &&
          node.computed &&
          node.property.type === "Literal"
        ) {
          const key = String(node.property.value);
          const index = Number(key);
          const range =
            Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key
              ? current.bindings.get(position)?.[index]
              : undefined;
          if (range)
            pending.push({
              ...current,
              value: source.slice(...range),
              start: range[0],
              invoked: invokedNodes.has(node),
              args: callArguments.get(node) ?? [],
            });
          continue;
        }
        const member = memberReturns.get(current.start + node.range[0] - 1);
        if (member && (invokedNodes.has(node) || member.getter)) {
          const awaited = awaitedNodes.has(node);
          const identity = `${JSON.stringify([current.replacer, current.replacerApplied, serializationKeys.get(node), propertyLists.get(node)])}:${member.range[0]}:${current.start + node.object.range[0] - 1}:member:${awaited}:${serializedNodes.has(node)}:${JSON.stringify(callArguments.get(node))}:${JSON.stringify([...current.bindings])}:${JSON.stringify(followingCalls.get(node))}`;
          if (!seen.has(identity)) {
            seen.add(identity);
            pending.push({
              receiver: [
                current.start + node.object.range[0] - 1,
                current.start + node.object.range[1] - 1,
              ],
              value: member.prefix + source.slice(...member.range),
              start: member.range[0] - member.prefix.length,
              serialized: serializedNodes.has(node),
              serializationKey: serializationKeys.get(node),
              propertyList: propertyLists.get(node),
              replacer: replacers.get(node),
              replacerApplied: replaced.has(node),
              invoked: true,
              awaited,
              args: callArguments.get(node) ?? [],
              following: followingCalls.get(node),
              bindings: new Map(current.bindings),
            });
          }
          continue;
        }
        const range: Range = [current.start + node.range[0] - 1, current.start + node.range[1] - 1];
        const selected = readValue(range, current.bindings);
        if (selected && selected.offset + selected.node.range[0] !== range[0]) {
          const start = selected.offset + selected.node.range[0];
          pending.push({
            ...current,
            value: source.slice(start, selected.offset + selected.node.range[1]),
            start,
            invoked: invokedNodes.has(node),
            serialized: serializedNodes.has(node),
            serializationKey: serializationKeys.get(node),
            propertyList: propertyLists.get(node),
            replacer: replacers.get(node),
            replacerApplied: replaced.has(node),
            awaited: awaitedNodes.has(node),
            args: callArguments.get(node) ?? [],
            following: followingCalls.get(node),
          });
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
        const list = propertyLists.get(node);
        const key = propertyName(node.key);
        if (list && key !== null && !list.includes(key)) continue;
        serializationKeys.set(node.value, key ?? "");
        if (list) propertyLists.set(node.value, list);
        if (node.computed) nodes.push(node.key);
        serialize(node, node.value, key ?? "");
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
      if (node.type === "LogicalExpression") {
        const resolvedLeft = readValue(
          [current.start + node.left.range[0] - 1, current.start + node.left.range[1] - 1],
          current.bindings,
        );
        const left = resolvedLeft?.node;
        const isUndefined =
          (left?.type === "UnaryExpression" && left.operator === "void") ||
          (left?.type === "Identifier" &&
            left.name === "undefined" &&
            (resolvedLeft!.offset + left.range[0] === undefinedRange[0] ||
              bindingKeys.get(resolvedLeft!.offset + left.range[0]) === "global:undefined"));
        let branches = [node.left, node.right];
        const isTruthyObject =
          left &&
          [
            "ObjectExpression",
            "ArrayExpression",
            "FunctionExpression",
            "ArrowFunctionExpression",
            "ClassExpression",
          ].includes(left.type);
        const isStaticTemplate = left?.type === "TemplateLiteral" && left.expressions.length === 0;
        if (left?.type === "Literal" || isUndefined || isTruthyObject || isStaticTemplate) {
          const value = isUndefined
            ? undefined
            : isTruthyObject
              ? true
              : isStaticTemplate
                ? left.quasis[0].value.cooked
                : left.value;
          const useRight =
            node.operator === "&&"
              ? Boolean(value)
              : node.operator === "||"
                ? !value
                : value == null;
          branches = [useRight ? node.right : node.left];
        }
        for (const branch of branches) {
          serialize(node, branch);
          if (invokedNodes.has(node)) invokedNodes.add(branch);
          if (awaitedNodes.has(node)) awaitedNodes.add(branch);
          callArguments.set(branch, callArguments.get(node) ?? []);
          followingCalls.set(branch, followingCalls.get(node) ?? []);
        }
        nodes.push(...branches);
        continue;
      }
      if (node.type === "ConditionalExpression") {
        let branches = [node.consequent, node.alternate];
        const test = node.test;
        const resolvedTest = readValue(
          [current.start + test.range[0] - 1, current.start + test.range[1] - 1],
          current.bindings,
        )?.node;
        if (resolvedTest?.type === "Literal")
          branches = [resolvedTest.value ? node.consequent : node.alternate];
        if (
          test.type === "BinaryExpression" &&
          ["===", "!==", "==", "!="].includes(test.operator)
        ) {
          const left = readValue(
            [current.start + test.left.range[0] - 1, current.start + test.left.range[1] - 1],
            current.bindings,
          )?.node;
          const right = readValue(
            [current.start + test.right.range[0] - 1, current.start + test.right.range[1] - 1],
            current.bindings,
          )?.node;
          if (
            left?.type === "Literal" &&
            right?.type === "Literal" &&
            typeof left.value === typeof right.value
          ) {
            const equal = left.value === right.value;
            const branch = (test.operator.includes("!") ? !equal : equal)
              ? node.consequent
              : node.alternate;
            branches = [branch];
          }
        }
        for (const branch of branches) {
          serialize(node, branch);
          if (invokedNodes.has(node)) invokedNodes.add(branch);
          callArguments.set(branch, callArguments.get(node) ?? []);
          followingCalls.set(branch, followingCalls.get(node) ?? []);
        }
        if (awaitedNodes.has(node)) {
          awaitedNodes.add(node.consequent);
          awaitedNodes.add(node.alternate);
        }
        nodes.push(...branches);
        continue;
      }
      if (node.type === "SequenceExpression") {
        const last = (node.expressions as unknown[]).at(-1);
        serialize(node, last);
        if (invokedNodes.has(node)) invokedNodes.add(last);
        callArguments.set(last, callArguments.get(node) ?? []);
        followingCalls.set(last, followingCalls.get(node) ?? []);
        if (awaitedNodes.has(node)) awaitedNodes.add(last);
        nodes.push(last);
        continue;
      }
      if (node.type === "Identifier") {
        identifiers.add(node.range[0]);
        if (invokedNodes.has(node)) invokedReferences.add(node.range[0]);
        if (awaitedNodes.has(node)) awaitedReferences.add(node.range[0]);
      }
      for (const key of parsed.visitorKeys[node.type] ?? []) {
        const child = node[key];
        const children = Array.isArray(child) ? child.filter(Boolean) : child ? [child] : [];
        if (serializedNodes.has(node) && node.type !== "MemberExpression")
          children.forEach((child, index) => {
            serializedNodes.add(child);
            const replacer = replacers.get(node);
            if (replacer) replacers.set(child, replacer);
            if (node.type !== "ArrayExpression" && replaced.has(node)) replaced.add(child);
            serializationKeys.set(
              child,
              node.type === "ArrayExpression" ? String(index) : (serializationKeys.get(node) ?? ""),
            );
            const list = propertyLists.get(node);
            if (list) propertyLists.set(child, list);
          });
        nodes.push(...children);
      }
    }
    for (const scope of parsed.scopeManager.scopes) {
      for (const reference of scope.references) {
        if (!reference.isValueReference || !identifiers.has(reference.identifier.range[0]))
          continue;
        const offset = current.start + reference.identifier.range[0] - 1;
        const ranges = current.bindings.get(offset) ?? initializers.get(offset);
        for (const range of ranges ?? []) {
          const serialized = serializedNodes.has(reference.identifier);
          const invoked = invokedReferences.has(reference.identifier.range[0]);
          const awaited = awaitedReferences.has(reference.identifier.range[0]);
          const identity = `${JSON.stringify([current.replacer, current.replacerApplied, serializationKeys.get(reference.identifier), propertyLists.get(reference.identifier)])}:${range[0]}:${invoked}:${awaited}:${serialized}:${JSON.stringify(callArguments.get(reference.identifier))}:${JSON.stringify([...current.bindings])}:${JSON.stringify(followingCalls.get(reference.identifier))}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          const initializer = source.slice(...range);
          pending.push({
            value: initializer,
            start: range[0],
            invoked,
            serialized,
            serializationKey: serializationKeys.get(reference.identifier),
            propertyList: propertyLists.get(reference.identifier),
            replacer: replacers.get(reference.identifier),
            replacerApplied: replaced.has(reference.identifier),
            awaited,
            args: callArguments.get(reference.identifier) ?? [],
            following: followingCalls.get(reference.identifier),
            bindings: new Map(current.bindings),
          });
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
  const { initializers, bindingKeys, configHelpers, mergeHelpers, shadowedPromises, localCalls } =
    readAliasInitializers(text);
  const nodesByRange = new Map<string, AnyNode>();
  walkScriptLocal(program, (node) => {
    if (node.type !== "TemplateElement") nodesByRange.set(`${node.start}:${node.end}`, node);
  });
  const seen = new Set<AnyNode>();
  function resolve(node: AnyNode, visited = new Set<AnyNode>()): AnyNode {
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
      } else if (node.type === "MemberExpression") {
        const object = resolve(node.object, new Set(visited));
        const property = node.computed ? resolve(node.property, new Set(visited)) : node.property;
        const key = node.computed
          ? property?.type === "Literal"
            ? String(property.value)
            : property?.type === "TemplateLiteral" && property.expressions.length === 0
              ? property.quasis[0].value.cooked
              : null
          : propertyName(property);
        if (key == null) break;
        if (object?.type === "ObjectExpression") {
          const match = readOptions(object).findLast(
            (item) => item.type === "Property" && keyOf(item) === key,
          );
          if (match?.kind !== "init") break;
          node = match.value;
        } else if (
          object?.type === "ArrayExpression" &&
          !object.elements.some((item: AnyNode) => item?.type === "SpreadElement")
        ) {
          const index = Number(key);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= 2 ** 32 - 1 ||
            String(index) !== key
          )
            break;
          node = object.elements[index];
        } else break;
      } else break;
    }
    return node;
  }
  function keyOf(property: AnyNode): string | null {
    if (!property.computed) return propertyName(property.key);
    const key = resolve(property.key);
    if (key?.type === "TemplateLiteral" && key.expressions.length === 0)
      return key.quasis[0].value.cooked;
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
  type Alternative = { entries: typeof entries; predicates: Map<string, boolean> };
  function readConfig(input: AnyNode): Alternative[] {
    const empty = () => [{ entries: [], predicates: new Map<string, boolean>() }];
    const node = resolve(input);
    if (!node || seen.has(node)) return empty();
    seen.add(node);
    try {
      if (node.type === "CallExpression" && mergeHelpers.has(node.callee.start)) {
        const left = readConfig(node.arguments[0]);
        const right = readConfig(node.arguments[1]);
        return left.flatMap((base) =>
          right.flatMap((override) => {
            if (
              [...base.predicates].some(
                ([key, value]) =>
                  override.predicates.has(key) && override.predicates.get(key) !== value,
              )
            )
              return [];
            return [
              {
                entries: [
                  ...new Map(
                    [
                      ...base.entries,
                      ...override.entries.filter((entry) => {
                        const value = resolve(
                          nodesByRange.get(
                            `${entry.valueStart}:${entry.valueStart + entry.rawValue.length}`,
                          ),
                        );
                        return (
                          !(value?.type === "Literal" && value.value === null) &&
                          !(
                            value?.type === "Identifier" &&
                            value.name === "undefined" &&
                            bindingKeys.get(value.start) === "global:undefined"
                          ) &&
                          !(value?.type === "UnaryExpression" && value.operator === "void")
                        );
                      }),
                    ].map((entry) => [entry.key, entry]),
                  ).values(),
                ],
                predicates: new Map([...base.predicates, ...override.predicates]),
              },
            ];
          }),
        );
      } else if (node.type === "CallExpression" && localCalls.has(node.start)) {
        const callee = resolve(node.callee);
        if (!callee?.params) return empty();
        const previous = new Map<number, [number, number][] | undefined>();
        function bind(pattern: AnyNode, input: AnyNode) {
          let value = resolve(input);
          if (pattern.type === "AssignmentPattern") {
            if (
              !value ||
              (value.type === "Identifier" && value.name === "undefined") ||
              (value.type === "UnaryExpression" && value.operator === "void")
            )
              value = pattern.right;
            bind(pattern.left, value);
          } else if (pattern.type === "Identifier") {
            for (const [position, key] of bindingKeys) {
              if (key !== `binding:${pattern.start}`) continue;
              if (!previous.has(position)) previous.set(position, initializers.get(position));
              initializers.set(position, value ? [[value.start, value.end]] : []);
            }
          } else if (pattern.type === "ObjectPattern") {
            for (const property of pattern.properties) {
              if (property.type !== "Property") continue;
              const key = keyOf(property);
              const match =
                value?.type === "ObjectExpression"
                  ? readOptions(value).findLast(
                      (item) => item.type === "Property" && keyOf(item) === key,
                    )
                  : undefined;
              bind(property.value, match?.value);
            }
          } else if (pattern.type === "ArrayPattern") {
            pattern.elements.forEach((element: AnyNode, index: number) => {
              if (element)
                bind(
                  element,
                  value?.type === "ArrayExpression" ? value.elements[index] : undefined,
                );
            });
          }
        }
        callee.params.forEach((parameter: AnyNode, index: number) =>
          bind(parameter, node.arguments[index]),
        );
        try {
          return readConfig(callee);
        } finally {
          for (const [position, ranges] of previous) {
            if (ranges) initializers.set(position, ranges);
            else initializers.delete(position);
          }
        }
      } else if (node.type === "AwaitExpression") {
        return readConfig(node.argument);
      } else if (
        node.type === "CallExpression" &&
        (configHelpers.has(node.callee.start) ||
          (memberPath(node.callee) === "Promise.resolve" &&
            !shadowedPromises.has(node.callee.object.start)))
      ) {
        return readConfig(node.arguments[0]);
      } else if (
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      ) {
        if (node.body.type !== "BlockStatement") return readConfig(node.body);
        const alternatives: Alternative[] = [];
        visitReturnValues(node.body, (value) => alternatives.push(...readConfig(value)));
        return alternatives.length ? alternatives : empty();
      } else if (node.type === "ConditionalExpression") {
        let predicate = node.test;
        let inverted = false;
        const visited = new Set<AnyNode>();
        while (predicate && !visited.has(predicate)) {
          visited.add(predicate);
          if (predicate.type === "UnaryExpression" && predicate.operator === "!") {
            inverted = !inverted;
            predicate = predicate.argument;
          } else if (predicate.type.startsWith("TS") && predicate.expression) {
            predicate = predicate.expression;
          } else if (predicate.type === "Identifier") {
            const ranges = initializers.get(predicate.start);
            const next = ranges?.length === 1 ? nodesByRange.get(ranges[0]!.join(":")) : undefined;
            if (
              next?.type !== "Identifier" &&
              !(next?.type === "UnaryExpression" && next.operator === "!")
            )
              break;
            predicate = next;
          } else break;
        }
        const key = predicate?.type === "Identifier" ? bindingKeys.get(predicate.start) : undefined;
        return [true, false].flatMap((truth) =>
          readConfig(truth ? node.consequent : node.alternate).flatMap((alternative) => {
            if (!key) return [alternative];
            if (
              alternative.predicates.has(key) &&
              alternative.predicates.get(key) !== (truth !== inverted)
            )
              return [];
            return [
              {
                entries: alternative.entries,
                predicates: new Map([...alternative.predicates, [key, truth !== inverted]]),
              },
            ];
          }),
        );
      } else if (node.type === "ObjectExpression") {
        const result: typeof entries = [];
        const option = readOptions(node).findLast(
          (option) => option.type === "Property" && keyOf(option) === "define",
        );
        if (option) {
          const values = resolve(option.value);
          if (values?.type !== "ObjectExpression") return empty();
          const properties = new Map<string, AnyNode>();
          for (const property of readOptions(values)) {
            if (property.type !== "Property") continue;
            const key = keyOf(property);
            if (key !== null) properties.set(key, property);
          }
          for (const [key, property] of properties) {
            const valueStart = property.value.start;
            result.push({
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
        return [{ entries: result, predicates: new Map() }];
      }
      return empty();
    } finally {
      seen.delete(node);
    }
  }
  for (const statement of (program as AnyNode).body) {
    if (statement.type === "ExportDefaultDeclaration")
      entries.push(
        ...readConfig(statement.declaration).flatMap((alternative) => alternative.entries),
      );
    else if (statement.type === "ExportNamedDeclaration" && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (propertyName(specifier.exported) === "default")
          entries.push(
            ...readConfig(specifier.local).flatMap((alternative) => alternative.entries),
          );
      }
    } else if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AssignmentExpression" &&
      statement.expression.operator === "=" &&
      memberPath(statement.expression.left) === "module.exports"
    )
      entries.push(
        ...readConfig(statement.expression.right).flatMap((alternative) => alternative.entries),
      );
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
