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
        const { bindingKeys } = readAliasInitializers(ctx.file.text);
        for (const entry of readDefineEntriesFromCurrentFile(ctx, node)) {
          function primitive(value: AnyNode): boolean {
            if (value.type === "ConditionalExpression")
              return primitive(value.consequent) && primitive(value.alternate);
            const raw = ctx.file.text.slice(value.start, value.end);
            return (
              isLiteralPrimitive(raw) ||
              raw.startsWith("JSON.stringify(") ||
              (/^process\.env\.[^.]+$/.test(memberPath(value) ?? "") &&
                bindingKeys.get(value.object.object.start) === "global:process")
            );
          }
          if (primitive(entry.valueNode)) continue;
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
          source: aliasSource,
        } = readAliasInitializers(ctx.file.text);
        for (const entry of readDefineEntriesFromCurrentFile(ctx, node)) {
          if (
            !SECRET_NAME_RE.test(entry.key) &&
            !(entry.traceValues ?? [entry]).some((value) =>
              resolvesSecretAlias(
                value.rawValue,
                value.valueStart,
                aliasSource,
                initializers,
                memberReturns,
                localCalls,
                shadowedPromises,
                serializationHooks,
                bindingKeys,
              ),
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
      source,
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
  const arrayMutations = new Map<
    AnyNode,
    Array<{ position: number; member?: AnyNode; mutation?: AnyNode }>
  >();
  const executionRanges = new Map<number, [number, number]>();
  function recordArrayMutation(
    node: AnyNode,
    memberWrite = false,
    mutation?: AnyNode,
    executionPosition?: number,
  ) {
    if (!node) return;
    const member = memberWrite && node.type === "MemberExpression" ? node : undefined;
    while (memberWrite && node.type === "MemberExpression") node = node.object;
    const value = resolveImmutable(node);
    if (value.type !== "ArrayExpression") return;
    const events = arrayMutations.get(value) ?? [];
    const executionRange =
      executionPosition === undefined ? undefined : executionRanges.get(executionPosition);
    const localArray =
      executionRange && value.range[0] >= executionRange[0] && value.range[1] <= executionRange[1];
    events.push({
      position: localArray
        ? (mutation?.range[1] ?? node.range[1])
        : (executionPosition ?? mutation?.range[1] ?? node.range[1]),
      member,
      mutation,
    });
    arrayMutations.set(value, events);
  }
  function arrayElementsAt(value: AnyNode, position: number) {
    const events = arrayMutations.get(value);
    if (!events) return;
    const elements: Array<[number, number] | undefined> = value.elements.map(
      (element: AnyNode) => element?.range,
    );
    let changed = false;
    for (const { position: writePosition, member, mutation } of events.toSorted(
      (left, right) => left.position - right.position,
    )) {
      if (writePosition > position) break;
      if (
        member &&
        mutation?.type === "AssignmentExpression" &&
        mutation.operator === "=" &&
        member.computed &&
        member.property.type === "Literal" &&
        Number.isInteger(member.property.value) &&
        member.property.value >= 0
      ) {
        elements[member.property.value] = mutation.right.range;
        changed = true;
      } else if (mutation?.type === "CallExpression" && mutation.callee.property?.name === "push") {
        elements.push(
          ...mutation.arguments.flatMap((argument: AnyNode) => expandMutationArgument(argument)),
        );
        changed = true;
      } else if (
        mutation?.type === "CallExpression" &&
        mutation.callee.property?.name === "unshift"
      ) {
        elements.unshift(
          ...mutation.arguments.flatMap((argument: AnyNode) => expandMutationArgument(argument)),
        );
        changed = true;
      } else if (mutation?.type === "CallExpression" && mutation.callee.property?.name === "pop") {
        elements.pop();
        changed = true;
      } else if (
        mutation?.type === "CallExpression" &&
        mutation.callee.property?.name === "shift"
      ) {
        elements.shift();
        changed = true;
      } else if (
        mutation?.type === "CallExpression" &&
        mutation.callee.property?.name === "splice" &&
        mutation.arguments.length >= 2 &&
        mutation.arguments.slice(0, 2).every((argument: AnyNode) => argument.type === "Literal") &&
        mutation.arguments
          .slice(0, 2)
          .every((argument: AnyNode) => Number.isInteger(argument.value))
      ) {
        elements.splice(
          mutation.arguments[0].value,
          mutation.arguments[1].value,
          ...mutation.arguments
            .slice(2)
            .flatMap((argument: AnyNode) => expandMutationArgument(argument)),
        );
        changed = true;
      } else if (mutation?.type === "CallExpression" && mutation.callee.property?.name === "fill") {
        const bounds = mutation.arguments.slice(1).map((argument: AnyNode) => {
          const resolved = resolveImmutable(argument);
          if (resolved.type === "Literal") return resolved.value;
          if (
            resolved.type === "UnaryExpression" &&
            ["+", "-"].includes(resolved.operator) &&
            resolved.argument.type === "Literal" &&
            typeof resolved.argument.value === "number"
          )
            return resolved.operator === "-" ? -resolved.argument.value : +resolved.argument.value;
        });
        if (
          mutation.arguments.length < 1 ||
          mutation.arguments.length > 3 ||
          !bounds.every((bound: unknown) => Number.isInteger(bound))
        )
          return null;
        elements.fill(
          mutation.arguments[0].range,
          bounds[0] as number | undefined,
          bounds[1] as number | undefined,
        );
        changed = true;
      } else if (mutation?.type !== "CallExpression" || !member) {
        return null;
      }
    }
    return changed ? elements.filter((range) => range != null) : [value.range];
  }
  function expandMutationArgument(
    argument: AnyNode,
    seen = new Set<AnyNode>(),
  ): [number, number][] {
    if (argument.type !== "SpreadElement") return [argument.range];
    const value = resolveImmutable(argument.argument);
    if (value.type !== "ArrayExpression" || seen.has(value)) return [];
    return value.elements.flatMap((element: AnyNode) =>
      element ? expandMutationArgument(element, new Set([...seen, value])) : [],
    );
  }
  const visitMutation = (node: AnyNode, executionPosition?: number) => {
    if (node.type === "AssignmentExpression")
      recordArrayMutation(node.left, true, node, executionPosition);
    else if (
      node.type === "UpdateExpression" ||
      (node.type === "UnaryExpression" && node.operator === "delete")
    )
      recordArrayMutation(node.argument, true, node, executionPosition);
    else if (node.type === "CallExpression") {
      if (node.callee.type === "MemberExpression")
        recordArrayMutation(node.callee, true, node, executionPosition);
      const serializesArray =
        memberPath(node.callee) === "JSON.stringify" &&
        !references.get(node.callee.object.range[0])?.resolved;
      if (!serializesArray)
        for (const argument of node.arguments)
          if (argument.type !== "SpreadElement")
            recordArrayMutation(argument, false, node, executionPosition);
    }
  };
  const executedFunctions = new Set<AnyNode>();
  function calledFunction(node: AnyNode): AnyNode {
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    )
      return node;
    if (node.type !== "Identifier") return;
    const definition = references.get(node.range[0])?.resolved?.defs[0];
    if (definition?.type === "FunctionName") return definition.node;
    const value = resolveImmutable(node);
    if (["FunctionExpression", "ArrowFunctionExpression"].includes(value.type)) return value;
  }
  function isConfigHelper(node: AnyNode) {
    node = resolveImmutable(node);
    const identifier = node.type === "MemberExpression" ? node.object : node;
    if (identifier.type !== "Identifier") return false;
    const definition = references.get(identifier.range[0])?.resolved?.defs[0];
    if (
      definition?.type === "Variable" &&
      definition.parent.kind === "const" &&
      definition.node.init?.type === "CallExpression" &&
      definition.node.init.callee.type === "Identifier" &&
      definition.node.init.callee.name === "require" &&
      !references.get(definition.node.init.callee.range[0])?.resolved &&
      definition.node.init.arguments[0]?.type === "Literal" &&
      ["vite", "vitest/config"].includes(definition.node.init.arguments[0].value as string)
    ) {
      if (node.type === "MemberExpression")
        return !node.computed && node.property.name === "defineConfig";
      if (definition.node.id.type === "ObjectPattern")
        return definition.node.id.properties.some(
          (property: AnyNode) =>
            property.type === "Property" &&
            propertyName(property.key) === "defineConfig" &&
            property.value.name === identifier.name,
        );
    }
    if (
      definition?.type !== "ImportBinding" ||
      definition.parent.type !== "ImportDeclaration" ||
      !["vite", "vitest/config"].includes(definition.parent.source.value as string)
    )
      return false;
    if (node.type === "MemberExpression")
      return (
        (definition.node.type === "ImportNamespaceSpecifier" ||
          definition.node.type === "ImportDefaultSpecifier") &&
        !node.computed &&
        node.property.name === "defineConfig"
      );
    return (
      definition.node.type === "ImportSpecifier" &&
      propertyName(definition.node.imported) === "defineConfig"
    );
  }
  function collectExecutedFunction(node?: AnyNode, position?: number) {
    if (!node || executedFunctions.has(node)) return;
    executedFunctions.add(node);
    if (position !== undefined) executionRanges.set(position, node.range);
    collectMutations(
      node.body,
      position !== undefined && (position < node.range[0] || position > node.range[1])
        ? position
        : undefined,
    );
  }
  function collectMutations(node: AnyNode, executionPosition?: number) {
    if (!node) return;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    )
      return;
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      const condition = staticBoolean(node.test);
      collectMutations(node.test, executionPosition);
      if (condition !== false) collectMutations(node.consequent, executionPosition);
      if (condition !== true) collectMutations(node.alternate, executionPosition);
      return;
    }
    if (node.type === "LogicalExpression") {
      const left = resolveImmutable(node.left);
      const condition =
        node.operator === "??"
          ? left.type === "Literal"
            ? left.value == null
            : isDefinitelyNonNullish(left)
              ? false
              : undefined
          : staticBoolean(left);
      collectMutations(node.left, executionPosition);
      if (
        condition === undefined ||
        (node.operator === "&&" ? condition : node.operator === "??" ? condition : !condition)
      )
        collectMutations(node.right, executionPosition);
      return;
    }
    if (node.type === "ExportDefaultDeclaration")
      collectExecutedFunction(calledFunction(node.declaration), node.range[0]);
    if (node.type === "CallExpression") {
      collectExecutedFunction(calledFunction(node.callee), executionPosition ?? node.range[0]);
      if (isConfigHelper(node.callee))
        collectExecutedFunction(
          calledFunction(node.arguments[0]),
          executionPosition ?? node.range[0],
        );
    }
    visitMutation(node, executionPosition);
    for (const key of parsed.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child))
        child.forEach((item: AnyNode) => collectMutations(item, executionPosition));
      else if (child) collectMutations(child, executionPosition);
    }
  }
  collectMutations(parsed.ast);
  for (const scope of scopeManager.scopes) {
    for (const reference of scope.references) {
      const definition = reference.resolved?.defs[0];
      bindingKeys.set(
        reference.identifier.range[0],
        reference.resolved?.defs.length
          ? `binding:${reference.resolved.identifiers[0]?.range[0]}`
          : `global:${reference.identifier.name}`,
      );
      if (
        definition?.type === "ImportBinding" &&
        definition.parent.type === "ImportDeclaration" &&
        ["node:process", "process"].includes(definition.parent.source.value as string) &&
        (["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(definition.node.type) ||
          (definition.node.type === "ImportSpecifier" &&
            propertyName(definition.node.imported) === "default"))
      )
        bindingKeys.set(reference.identifier.range[0], "global:process");
    }
  }
  for (const scope of scopeManager.scopes) {
    for (const reference of scope.references) {
      const definition = reference.resolved?.defs[0];
      if (
        definition?.type === "ImportBinding" &&
        definition.parent.type === "ImportDeclaration" &&
        ["vite", "vitest/config"].includes(definition.parent.source.value as string) &&
        definition.node.type === "ImportNamespaceSpecifier"
      )
        namespaces.add(reference.identifier.range[0]);
      if (reference.identifier.name === "Promise" && definition)
        shadowedPromises.add(reference.identifier.range[0]);
      if (
        definition?.type === "ImportBinding" &&
        definition.parent.type === "ImportDeclaration" &&
        ["vite", "vitest/config"].includes(definition.parent.source.value as string) &&
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
        ["vite", "vitest/config"].includes(init.arguments[0].value as string)
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
        const effective = arrayElementsAt(resolveImmutable(init), reference.identifier.range[0]);
        if (effective === undefined) initializers.set(reference.identifier.range[0], [init.range]);
        else if (effective) initializers.set(reference.identifier.range[0], effective);
      } else if (
        id.type === "ObjectPattern" &&
        init.type === "MemberExpression" &&
        !init.computed &&
        init.property.type === "Identifier" &&
        init.property.name === "env" &&
        ((init.object.type === "Identifier" &&
          bindingKeys.get(init.object.range[0]) === "global:process") ||
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
    if (node.type !== "TemplateElement") nodesByRange.set(node.range.join(":"), node);
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
  function staticKey(property: AnyNode, seen = new Set<AnyNode>()): string | null {
    if (!property.computed) return propertyName(property.key);
    const key = resolve(property.key, new Set(seen));
    if (key?.type === "TemplateLiteral" && key.expressions.length === 0)
      return key.quasis[0].value.cooked;
    return key?.type === "Literal" ? String(key.value) : null;
  }
  function arrayElements(value: AnyNode, seen: Set<AnyNode>): AnyNode[] {
    if (seen.has(value)) return [];
    return value.elements.flatMap((element: AnyNode) => {
      if (element?.type !== "SpreadElement") return [element];
      const spread = resolve(element.argument, new Set(seen));
      return spread?.type === "ArrayExpression"
        ? arrayElements(spread, new Set([...seen, value]))
        : [element];
    });
  }
  function projectBinding(
    pattern: AnyNode,
    input: AnyNode,
    name: string,
    seen: Set<AnyNode>,
  ): AnyNode[] {
    const value = resolve(input, new Set(seen));
    if (pattern.type === "AssignmentPattern") {
      const missing =
        !value ||
        (value.type === "Identifier" &&
          value.name === "undefined" &&
          !references.get(value.range[0])?.resolved) ||
        (value.type === "UnaryExpression" && value.operator === "void");
      return projectBinding(pattern.left, missing ? pattern.right : value, name, seen);
    }
    if (pattern.type === "Identifier") return pattern.name === name && value ? [value] : [];
    if (pattern.type === "ObjectPattern" && value?.type === "ObjectExpression") {
      return pattern.properties.flatMap((property: AnyNode) => {
        if (property.type !== "Property") return [];
        const key = staticKey(property, seen);
        if (key === null) return [];
        const match = readProperties(value, new Set(seen)).findLast(
          (item) => item.type === "Property" && staticKey(item, seen) === key,
        );
        if (match?.kind === "get") {
          const values: AnyNode[] = [];
          const terminates = visitReturnValues(
            match.value.body,
            (returned) => values.push(...projectBinding(property.value, returned, name, seen)),
            () => values.push(...projectBinding(property.value, undefined, name, seen)),
          );
          if (!terminates) values.push(...projectBinding(property.value, undefined, name, seen));
          return values;
        }
        if (match && match.kind !== "init") return [];
        return projectBinding(property.value, match?.value, name, seen);
      });
    }
    if (pattern.type === "ArrayPattern" && value?.type === "ArrayExpression") {
      const elements = arrayElements(value, new Set(seen));
      const firstSpread = elements.findIndex((element) => element?.type === "SpreadElement");
      return pattern.elements.flatMap((element: AnyNode, index: number) => {
        if (!element) return [];
        const start = firstSpread >= 0 ? Math.min(index, firstSpread) : index;
        if (element.type === "RestElement" && firstSpread < 0) {
          if (index === 0) return projectBinding(element.argument, value, name, seen);
          const remainder = elements.slice(index);
          if (!remainder.length) return [];
          const originalStart = remainder[0].range[0];
          const originalEnd = remainder.at(-1).range[1];
          const arrayStart = source.length;
          source += `[${source.slice(originalStart, originalEnd)}]`;
          const shift = arrayStart + 1 - originalStart;
          for (const map of [initializers, bindingKeys, memberReturns, serializationHooks])
            for (const [position, entry] of map)
              if (position >= originalStart && position < originalEnd)
                (map as Map<number, unknown>).set(position + shift, entry);
          const expression = parseForESLint(`(${source.slice(arrayStart)})`, { range: true }).ast
            .body[0] as AnyNode;
          const rest = expression.expression;
          function moveRanges(node: AnyNode) {
            if (!node) return;
            node.range = [node.range[0] + arrayStart - 1, node.range[1] + arrayStart - 1];
            nodesByRange.set(node.range.join(":"), node);
            for (const key of parsed.visitorKeys[node.type] ?? []) {
              const child = node[key];
              if (Array.isArray(child)) child.forEach(moveRanges);
              else if (child) moveRanges(child);
            }
          }
          moveRanges(rest);
          return projectBinding(element.argument, rest, name, seen);
        }
        const candidates =
          element.type === "RestElement" || (firstSpread >= 0 && index >= firstSpread)
            ? [...elements.slice(start), undefined]
            : [elements[index]];
        return candidates.flatMap((candidate) =>
          projectBinding(
            element.type === "RestElement" ? element.argument : element,
            candidate?.type === "SpreadElement" ? candidate.argument : candidate,
            name,
            seen,
          ),
        );
      });
    }
    return [];
  }
  function resolve(node: AnyNode, seen = new Set<AnyNode>()): AnyNode {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "Identifier") {
      const ranges = initializers.get(node.range[0]);
      if (ranges?.length === 1) return resolve(nodesByRange.get(ranges[0]!.join(":")), seen);
      const reference = references.get(node.range[0]);
      const definition = reference?.resolved?.defs[0];
      if (
        reference?.resolved?.defs.length === 1 &&
        definition?.type === "Variable" &&
        definition.parent.kind === "const" &&
        ["ObjectPattern", "ArrayPattern"].includes(definition.node.id.type)
      ) {
        const values = projectBinding(definition.node.id, definition.node.init, node.name, seen);
        if (values.length) {
          initializers.set(
            node.range[0],
            values.map((value) => value.range),
          );
          if (values.length === 1) return values[0];
        }
      }
    }
    if (node.type === "MemberExpression") {
      const object = resolve(node.object, seen);
      const key = node.computed ? resolve(node.property, seen) : node.property;
      const name = key?.type === "Literal" ? String(key.value) : !node.computed ? key?.name : null;
      if (object?.type === "ObjectExpression" && name !== null) {
        const property = readProperties(object, new Set(seen)).findLast(
          (property: AnyNode) => property.type === "Property" && staticKey(property, seen) === name,
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
  for (const reference of references.values()) resolve(reference.identifier);
  for (const object of nodesByRange.values()) {
    if (object.type !== "ObjectExpression") continue;
    const hook = readProperties(object, new Set([object])).findLast(
      (property) => property.type === "Property" && staticKey(property) === "toJSON",
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
    source,
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
  let copiedRanges = false;
  function copyRange(range: Range, bindings: Trace["bindings"]): void {
    if (!copiedRanges) {
      initializers = new Map(initializers);
      memberReturns = new Map(memberReturns);
      serializationHooks = new Map(serializationHooks);
      bindingKeys = new Map(bindingKeys);
      localCalls = new Set(localCalls);
      shadowedPromises = new Set(shadowedPromises);
      copiedRanges = true;
    }
    const start = source.length;
    const text = source.slice(...range);
    const shift = start - range[0];
    source += text;
    for (const map of [initializers, memberReturns, serializationHooks, bindingKeys, bindings]) {
      for (const [position, value] of map) {
        if (position >= range[0] && position < range[1])
          (map as Map<number, unknown>).set(position + shift, value);
      }
    }
    for (const set of [localCalls, shadowedPromises, restReferences]) {
      for (const position of set) {
        if (position >= range[0] && position < range[1]) set.add(position + shift);
      }
    }
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
            : resolved?.type === "TemplateLiteral" && resolved.expressions.length === 0
              ? resolved.quasis[0].value.cooked
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
            node.params.forEach(bindThis);
            bindThis(body);
          }
          const args = callArguments.get(node) ?? [];
          const params = node.params as AnyNode[];
          const bindings = new Map<string, Range[]>();
          function bind(pattern: AnyNode, range?: Range) {
            if (pattern.type === "AssignmentPattern") {
              if (
                !range ||
                (source.slice(...range) === "undefined" &&
                  (range[0] === undefinedRange[0] ||
                    bindingKeys.get(range[0]) === "global:undefined"))
              )
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
                function keyOf(property: AnyNode, offset: number): string | null {
                  if (!property.computed) return propertyName(property.key);
                  const { value } = readValue([
                    offset + property.key.range[0],
                    offset + property.key.range[1],
                  ]);
                  if (value?.type === "TemplateLiteral" && value.expressions.length === 0)
                    return value.quasis[0].value.cooked;
                  return value?.type === "Literal" ? String(value.value) : null;
                }
                const consumed = new Set<string>();
                let unknownConsumed = false;
                for (const property of pattern.properties) {
                  if (property.type === "RestElement") {
                    if (value?.type !== "ObjectExpression" || unknownConsumed) continue;
                    const start = source.length;
                    source += "{";
                    for (const { node, offset } of properties(range)) {
                      const key = keyOf(node, offset);
                      if (key !== null && consumed.has(key)) continue;
                      copyRange([offset + node.range[0], offset + node.range[1]], current.bindings);
                      source += ",";
                    }
                    source += "}";
                    bind(property.argument, [start, source.length]);
                    continue;
                  }
                  if (property.type !== "Property") continue;
                  const key = keyOf(property, current.start - 1);
                  if (key !== null) consumed.add(key);
                  else unknownConsumed = true;
                  const match =
                    value?.type === "ObjectExpression" && key !== null
                      ? properties(range).findLast(
                          ({ node: item, offset }) =>
                            item.type === "Property" && keyOf(item, offset) === key,
                        )
                      : undefined;
                  if (match?.node.kind === "get") {
                    const outcomes: Array<Range | undefined> = [];
                    const terminates = visitReturnValues(
                      match.node.value.body,
                      (returned) =>
                        outcomes.push([
                          match.offset + returned.range[0],
                          match.offset + returned.range[1],
                        ]),
                      () => outcomes.push(undefined),
                    );
                    if (!terminates) outcomes.push(undefined);
                    const alternatives = new Map<string, Range[]>();
                    for (const outcome of outcomes) {
                      bind(property.value, outcome);
                      for (const [name, ranges] of bindings)
                        alternatives.set(name, [...(alternatives.get(name) ?? []), ...ranges]);
                    }
                    for (const [name, ranges] of alternatives) bindings.set(name, ranges);
                  } else
                    bind(
                      property.value,
                      match?.node.kind === "init"
                        ? [
                            match.offset + match.node.value.range[0],
                            match.offset + match.node.value.range[1],
                          ]
                        : undefined,
                    );
                }
              } else {
                pattern.elements.forEach((element: AnyNode, index: number) => {
                  if (element?.type === "RestElement" && value?.type === "ArrayExpression") {
                    const remaining = value.elements.slice(index).filter(Boolean);
                    const start = source.length;
                    source += "[";
                    remaining.forEach((item: AnyNode, position: number) => {
                      if (position) source += ",";
                      copyRange([offset + item.range[0], offset + item.range[1]], current.bindings);
                    });
                    source += "]";
                    bind(element.argument, [start, source.length]);
                    return;
                  }
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
            receiver:
              property.node.kind === "get"
                ? [current.start + node.range[0] - 1, current.start + node.range[1] - 1]
                : undefined,
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
        function expandArguments(
          args: AnyNode[],
          offset: number,
          seen = new Set<number>(),
        ): Range[] {
          return args.flatMap((argument): Range[] => {
            if (!argument) return [undefinedRange];
            const range: Range = [offset + argument.range[0], offset + argument.range[1]];
            if (argument.type !== "SpreadElement") return [range];
            const value = readValue(
              [offset + argument.argument.range[0], offset + argument.argument.range[1]],
              current.bindings,
            );
            if (value?.node.type !== "ArrayExpression" || seen.has(value.offset)) return [range];
            return expandArguments(
              value.node.elements,
              value.offset,
              new Set([...seen, value.offset]),
            );
          });
        }
        callArguments.set(node.callee, expandArguments(node.arguments, current.start - 1));
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
        const key =
          node.key?.type === "TemplateLiteral" && node.key.expressions.length === 0
            ? node.key.quasis[0].value.cooked
            : propertyName(node.key);
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
  const entries: Array<{
    key: string;
    rawValue: string;
    valueStart: number;
    range: SourceRange;
    valueNode: AnyNode;
    traceValues?: Array<{ rawValue: string; valueStart: number }>;
  }> = [];
  const { initializers, bindingKeys, configHelpers, mergeHelpers, shadowedPromises, localCalls } =
    readAliasInitializers(text);
  const nodesByRange = new Map<string, AnyNode>();
  walkScriptLocal(program, (node) => {
    if (node.type !== "TemplateElement") nodesByRange.set(`${node.start}:${node.end}`, node);
  });
  function nullish(node: AnyNode) {
    return (
      (node?.type === "Literal" && node.value === null) ||
      (node?.type === "Identifier" &&
        node.name === "undefined" &&
        bindingKeys.get(node.start) === "global:undefined") ||
      (node?.type === "UnaryExpression" && node.operator === "void")
    );
  }
  function propertyValues(property: AnyNode): AnyNode[] {
    if (property.kind !== "get") return [property.value];
    const values: AnyNode[] = [];
    visitReturnValues(property.value.body, (value) => values.push(resolve(value)));
    return values;
  }
  function effectiveProperty(property: AnyNode): AnyNode {
    if (property.kind !== "get") return property;
    const values: AnyNode[] = [];
    const undefinedValue = {
      type: "UnaryExpression",
      operator: "void",
      argument: { type: "Literal", value: 0 },
    };
    mergedNodes.add(undefinedValue);
    const onUndefined = () => values.push(undefinedValue);
    if (
      !visitReturnValues(property.value.body, (value) => values.push(resolve(value)), onUndefined)
    )
      onUndefined();
    if (!values.length) return property;
    const value = values.reduce((consequent, alternate) => {
      const alternative = { type: "ConditionalExpression", consequent, alternate };
      mergedNodes.add(alternative);
      return alternative;
    });
    return { ...property, kind: "init", value };
  }
  const mergedNodes = new Set<AnyNode>();
  function mergeValue(base: AnyNode, override: AnyNode): AnyNode {
    base = resolve(base);
    override = resolve(override);
    if (nullish(override)) return base;
    if (nullish(base)) return override;
    let result: AnyNode;
    if (base?.type === "ConditionalExpression" && mergedNodes.has(base)) {
      result = {
        ...base,
        consequent: mergeValue(base.consequent, override),
        alternate: mergeValue(base.alternate, override),
      };
    } else if (override?.type === "ConditionalExpression" && mergedNodes.has(override)) {
      result = {
        ...override,
        consequent: mergeValue(base, override.consequent),
        alternate: mergeValue(base, override.alternate),
      };
    } else if (
      ![
        "Literal",
        "ObjectExpression",
        "ArrayExpression",
        "FunctionExpression",
        "ArrowFunctionExpression",
        "TemplateLiteral",
        "BinaryExpression",
        "UnaryExpression",
      ].includes(override?.type)
    ) {
      result = { type: "ConditionalExpression", consequent: base, alternate: override };
    } else if (base?.type === "ArrayExpression" || override?.type === "ArrayExpression") {
      result = {
        type: "ArrayExpression",
        elements: [
          ...(base?.type === "ArrayExpression" ? base.elements : [base]),
          ...(override?.type === "ArrayExpression" ? override.elements : [override]),
        ],
      };
    } else if (base?.type === "ObjectExpression" && override?.type === "ObjectExpression") {
      const properties = new Map<unknown, AnyNode>();
      for (const property of readOptions(base))
        properties.set(keyOf(property) ?? property, effectiveProperty(property));
      const overrides = new Map<unknown, AnyNode>();
      for (const property of readOptions(override))
        overrides.set(keyOf(property) ?? property, effectiveProperty(property));
      for (const [key, property] of overrides) {
        if (property.kind === "init" && nullish(resolve(property.value))) continue;
        const previous = properties.get(key);
        properties.set(
          key,
          previous?.kind === "init" && property.kind === "init"
            ? {
                ...property,
                value: mergeValue(previous.value, property.value),
              }
            : property,
        );
      }
      result = { type: "ObjectExpression", properties: [...properties.values()] };
    } else return override;
    mergedNodes.add(result);
    return result;
  }
  function traceValues(node: AnyNode): Array<{ rawValue: string; valueStart: number }> {
    if (!node) return [];
    if (!mergedNodes.has(node))
      return [{ rawValue: text.slice(node.start, node.end), valueStart: node.start }];
    if (node.type === "UnaryExpression" && node.operator === "void") return [];
    if (node.type === "ConditionalExpression")
      return [...traceValues(node.consequent), ...traceValues(node.alternate)];
    return node.type === "ArrayExpression"
      ? node.elements.flatMap(traceValues)
      : node.properties.flatMap((property: AnyNode) =>
          property.type === "Property"
            ? [...traceValues(property.key), ...traceValues(property.value)]
            : traceValues(property.argument),
        );
  }
  function mergeEntries(base: typeof entries, override: typeof entries): typeof entries {
    const result = new Map(base.map((entry) => [entry.key, entry]));
    for (const entry of override) {
      if (nullish(resolve(entry.valueNode))) continue;
      const previous = result.get(entry.key);
      if (!previous) result.set(entry.key, entry);
      else {
        const valueNode = mergeValue(previous.valueNode, entry.valueNode);
        result.set(entry.key, {
          ...entry,
          valueNode,
          traceValues: traceValues(valueNode),
          rawValue: mergedNodes.has(valueNode)
            ? valueNode.type === "ArrayExpression"
              ? "[]"
              : "{}"
            : text.slice(valueNode.start, valueNode.end),
          valueStart: valueNode.start,
        });
      }
    }
    return [...result.values()];
  }
  const seen = new Set<AnyNode>();
  function resolve(node: AnyNode, visited = new Set<AnyNode>()): AnyNode {
    while (node && !visited.has(node)) {
      visited.add(node);
      if (
        (node.type.startsWith("TS") || node.type === "ParenthesizedExpression") &&
        node.expression
      )
        node = node.expression;
      else if (node.type === "SequenceExpression") node = node.expressions.at(-1);
      else if (node.type === "Identifier" || node.type === "ThisExpression") {
        const ranges = initializers.get(node.start);
        if (ranges?.length !== 1) break;
        node = nodesByRange.get(ranges[0]!.join(":"));
      } else if (
        node.type === "CallExpression" &&
        memberPath(node.callee) === "Object.assign" &&
        bindingKeys.get(node.callee.object.start) === "global:Object" &&
        node.arguments.length > 0 &&
        node.arguments.every(
          (argument: AnyNode) => resolve(argument, new Set(visited))?.type === "ObjectExpression",
        )
      ) {
        node = {
          type: "ObjectExpression",
          properties: node.arguments.map((argument: AnyNode) => ({
            type: "SpreadElement",
            argument,
          })),
        };
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
            (item) =>
              item.type === "SpreadElement" || (item.type === "Property" && keyOf(item) === key),
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
      option.type === "SpreadElement"
        ? resolve(option.argument)?.type === "ObjectExpression"
          ? readOptions(option.argument, visited)
          : [option]
        : [option],
    );
    visited.delete(node);
    return options;
  }
  function conditional(node: AnyNode): AnyNode {
    node = resolve(node);
    if (node?.type === "ConditionalExpression") return node;
    if (node?.type !== "LogicalExpression") return;
    const left = resolve(node.left);
    if (node.operator === "??") {
      if (nullish(left))
        return {
          type: "ConditionalExpression",
          test: { type: "Literal", value: true },
          consequent: node.right,
          alternate: node.left,
        };
      if (left?.type === "Literal")
        return {
          type: "ConditionalExpression",
          test: { type: "Literal", value: true },
          consequent: node.left,
          alternate: node.right,
        };
    }
    return {
      type: "ConditionalExpression",
      test:
        node.operator === "??"
          ? {
              type: "BinaryExpression",
              operator: "==",
              left: node.left,
              right: { type: "Literal", value: null },
            }
          : node.left,
      consequent: node.operator === "||" ? node.left : node.right,
      alternate: node.operator === "||" ? node.right : node.left,
    };
  }
  function expandSpread(node: AnyNode): AnyNode {
    if (node?.type !== "ObjectExpression") return;
    const properties = readOptions(node);
    for (const [index, property] of properties.entries()) {
      if (property.type !== "SpreadElement") continue;
      const branch = conditional(property.argument);
      if (!branch) continue;
      const replace = (argument: AnyNode) => ({
        ...node,
        properties: properties.map((item, offset) =>
          offset === index ? { ...property, argument } : item,
        ),
      });
      return {
        ...branch,
        consequent: replace(branch.consequent),
        alternate: replace(branch.alternate),
      };
    }
  }
  type Alternative = { entries: typeof entries; predicates: Map<string, boolean> };
  function readConfig(input: AnyNode): Alternative[] {
    const empty = () => [{ entries: [], predicates: new Map<string, boolean>() }];
    const node = resolve(input);
    if (!node || seen.has(node)) return empty();
    seen.add(node);
    try {
      if (node.type === "MemberExpression") {
        const property = node.computed ? resolve(node.property) : node.property;
        const key = node.computed
          ? property?.type === "TemplateLiteral" && property.expressions.length === 0
            ? property.quasis[0].value.cooked
            : property?.type === "Literal"
              ? String(property.value)
              : null
          : propertyName(property);
        if (key === null) return empty();
        const project = (object: AnyNode): Alternative[] => {
          const value = resolve(object);
          if (!value || seen.has(value)) return empty();
          seen.add(value);
          try {
            if (value?.type === "ConditionalExpression")
              return readConfig({
                ...value,
                consequent: { ...node, object: value.consequent },
                alternate: { ...node, object: value.alternate },
              });
            if (value?.type !== "ObjectExpression") return empty();
            const alternatives: Alternative[] = [];
            for (const option of readOptions(value).toReversed()) {
              if (option.type === "SpreadElement") {
                alternatives.push(...readConfig({ ...node, object: option.argument }));
              } else if (keyOf(option) === key) {
                if (option.kind === "get") {
                  const previous = new Map<number, [number, number][] | undefined>();
                  const bindReceiver = (child: AnyNode) => {
                    if (
                      !child ||
                      ["FunctionExpression", "FunctionDeclaration"].includes(child.type)
                    )
                      return;
                    if (child.type === "ThisExpression") {
                      previous.set(child.start, initializers.get(child.start));
                      initializers.set(child.start, [[value.start, value.end]]);
                    }
                    for (const part of Object.values(child)) {
                      if (Array.isArray(part)) part.forEach(bindReceiver);
                      else if (part && typeof part === "object") bindReceiver(part);
                    }
                  };
                  bindReceiver(option.value.body);
                  try {
                    alternatives.push(...readConfig(option.value));
                  } finally {
                    for (const [position, ranges] of previous) {
                      if (ranges) initializers.set(position, ranges);
                      else initializers.delete(position);
                    }
                  }
                } else if (option.kind === "init") alternatives.push(...readConfig(option.value));
                break;
              }
            }
            return alternatives.length ? alternatives : empty();
          } finally {
            seen.delete(value);
          }
        };
        return project(node.object);
      }
      if (node.type === "CallExpression" && mergeHelpers.has(resolve(node.callee)?.start)) {
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
                entries: mergeEntries(base.entries, override.entries),
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
              (value.type === "Identifier" &&
                value.name === "undefined" &&
                bindingKeys.get(value.start) === "global:undefined") ||
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
            const consumed = new Set<string>();
            let unknownConsumed = false;
            for (const property of pattern.properties) {
              if (property.type === "RestElement") {
                if (value?.type !== "ObjectExpression" || unknownConsumed) continue;
                const start = -nodesByRange.size - 1;
                const rest = {
                  type: "ObjectExpression",
                  properties: readOptions(value).filter(
                    (item) => item.type !== "Property" || !consumed.has(keyOf(item) ?? ""),
                  ),
                  start,
                  end: start,
                };
                nodesByRange.set(`${start}:${start}`, rest);
                bind(property.argument, rest);
                continue;
              }
              if (property.type !== "Property") continue;
              const key = keyOf(property);
              if (key !== null) consumed.add(key);
              else unknownConsumed = true;
              const match =
                value?.type === "ObjectExpression"
                  ? readOptions(value).findLast(
                      (item) => item.type === "Property" && keyOf(item) === key,
                    )
                  : undefined;
              if (match?.kind === "get") {
                const bindGetterThis = (child: AnyNode) => {
                  if (!child || ["FunctionExpression", "FunctionDeclaration"].includes(child.type))
                    return;
                  if (child.type === "ThisExpression") {
                    if (!previous.has(child.start))
                      previous.set(child.start, initializers.get(child.start));
                    initializers.set(child.start, [[value.start, value.end]]);
                  }
                  for (const part of Object.values(child)) {
                    if (Array.isArray(part)) part.forEach(bindGetterThis);
                    else if (part && typeof part === "object") bindGetterThis(part);
                  }
                };
                bindGetterThis(match.value.body);
              }
              const projected = match ? effectiveProperty(match).value : undefined;
              if (projected && mergedNodes.has(projected)) {
                const start = -nodesByRange.size - 1;
                projected.start = start;
                projected.end = start;
                nodesByRange.set(`${start}:${start}`, projected);
              }
              bind(property.value, projected);
            }
          } else if (pattern.type === "ArrayPattern") {
            pattern.elements.forEach((element: AnyNode, index: number) => {
              if (element?.type === "RestElement" && value?.type === "ArrayExpression") {
                const start = -nodesByRange.size - 1;
                const rest = {
                  type: "ArrayExpression",
                  elements: expandArguments(value.elements).slice(index),
                  start,
                  end: start,
                };
                nodesByRange.set(`${start}:${start}`, rest);
                bind(element.argument, rest);
              } else if (element)
                bind(
                  element,
                  value?.type === "ArrayExpression"
                    ? expandArguments(value.elements)[index]
                    : undefined,
                );
            });
          }
        }
        function expandArguments(args: AnyNode[], seen = new Set<AnyNode>()): AnyNode[] {
          return args.flatMap((argument) => {
            if (argument?.type !== "SpreadElement") return [argument];
            const value = resolve(argument.argument);
            if (value?.type !== "ArrayExpression" || seen.has(value)) return [argument];
            return expandArguments(value.elements, new Set([...seen, value]));
          });
        }
        const args = expandArguments(node.arguments);
        callee.params.forEach((parameter: AnyNode, index: number) => {
          if (parameter.type === "RestElement") {
            const start = -nodesByRange.size - 1;
            const value = {
              type: "ArrayExpression",
              elements: args.slice(index),
              start,
              end: start,
            };
            nodesByRange.set(`${start}:${start}`, value);
            bind(parameter.argument, value);
          } else bind(parameter, args[index]);
        });
        if (callee.type !== "ArrowFunctionExpression" && node.callee.type === "MemberExpression") {
          const receiver = resolve(node.callee.object);
          const bindThis = (child: AnyNode) => {
            if (!child || ["FunctionExpression", "FunctionDeclaration"].includes(child.type))
              return;
            if (child.type === "ThisExpression" && receiver) {
              previous.set(child.start, initializers.get(child.start));
              initializers.set(child.start, [[receiver.start, receiver.end]]);
            }
            for (const value of Object.values(child)) {
              if (Array.isArray(value))
                value.forEach((item) => {
                  if (item && typeof item === "object") bindThis(item);
                });
              else if (value && typeof value === "object") bindThis(value);
            }
          };
          callee.params.forEach(bindThis);
          bindThis(callee.body);
        }
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
        (configHelpers.has(resolve(node.callee)?.start) ||
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
      } else if (node.type === "LogicalExpression") {
        return readConfig(conditional(node));
      } else if (node.type === "ConditionalExpression") {
        const test = resolve(node.test);
        if (test?.type === "Literal")
          return readConfig(test.value ? node.consequent : node.alternate);
        let predicate = node.test;
        let inverted = false;
        const isNullish =
          predicate?.type === "BinaryExpression" &&
          predicate.operator === "==" &&
          predicate.right?.value === null;
        if (isNullish) predicate = predicate.left;
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
        const binding =
          predicate?.type === "Identifier" ? bindingKeys.get(predicate.start) : undefined;
        const key = binding && isNullish ? `nullish:${binding}` : binding;
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
        const expanded = expandSpread(node);
        if (expanded) return readConfig(expanded);
        const result: typeof entries = [];
        const option = readOptions(node).findLast(
          (option) => option.type === "Property" && keyOf(option) === "define",
        );
        if (option) {
          if (option.kind === "get")
            return propertyValues(option).flatMap((value) =>
              readConfig({
                ...node,
                properties: [{ ...option, kind: "init", value }],
              }),
            );
          const values = resolve(option.value);
          if (values?.type !== "ObjectExpression") return empty();
          const expandedValues = expandSpread(values);
          if (expandedValues) {
            const replace = (value: AnyNode) => ({ ...node, properties: [{ ...option, value }] });
            return readConfig({
              ...expandedValues,
              consequent: replace(expandedValues.consequent),
              alternate: replace(expandedValues.alternate),
            });
          }
          const properties = new Map<string, AnyNode>();
          for (const property of readOptions(values)) {
            if (property.type !== "Property") continue;
            const key = keyOf(property);
            if (key !== null) properties.set(key, property);
          }
          for (const [key, property] of properties) {
            for (const value of propertyValues(property)) {
              const valueStart = value.start;
              result.push({
                key,
                valueNode: value,
                rawValue: text.slice(valueStart, value.end),
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
    else if (statement.type === "TSExportAssignment")
      entries.push(
        ...readConfig(statement.expression).flatMap((alternative) => alternative.entries),
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

function staticBoolean(node: AnyNode): boolean | undefined {
  if (node?.type === "Literal") return Boolean(node.value);
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return Boolean(node.quasis[0].value.cooked);
  if (isDefinitelyNonNullish(node)) return true;
  if (node?.type === "UnaryExpression" && node.operator === "!") {
    const value = staticBoolean(node.argument);
    if (value !== undefined) return !value;
  }
}

function isDefinitelyNonNullish(node: AnyNode): boolean {
  return (
    [
      "ObjectExpression",
      "ArrayExpression",
      "FunctionExpression",
      "ArrowFunctionExpression",
      "ClassExpression",
    ].includes(node?.type) ||
    (node?.type === "TemplateLiteral" && node.expressions.length === 0)
  );
}

function visitReturnValues(
  node: AnyNode,
  visit: (value: AnyNode) => void,
  onUndefined: () => void = () => {},
  labels: string[] = [],
): boolean {
  if (!node || typeof node !== "object") return false;
  if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type))
    return false;
  if (node.type === "ReturnStatement") {
    if (node.argument) visit(node.argument);
    else onUndefined();
    return true;
  }
  if (["ThrowStatement", "BreakStatement", "ContinueStatement"].includes(node.type)) return true;
  if (node.type === "BlockStatement") {
    for (const statement of node.body) {
      if (visitReturnValues(statement, visit, onUndefined)) return true;
    }
    return false;
  }
  if (node.type === "TryStatement") {
    const finalReturns: AnyNode[] = [];
    let finalUndefined = false;
    const finalTerminates = visitReturnValues(
      node.finalizer,
      (value) => finalReturns.push(value),
      () => {
        finalUndefined = true;
      },
    );
    if (finalTerminates) {
      finalReturns.forEach(visit);
      if (finalUndefined) onUndefined();
      return true;
    }
    const bodyTerminates = visitReturnValues(node.block, visit, onUndefined);
    const catchTerminates = node.handler
      ? visitReturnValues(node.handler.body, visit, onUndefined)
      : true;
    finalReturns.forEach(visit);
    if (finalUndefined) onUndefined();
    return bodyTerminates && catchTerminates;
  }
  if (
    ["WhileStatement", "ForStatement"].includes(node.type) &&
    node.test?.type === "Literal" &&
    !node.test.value
  )
    return false;
  if (
    ["WhileStatement", "ForStatement", "DoWhileStatement"].includes(node.type) &&
    ((node.test?.type === "Literal" && node.test.value === true) ||
      (node.type === "ForStatement" && !node.test))
  ) {
    visitReturnValues(node.body, visit, onUndefined);
    return !hasExitingBreak(node.body, new Set(labels));
  }
  if (node.type === "LabeledStatement") {
    const terminates = visitReturnValues(node.body, visit, onUndefined, [
      ...labels,
      node.label.name,
    ]);
    return terminates && !hasExitingBreak(node.body, new Set([node.label.name]), false);
  }
  if (node.type === "SwitchStatement") {
    if (
      node.discriminant.type === "Literal" &&
      node.cases.every((branch: AnyNode) => branch.test === null || branch.test.type === "Literal")
    ) {
      let index = node.cases.findIndex(
        (branch: AnyNode) => branch.test?.value === node.discriminant.value && branch.test !== null,
      );
      if (index < 0) index = node.cases.findIndex((branch: AnyNode) => branch.test === null);
      if (index < 0) return false;
      const body = {
        type: "BlockStatement",
        body: node.cases.slice(index).flatMap((branch: AnyNode) => branch.consequent),
      };
      const terminates = visitReturnValues(body, visit, onUndefined);
      return terminates && !hasExitingBreak(body, new Set());
    }
    let nextTerminates = false;
    let allTerminate = true;
    for (const branch of [...node.cases].reverse()) {
      const body = { type: "BlockStatement", body: branch.consequent };
      const terminates = visitReturnValues(body, visit, onUndefined);
      nextTerminates = !hasExitingBreak(body, new Set()) && (terminates || nextTerminates);
      allTerminate &&= nextTerminates;
    }
    return node.cases.some((branch: AnyNode) => branch.test === null) && allTerminate;
  }
  if (node.type === "IfStatement") {
    const condition = staticBoolean(node.test);
    if (condition !== undefined)
      return visitReturnValues(condition ? node.consequent : node.alternate, visit, onUndefined);
    const consequent = visitReturnValues(node.consequent, visit, onUndefined);
    const alternate = visitReturnValues(node.alternate, visit, onUndefined);
    return consequent && alternate;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value))
      value.forEach((child) => visitReturnValues(child, visit, onUndefined));
    else if (value && typeof value === "object") visitReturnValues(value, visit, onUndefined);
  }
  return false;
}

function hasExitingBreak(node: AnyNode, labels: Set<string>, unlabeled = true): boolean {
  if (!node || typeof node !== "object") return false;
  if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type))
    return false;
  if (node.type === "BreakStatement") return node.label ? labels.has(node.label.name) : unlabeled;
  if (node.type === "TryStatement") {
    if (hasExitingBreak(node.finalizer, labels, unlabeled)) return true;
    if (visitReturnValues(node.finalizer, () => {})) return false;
    return (
      hasExitingBreak(node.block, labels, unlabeled) ||
      hasExitingBreak(node.handler?.body, labels, unlabeled)
    );
  }
  if (node.type === "IfStatement" && node.test.type === "Literal")
    return hasExitingBreak(node.test.value ? node.consequent : node.alternate, labels, unlabeled);
  if (
    ["WhileStatement", "ForStatement"].includes(node.type) &&
    node.test?.type === "Literal" &&
    !node.test.value
  )
    return false;
  if (node.type === "BlockStatement") {
    for (const statement of node.body) {
      if (hasExitingBreak(statement, labels, unlabeled)) return true;
      if (visitReturnValues(statement, () => {})) break;
    }
    return false;
  }
  if (
    [
      "WhileStatement",
      "ForStatement",
      "DoWhileStatement",
      "ForInStatement",
      "ForOfStatement",
      "SwitchStatement",
    ].includes(node.type)
  )
    unlabeled = false;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some((child) => hasExitingBreak(child, labels, unlabeled))
        : hasExitingBreak(value, labels, unlabeled)),
  );
}
