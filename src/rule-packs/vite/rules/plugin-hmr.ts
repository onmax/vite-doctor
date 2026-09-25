import { createRule } from "../../../core/index.js";
import { isViteConfigFile, memberPath, type AnyNode } from "./shared.js";
import { diagnostics } from "../../../diagnostics.js";

export const requirePluginName = createRule({
  meta: {
    id: "vite/plugin/require-name",
    title: "Name Vite plugins",
    category: "plugins",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/api-plugin.html#authoring-a-plugin",
    requires: { script: true },
  },
  create(ctx) {
    if (!isPluginSource(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!isPluginObject(node)) return;
        const hasName = (node.properties ?? []).some(
          (property: AnyNode) => property.key?.name === "name",
        );
        if (hasName) return;
        ctx.report(
          diagnostics.VITE0015({
            why: "Inline Vite plugin objects should declare a stable name.",
            fix: "Add a name property so Vite logs, ordering, and diagnostics are traceable.",
          }),
          {
            ruleId: "vite/plugin/require-name",
            severity: ctx.severity,
            category: "plugins",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const preferTransformFilter = createRule({
  meta: {
    id: "vite/plugin/prefer-transform-filter",
    title: "Filter broad Vite plugin transforms",
    category: "plugins",
    severity: "info",
    docsUrl: "https://vite.dev/guide/api-plugin.html#hook-filters",
    requires: { script: true },
  },
  create(ctx) {
    if (!isPluginSource(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!isTransformProperty(node)) return;
        const value = node.value;
        const source = ctx.file.text.slice(node.start ?? 0, node.end ?? 0);
        if (value?.params?.length >= 2 || /\bfilter\s*:/.test(source)) return;
        ctx.report(
          diagnostics.VITE0014({
            why: "Vite plugin transform hooks should filter by module id.",
            fix: "Accept the id parameter and skip files this plugin does not transform.",
          }),
          {
            ruleId: "vite/plugin/prefer-transform-filter",
            severity: ctx.severity,
            category: "plugins",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const requireDisposeForSideEffects = createRule({
  meta: {
    id: "vite/hmr/require-dispose-for-side-effects",
    title: "Dispose HMR side effects",
    category: "hmr",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/api-hmr.html#hot-dispose-cb",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        if (isServerSidePath(ctx.file.relativePath) || isFixturePath(ctx.file.relativePath)) return;
        const text = stripCommentsAndStrings(ctx.file.text);
        if (!/import\.meta\.hot\.accept\s*\(/.test(text)) return;
        const hasDispose = /import\.meta\.hot(?:\?\.|\.)dispose(?:\?\.)?\s*\(/.test(text);
        const undisposed = hasDispose ? undisposedResource(node) : null;
        if (hasDispose && !undisposed) return;
        if (
          !undisposed &&
          !/(addEventListener|setInterval|setTimeout|new\s+WebSocket|EventSource\s*\(|\.subscribe\s*\()/.test(
            text,
          )
        )
          return;
        ctx.report(
          diagnostics.VITE0013({
            why: undisposed
              ? `This HMR-accepting module does not dispose its ${undisposed} resource.`
              : "This HMR-accepting module creates side effects without a hot dispose handler.",
            fix: "Clean up listeners, timers, and sockets in import.meta.hot.dispose().",
          }),
          {
            ruleId: "vite/hmr/require-dispose-for-side-effects",
            severity: ctx.severity,
            category: "hmr",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

function undisposedResource(program: AnyNode): string | null {
  const resolve = resourceBindings(program);
  type Resource = { value: AnyNode; kind: string; cleanup: string; method: boolean };
  type Listener = {
    receiver: AnyNode;
    event: unknown;
    handler: AnyNode;
    capture: unknown;
    controller: AnyNode;
    value: AnyNode;
    once: boolean;
    path: Map<object, boolean>;
  };
  type Completion = { normal: boolean; abrupt: boolean; value?: AnyNode; suspended?: boolean };
  const resources: Resource[] = [];
  const knownTruthyResource = (value: AnyNode): boolean =>
    resources.some(
      (resource) =>
        resource.value === value &&
        ["interval", "timeout", "WebSocket", "EventSource"].includes(resource.kind),
    );
  const repeated = new Set<AnyNode>();
  let loopDepth = 0;
  const listeners: Listener[] = [];
  const abortedControllers = new Map<AnyNode, Map<object, boolean>[]>();
  const thisBinding = {};
  const lexicalReceivers = new Map<AnyNode, AnyNode>();
  const lexicalEnvironments = new Map<AnyNode, Map<AnyNode, AnyNode>>();
  const promises = new Map<AnyNode, AnyNode>();
  const promiseCompletions = new Map<AnyNode, Completion>();
  const pendingFetchPromises = new Set<AnyNode>();
  const pendingUserPromises = new Set<AnyNode>();
  const lateReactions: {
    callback: AnyNode;
    args: AnyNode[];
    environment: Map<AnyNode, AnyNode>;
  }[] = [];
  const microtasks: {
    callback?: AnyNode;
    args?: AnyNode[];
    environment: Map<AnyNode, AnyNode>;
    result?: AnyNode;
    resumeAwait?: boolean;
    task?: () => void;
  }[] = [];
  const subscriptions: { callback: AnyNode; environment: Map<AnyNode, AnyNode> }[] = [];
  const promiseSettlers = new Map<AnyNode, (value: AnyNode) => void>();
  const pendingPromiseReactions = new Map<
    AnyNode,
    {
      fulfilled?: AnyNode;
      rejected?: AnyNode;
      finally?: AnyNode;
      environment: Map<AnyNode, AnyNode>;
      result: AnyNode;
      resumeAwait?: boolean;
      settled?: () => void;
    }[]
  >();
  const enqueueReactions = (promise: AnyNode, completion: Completion) => {
    for (const reaction of pendingPromiseReactions.get(promise) ?? []) {
      if (reaction.finally) {
        microtasks.push({
          environment: reaction.environment,
          task: () => {
            const final = adoptPromise(inspect(reaction.finally, [], reaction.environment, true));
            const settled = final.abrupt
              ? { normal: completion.normal && final.normal, abrupt: true, value: final.value }
              : completion;
            promiseCompletions.set(reaction.result, settled);
            if (settled.normal) promises.set(reaction.result, settled.value);
            enqueueReactions(reaction.result, settled);
          },
        });
        continue;
      }
      if (reaction.settled) {
        microtasks.push({ environment: reaction.environment, task: reaction.settled });
        continue;
      }
      if (completion.normal && completion.abrupt) {
        const response = (callback: AnyNode, fulfilled: boolean): AnyNode =>
          callback
            ? {
                type: "ReturnStatement",
                argument: {
                  type: "CallExpression",
                  callee: callback,
                  arguments: [completion.value],
                },
              }
            : fulfilled
              ? { type: "ReturnStatement", argument: completion.value }
              : { type: "ThrowStatement", argument: completion.value };
        microtasks.push({
          callback: {
            type: "ArrowFunctionExpression",
            params: [],
            body: {
              type: "BlockStatement",
              body: [
                {
                  type: "IfStatement",
                  test: { type: "Identifier", name: "__doctorMixedPromiseSettlement" },
                  consequent: response(reaction.fulfilled, true),
                  alternate: response(reaction.rejected, false),
                },
              ],
            },
          },
          environment: reaction.environment,
          result: reaction.result,
          resumeAwait: reaction.resumeAwait,
          args: [completion.value],
        });
        continue;
      }
      const callback = completion.normal ? reaction.fulfilled : reaction.rejected;
      if (callback)
        microtasks.push({
          callback,
          environment: reaction.environment,
          result: reaction.result,
          resumeAwait: reaction.resumeAwait,
          args: [completion.value],
        });
      else
        microtasks.push({
          environment: reaction.environment,
          task: () => {
            promiseCompletions.set(reaction.result, completion);
            if (completion.normal) promises.set(reaction.result, completion.value);
            enqueueReactions(reaction.result, completion);
          },
        });
    }
  };
  const pendingTimeouts: {
    timeout: AnyNode;
    callback: AnyNode;
    args: AnyNode[];
    environment: Map<AnyNode, AnyNode>;
    delay: AnyNode;
  }[] = [];
  let timerSimulationDepth = 0;
  const setCollections = new Set<AnyNode>();
  const mapCollections = new Set<AnyNode>();
  const sameMapKey = (left: AnyNode, right: AnyNode): boolean =>
    left === right ||
    (left?.type === "Literal" && right?.type === "Literal" && Object.is(left.value, right.value));
  const setIterations = new Map<AnyNode, AnyNode[][]>();
  let truncatedSetIteration = false;
  const arrayChoices = new Map<AnyNode, { array: AnyNode; path: Map<object, boolean> }[]>();
  const alternatives = new Map<AnyNode, AnyNode[]>();
  const callbackChoices = new Map<AnyNode, AnyNode[]>();
  const superConstructors = new Map<AnyNode, (args: AnyNode[]) => Completion>();
  const values = new Map<AnyNode, AnyNode>();
  const returned = new Map<AnyNode, AnyNode>();
  const optionalSkipped = new Set<AnyNode>();
  const callbacks = new Map<AnyNode, AnyNode>();
  const properties = new Map<AnyNode, Map<string, AnyNode>>();
  const classGetters = new Map<AnyNode, Map<string, AnyNode>>();
  const classSetters = new Map<AnyNode, Map<string, AnyNode>>();
  const members = new Map<AnyNode, Map<string, AnyNode>>();
  const propertyKey = (node: AnyNode, environment = values): string | undefined => {
    const property = node?.computed ? identity(node.property, environment) : node?.property;
    const key = node?.computed ? property?.value : property?.name;
    return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
  };
  const definitionKey = (node: AnyNode, environment = values): string | undefined => {
    const key = node.computed
      ? identity(node.key, environment)?.value
      : (node.key?.name ?? node.key?.value);
    return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
  };
  const effectiveProperties = (
    source: AnyNode,
    environment: Map<AnyNode, AnyNode>,
    seen = new Set<AnyNode>(),
  ): Map<string, { property: AnyNode; receiver: AnyNode; accessor: boolean }> => {
    source = identity(source, environment);
    const result = new Map<string, { property: AnyNode; receiver: AnyNode; accessor: boolean }>();
    if (source?.type !== "ObjectExpression" || seen.has(source)) return result;
    seen.add(source);
    for (const property of source.properties) {
      if (property.type === "SpreadElement") {
        for (const [key, descriptor] of effectiveProperties(property.argument, environment, seen))
          result.set(key, { ...descriptor, accessor: false });
      } else {
        const key = definitionKey(property, environment);
        if (key !== undefined) result.set(key, { property, receiver: source, accessor: true });
      }
    }
    seen.delete(source);
    return result;
  };
  const cleaned = new Set<AnyNode>();
  const visited = new Set<AnyNode>();
  type Disposer = { callback: AnyNode; path: Map<object, boolean> };
  let currentPath = new Map<object, boolean>();
  const conditions = new Map<AnyNode, object>();
  const resourcePaths = new Map<AnyNode, Map<object, boolean>>();
  let disposers: Disposer[] = [{ callback: undefined, path: new Map() }];
  const arrayElements = (array: AnyNode, state = properties): AnyNode[] => {
    const stored = state.get(array);
    const length = stored?.get("length");
    if (!stored?.has("length")) return array.elements;
    if (
      length?.type !== "Literal" ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > array.elements.length + stored.size
    )
      return [{ type: "SpreadElement", argument: {} }];
    return Array.from({ length: length.value }, (_, index) =>
      stored.has(String(index)) ? stored.get(String(index)) : array.elements[index],
    );
  };
  const identity = (node: AnyNode, environment = values): AnyNode => {
    node = unwrapResourceExpression(node);
    if (node?.type === "AwaitExpression") {
      let value = identity(node.argument, environment);
      while (promises.has(value)) value = identity(promises.get(value), environment);
      return value;
    }
    if (node?.type === "ThisExpression") return environment.get(thisBinding);
    if (returned.has(node)) return identity(returned.get(node), environment);
    if (node?.type === "MemberExpression") {
      const key = propertyKey(node, environment);
      if (key !== undefined) {
        const object = identity(node.object, environment);
        const stored = properties.get(object);
        if (stored?.has("__doctorUnknownOrder") && /^(0|[1-9]\d*)$/.test(key)) return node;
        if (stored?.has(key)) return stored.get(key);
        if (object?.type === "ArrayExpression" && /^(0|[1-9]\d*)$/.test(String(key))) {
          if (
            arrayElements(object)
              .slice(0, Number(key) + 1)
              .some((item: AnyNode) => item?.type === "SpreadElement")
          )
            return node;
          return identity(arrayElements(object)[Number(key)], environment);
        }
        if (object?.type === "ObjectExpression") {
          const seen = new Set<AnyNode>();
          const read = (source: AnyNode): AnyNode => {
            source = identity(source, environment);
            if (source?.type !== "ObjectExpression" || seen.has(source)) return node;
            seen.add(source);
            if (properties.get(source)?.has(key)) return properties.get(source)!.get(key);
            for (const item of [...source.properties].reverse()) {
              if (item.type === "SpreadElement") {
                const spread = read(item.argument);
                if (spread !== undefined) return spread;
              } else if (item.computed || (item.key?.name ?? item.key?.value) === "__proto__") {
                return node;
              } else if ((item.key?.name ?? item.key?.value) === key) {
                return item.kind === "init" ? identity(item.value, environment) : node;
              }
            }
            return undefined;
          };
          const value = read(object);
          if (value !== undefined) return value;
          if (
            !(key in Object.prototype) &&
            object.properties.every(
              (item: AnyNode) =>
                item.type !== "SpreadElement" &&
                !item.computed &&
                (item.key?.name ?? item.key?.value) !== "__proto__",
            )
          )
            return undefined;
        }
        if (!members.has(object)) members.set(object, new Map());
        const paths = members.get(object)!;
        if (!paths.has(key)) paths.set(key, { ...node, object });
        return paths.get(key);
      }
      return node;
    }
    const binding = resolve(node);
    return environment.has(binding)
      ? returned.has(environment.get(binding))
        ? identity(environment.get(binding), environment)
        : environment.get(binding)
      : (binding ?? memberPath(node) ?? node);
  };
  const expand = (
    items: AnyNode[],
    environment: Map<AnyNode, AnyNode>,
    seen = new Set<AnyNode>(),
  ): AnyNode[] =>
    items.flatMap((item) => {
      if (item?.type !== "SpreadElement") return [item];
      const spread = identity(item.argument, environment);
      if (spread?.type !== "ArrayExpression" || seen.has(spread)) return [item];
      return expand(arrayElements(spread), environment, new Set([...seen, spread])).map(
        (value) => value ?? { type: "Identifier", name: "undefined" },
      );
    });
  const receiverIdentity = (node: AnyNode, environment: Map<AnyNode, AnyNode>): AnyNode => {
    node = unwrapResourceExpression(node);
    return identity(node, environment);
  };
  function bindResource(
    pattern: AnyNode,
    argument: AnyNode,
    local: Map<AnyNode, AnyNode>,
    module = false,
  ): boolean {
    const abruptBinding = {};
    const read = (object: AnyNode, key: string): AnyNode => {
      const descriptor = effectiveProperties(object, local).get(key);
      if (
        descriptor?.accessor &&
        descriptor.property.kind === "get" &&
        !properties.get(object)?.has(key)
      ) {
        const completion = inspect(
          descriptor.property.value,
          [],
          local,
          module,
          descriptor.receiver,
        );
        if (!completion.normal) throw abruptBinding;
        return completion.value;
      }
      const member = {
        type: "MemberExpression",
        object,
        property: { type: "Literal", value: key },
        computed: true,
      };
      return identity(member, local);
    };
    const bind = (pattern: AnyNode, argument: AnyNode): void => {
      if (!pattern) return;
      if (pattern.type === "Identifier") local.set(pattern, argument);
      else if (pattern.type === "AssignmentPattern") {
        const useDefault =
          argument === undefined ||
          argument === "undefined" ||
          (argument?.type === "UnaryExpression" && argument.operator === "void");
        if (useDefault && !evaluate(pattern.right, local, module).normal) throw abruptBinding;
        bind(pattern.left, useDefault ? identity(pattern.right, local) : argument);
      } else if (pattern.type === "ArrayPattern" && argument?.type === "ArrayExpression") {
        for (const [index, element] of pattern.elements.entries()) {
          if (element?.type === "RestElement")
            bind(element.argument, {
              type: "ArrayExpression",
              elements: arrayElements(argument)
                .slice(index)
                .map((_: AnyNode, offset: number) => read(argument, String(index + offset))),
            });
          else bind(element, read(argument, String(index)));
        }
      } else if (pattern.type === "ObjectPattern") {
        const excluded = new Set<string>();
        let unknownExclusion = false;
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            if (argument?.type !== "ObjectExpression" || unknownExclusion) {
              bind(property.argument, {});
              continue;
            }
            const rest = { type: "ObjectExpression", properties: [] };
            const entries = new Map<string, AnyNode>();
            for (const item of argument.properties) {
              const key = item.computed ? item.key?.value : (item.key?.name ?? item.key?.value);
              if (key !== undefined && !excluded.has(String(key)))
                entries.set(String(key), read(argument, String(key)));
            }
            for (const key of properties.get(argument)?.keys() ?? [])
              if (!excluded.has(key)) entries.set(key, read(argument, key));
            properties.set(rest, entries);
            bind(property.argument, rest);
          } else {
            const key = property.computed
              ? identity(property.key, local)?.value
              : (property.key?.name ?? property.key?.value);
            if (key === undefined) {
              unknownExclusion = true;
              bind(property.value, {});
              continue;
            }
            excluded.add(String(key));
            const missing =
              argument?.type === "ObjectExpression" &&
              !properties.get(argument)?.has(String(key)) &&
              !argument.properties.some(
                (item: AnyNode) =>
                  item.type === "SpreadElement" ||
                  item.computed ||
                  String(item.key?.name ?? item.key?.value) === String(key),
              );
            bind(property.value, missing ? undefined : read(argument, String(key)));
          }
        }
      }
    };
    try {
      bind(pattern, argument);
      return true;
    } catch (error) {
      if (error !== abruptBinding) throw error;
      return false;
    }
  }
  const adoptPromise = (completion: Completion): Completion => {
    let settled = completion;
    const seen = new Set<AnyNode>();
    while (settled.normal && settled.value && !seen.has(settled.value)) {
      seen.add(settled.value);
      const choices = callbackChoices.get(settled.value);
      const adopted = choices
        ? {
            normal: choices.some((choice) => promiseCompletions.get(choice)?.normal ?? true),
            abrupt: choices.some((choice) => promiseCompletions.get(choice)?.abrupt),
          }
        : promiseCompletions.get(settled.value);
      if (!adopted) break;
      settled = {
        ...adopted,
        normal: adopted.normal,
        abrupt: settled.abrupt || adopted.abrupt,
      };
    }
    return settled;
  };
  function inspect(
    target: AnyNode,
    args: AnyNode[] = [],
    environment = values,
    module = false,
    receiver?: AnyNode,
  ): Completion {
    target = unwrapResourceExpression(target);
    if (target?.type === "MemberExpression") receiver = identity(target.object, environment);
    if (target?.type === "Identifier" || target?.type === "MemberExpression") {
      const value = identity(target, environment);
      if (
        resources.some((resource) => resource.value === value && resource.kind === "subscription")
      )
        cleaned.add(value);
      target = lexicalEnvironments.has(value) ? value : (callbacks.get(value) ?? value);
    }
    if (target?.type === "MemberExpression" && ["call", "apply"].includes(propertyKey(target)!)) {
      const forwarded = identity(args[1], environment);
      if (
        propertyKey(target) === "apply" &&
        forwarded !== undefined &&
        forwarded?.type !== "ArrayExpression" &&
        !(forwarded?.type === "Literal" && forwarded.value == null)
      )
        return { normal: true, abrupt: false };
      return inspect(
        target.object,
        propertyKey(target) === "call"
          ? args.slice(1)
          : forwarded?.type === "ArrayExpression"
            ? arrayElements(forwarded)
            : [],
        environment,
        module,
        identity(args[0], environment),
      );
    }
    if (["clearInterval", "clearTimeout"].includes(target)) {
      const handle = identity(args[0], environment);
      for (const resource of resources)
        if (
          ["interval", "timeout"].includes(resource.kind) &&
          (resource.value === handle || alternatives.get(handle)?.includes(resource.value))
        )
          cleaned.add(resource.value);
      return { normal: true, abrupt: false };
    }
    const captured = lexicalEnvironments.get(target);
    if (captured) {
      if (lexicalReceivers.has(target)) receiver = lexicalReceivers.get(target);
      target = callbacks.get(target) ?? target;
    }
    if (
      target?.type === "CallExpression" &&
      target.callee?.type === "MemberExpression" &&
      propertyKey(target.callee) === "bind" &&
      !visited.has(target)
    ) {
      visited.add(target);
      const bound = target.callee.object;
      const boundArgs = [...target.arguments.slice(1), ...args];
      let completion: Completion = { normal: true, abrupt: false };
      if (bound.type === "MemberExpression") {
        if (identity(bound.object, environment) === identity(target.arguments[0], environment))
          completion = evaluate(
            { type: "CallExpression", callee: bound, arguments: boundArgs },
            environment,
            module,
          );
      } else {
        const callable = identity(bound, environment);
        if (callable === "setInterval" || callable === "setTimeout")
          completion = evaluate(
            { type: "CallExpression", callee: bound, arguments: boundArgs },
            environment,
            module,
          );
        else
          completion = inspect(
            bound,
            boundArgs,
            environment,
            module,
            identity(target.arguments[0], environment),
          );
      }
      visited.delete(target);
      return completion;
    }
    if (visited.has(target)) return { normal: false, abrupt: true };
    if (
      !target ||
      target.generator ||
      !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
        target.type,
      )
    )
      return { normal: true, abrupt: false };
    visited.add(target);
    const local = new Map([...environment, ...(captured ?? [])]);
    if (target.type === "FunctionExpression" && target.id) local.set(target.id, target);
    local.set(thisBinding, receiver);
    for (const [index, param] of target.params.entries()) {
      const bound =
        param.type === "RestElement"
          ? bindResource(
              param.argument,
              {
                type: "ArrayExpression",
                elements: args.slice(index).map((arg) => identity(arg, environment)),
              },
              local,
            )
          : bindResource(param, identity(args[index], environment), local, module);
      if (!bound) {
        visited.delete(target);
        return { normal: false, abrupt: true };
      }
    }
    const parentPath = currentPath;
    const promise = target.async ? {} : undefined;
    if (promise) {
      pendingUserPromises.add(promise);
      promiseCompletions.set(promise, { normal: false, abrupt: false });
    }
    const completion = evaluate(target.body, local, module, Boolean(target.async), promise);
    currentPath = parentPath;
    for (const binding of environment.keys()) {
      if (binding !== thisBinding && local.has(binding))
        environment.set(binding, local.get(binding));
    }
    visited.delete(target);
    if (target.async) {
      if (completion.suspended) return { normal: true, abrupt: false, value: promise };
      promises.set(promise, completion.value);
      const settled = adoptPromise(completion);
      promiseCompletions.set(promise, settled);
      return { normal: true, abrupt: false, value: promise };
    }
    return completion;
  }
  function evaluate(
    root: AnyNode,
    environment: Map<AnyNode, AnyNode>,
    module: boolean,
    asyncFunction = false,
    resultPromise?: AnyNode,
  ): Completion {
    const exits: Set<AnyNode>[] = [];
    const exitedDisposers: Disposer[] = [];
    const thrownExits = new Set<Set<AnyNode>>();
    const throwStates = new Map<Set<AnyNode>, ReturnType<typeof snapshot>>();
    let normal = false;
    let abrupt = false;
    const returns: AnyNode[] = [];
    const returnPaths: Map<object, boolean>[] = [];
    let pendingAwait: unknown;
    let suspendedAwait: AnyNode;
    walkEvaluation(root, (node) => {
      if (node.type === "FunctionDeclaration" && node.id) callbacks.set(node.id, node);
    });
    const visit = (node: AnyNode, receiver?: AnyNode): boolean | undefined => {
      if (node.type === "CallExpression") {
        if (
          identity(node.callee, environment) === "queueMicrotask" &&
          node.arguments[0] &&
          (node.callee.type !== "Identifier" || !resolve(node.callee))
        ) {
          microtasks.push({ callback: identity(node.arguments[0], environment), environment });
          return true;
        }
        if (node.arguments.some((argument: AnyNode) => argument?.type === "SpreadElement")) {
          const expanded = expand(node.arguments, environment);
          if (!expanded.some((argument: AnyNode) => argument?.type === "SpreadElement")) {
            const call = { ...node, arguments: expanded };
            const normal = visit(call, receiver);
            returned.set(node, returned.get(call));
            return normal;
          }
        }
        const target = identity(node.callee, environment);
        if (promiseSettlers.has(target)) {
          promiseSettlers.get(target)!(identity(node.arguments[0], environment));
          return true;
        }
        if (
          target?.type === "MemberExpression" &&
          ["call", "apply"].includes(propertyKey(target)!)
        ) {
          const args = node.arguments.map((argument: AnyNode) => identity(argument, environment));
          const forwarded = args[1];
          if (
            propertyKey(target) === "apply" &&
            forwarded !== undefined &&
            forwarded?.type !== "ArrayExpression" &&
            !(forwarded?.type === "Literal" && forwarded.value == null)
          )
            return true;
          const call = {
            type: "CallExpression",
            callee: target.object,
            arguments:
              propertyKey(target) === "call"
                ? args.slice(1)
                : forwarded?.type === "ArrayExpression"
                  ? arrayElements(forwarded)
                  : [],
          };
          const continues = visit(call, args[0]);
          if (returned.has(call)) returned.set(node, returned.get(call));
          return continues;
        }
      }
      if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
        const key = propertyKey(node.left, environment);
        if (key !== undefined) {
          const object = identity(node.left.object, environment);
          const descriptor = effectiveProperties(object, environment).get(key);
          const classSetter = classSetters.get(object)?.get(key);
          if (classSetter && !properties.get(object)?.has(key)) {
            const completion = inspect(classSetter, [node.right], environment, module, object);
            if (completion.abrupt) {
              abrupt = true;
              exits.push(new Set(cleaned));
              thrownExits.add(exits[exits.length - 1]);
              throwStates.set(exits[exits.length - 1], snapshot());
            }
            return completion.normal;
          }
          if (
            descriptor?.accessor &&
            descriptor.property.kind === "set" &&
            !properties.get(object)?.has(key)
          ) {
            const completion = inspect(
              descriptor.property.value,
              [node.right],
              environment,
              module,
              descriptor.receiver,
            );
            if (completion.abrupt) {
              abrupt = true;
              exits.push(new Set(cleaned));
              thrownExits.add(exits[exits.length - 1]);
              throwStates.set(exits[exits.length - 1], snapshot());
            }
            return completion.normal;
          }
          if (!properties.has(object)) properties.set(object, new Map());
          properties
            .get(object)!
            .set(key, node.operator === "=" ? identity(node.right, environment) : node);
        }
      }
      if (node.type === "UnaryExpression" && node.operator === "delete") {
        const target = node.argument;
        if (target?.type === "MemberExpression") {
          const key = propertyKey(target, environment);
          if (key !== undefined) {
            const object = identity(target.object, environment);
            if (!properties.has(object)) properties.set(object, new Map());
            properties.get(object)!.set(key, undefined);
          }
        }
      }
      const handle =
        node.type === "VariableDeclarator"
          ? node.id
          : node.type === "AssignmentExpression"
            ? node.left
            : null;
      if (handle && ["ObjectPattern", "ArrayPattern"].includes(handle.type)) {
        if (
          !bindResource(handle, identity(node.init ?? node.right, environment), environment, module)
        ) {
          abrupt = true;
          exits.push(new Set(cleaned));
          thrownExits.add(exits[exits.length - 1]);
          throwStates.set(exits[exits.length - 1], snapshot());
          return false;
        }
      }
      if (handle?.type === "Identifier") {
        const binding = resolve(handle);
        const init = unwrapResourceExpression(
          node.type === "VariableDeclarator" ? node.init : node.right,
        );
        if (init) {
          const value = identity(init, environment);
          environment.set(binding, value);
          if (init.type === "FunctionExpression") callbacks.set(value, init);
        } else if (node.type === "VariableDeclarator" && !environment.has(binding)) {
          environment.set(binding, undefined);
        }
      }
      {
        const path = memberPath(node.callee);
        const target = identity(node.callee, environment);
        const callees = (callbackChoices.get(target) ?? [target]).map((choice) => {
          const global = identity(choice?.object ?? node.callee?.object, environment);
          return typeof choice === "string"
            ? choice
            : ["window", "globalThis", "self"].includes(global)
              ? propertyKey(choice)
              : undefined;
        });
        const kinds = new Set(
          callees.map((callee) =>
            node.type === "CallExpression" && callee === "setInterval"
              ? "interval"
              : node.type === "CallExpression" && callee === "setTimeout"
                ? "timeout"
                : node.type === "NewExpression" &&
                    ["WebSocket", "EventSource"].includes(callee ?? "")
                  ? callee!
                  : node.type === "CallExpression" && path?.endsWith(".subscribe")
                    ? "subscription"
                    : null,
          ),
        );
        const created = [];
        for (const kind of kinds) {
          if (!kind) continue;
          const value = {};
          created.push(value);
          if (loopDepth) repeated.add(value);
          resourcePaths.set(value, new Map(currentPath));
          resources.push({
            value,
            kind,
            cleanup:
              kind === "interval"
                ? "clearInterval"
                : kind === "timeout"
                  ? "clearTimeout"
                  : kind === "subscription"
                    ? "unsubscribe"
                    : "close",
            method: !["interval", "timeout"].includes(kind),
          });
        }
        if (created.length === 1) returned.set(node, created[0]);
        else if (created.length) {
          const value = {};
          alternatives.set(value, created);
          returned.set(node, value);
        }
        if (module && kinds.has("subscription") && node.arguments[0])
          subscriptions.push({ callback: identity(node.arguments[0], environment), environment });
        if (
          (module || timerSimulationDepth === 1) &&
          (kinds.has("timeout") || kinds.has("interval")) &&
          node.arguments[0]
        ) {
          const callback = identity(node.arguments[0], environment);
          if (
            lexicalEnvironments.has(callback) ||
            callbacks.has(callback) ||
            ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
              callback?.type,
            )
          ) {
            const timeout = created[0];
            if (timeout)
              pendingTimeouts.push({
                timeout,
                callback,
                args: node.arguments
                  .slice(2)
                  .map((argument: AnyNode) => identity(argument, environment)),
                environment,
                delay: identity(node.arguments[1], environment),
              });
          }
        }
      }
      if (node.type !== "CallExpression") return;
      const calleeValue = identity(node.callee, environment);
      const calleeGlobal = identity(calleeValue?.object ?? node.callee?.object, environment);
      const globalAlias = ["window", "globalThis", "self"].includes(calleeGlobal);
      const callee = globalAlias
        ? `window.${propertyKey(calleeValue) ?? propertyKey(node.callee)}`
        : typeof calleeValue === "string"
          ? calleeValue
          : memberPath(node.callee);
      if (module && callee === "import.meta.hot.dispose") {
        const callback = identity(node.arguments[0], environment);
        disposers = (callbackChoices.get(callback) ?? [callback]).map((callback) => ({
          callback,
          path: new Map(currentPath),
        }));
        return;
      }
      if (calleeValue === "Boolean") {
        const value = identity(node.arguments[0], environment);
        if (
          value === undefined ||
          value?.type === "Literal" ||
          value?.type === "ArrayExpression" ||
          value?.type === "ObjectExpression" ||
          promises.has(value) ||
          knownTruthyResource(value)
        )
          returned.set(node, {
            type: "Literal",
            value: value?.type === "Literal" ? Boolean(value.value) : value !== undefined,
          });
        return true;
      }
      const method =
        node.callee.type === "Identifier" ? node.callee.name : propertyKey(node.callee);
      const replacedMethod =
        node.callee.type === "MemberExpression" &&
        properties.get(identity(node.callee.object, environment))?.has(method!);
      if (
        method === "assign" &&
        node.callee.type === "MemberExpression" &&
        identity(node.callee.object, environment) === "Object" &&
        !replacedMethod
      ) {
        const target = identity(node.arguments[0], environment);
        for (const argument of node.arguments.slice(1)) {
          const source = identity(argument, environment);
          const descriptors = effectiveProperties(source, environment);
          for (const key of new Set([
            ...descriptors.keys(),
            ...(properties.get(source)?.keys() ?? []),
          ])) {
            const descriptor = descriptors.get(key);
            let value: AnyNode;
            if (
              !properties.get(source)?.has(key) &&
              descriptor?.accessor &&
              descriptor.property.kind === "get"
            ) {
              const completion = inspect(
                descriptor.property.value,
                [],
                environment,
                module,
                descriptor.receiver,
              );
              if (completion.abrupt) {
                abrupt = true;
                exits.push(new Set(cleaned));
                thrownExits.add(exits[exits.length - 1]);
                throwStates.set(exits[exits.length - 1], snapshot());
              }
              if (!completion.normal) return false;
              value = completion.value;
            } else if (!properties.get(source)?.has(key) && descriptor?.property.kind !== "init")
              continue;
            else
              value = identity(
                {
                  type: "MemberExpression",
                  object: source,
                  property: { type: "Literal", value: key },
                  computed: true,
                },
                environment,
              );
            if (
              visit({
                type: "AssignmentExpression",
                operator: "=",
                left: {
                  type: "MemberExpression",
                  object: target,
                  property: { type: "Literal", value: key },
                  computed: true,
                },
                right: value,
              }) === false
            )
              return false;
          }
        }
        returned.set(node, target);
        return true;
      }
      if (
        ["resolve", "reject", "all", "allSettled", "race", "any"].includes(method!) &&
        node.callee.type === "MemberExpression" &&
        identity(node.callee.object, environment) === "Promise" &&
        !replacedMethod
      ) {
        const promise = {};
        const value = identity(node.arguments[0], environment);
        const aggregate = ["all", "allSettled", "race", "any"].includes(method!);
        if (aggregate && value?.type !== "ArrayExpression") return true;
        if (
          aggregate &&
          arrayElements(value).some((item: AnyNode) => item?.type === "SpreadElement")
        )
          return true;
        if (aggregate) {
          const items = arrayElements(value).map((item: AnyNode) => identity(item, environment));
          const updateAggregate = () => {
            const settled = (item: AnyNode) => {
              const completion = promiseCompletions.get(item);
              return !completion || completion.normal || completion.abrupt;
            };
            const canFulfill = (item: AnyNode) => promiseCompletions.get(item)?.normal !== false;
            const canReject = (item: AnyNode) =>
              promiseCompletions.get(item)?.abrupt ?? !promises.has(item);
            const firstSettledIndex = items.findIndex(settled);
            const firstCompletion = promiseCompletions.get(items[firstSettledIndex]);
            const firstSettled =
              method === "race" &&
              firstSettledIndex >= 0 &&
              (!firstCompletion || firstCompletion.normal !== firstCompletion.abrupt);
            const candidates = firstSettled
              ? items.slice(firstSettledIndex, firstSettledIndex + 1)
              : items.filter(settled);
            const completion = {
              normal:
                method === "allSettled"
                  ? items.every(settled)
                  : method === "all"
                    ? items.every((item: AnyNode) => settled(item) && canFulfill(item))
                    : candidates.some(canFulfill),
              abrupt:
                method === "allSettled"
                  ? false
                  : method === "any"
                    ? items.every((item: AnyNode) => settled(item) && canReject(item))
                    : candidates.some(canReject),
            };
            if (method === "all" || method === "allSettled")
              promises.set(promise, {
                type: "ArrayExpression",
                elements: items.map((item: AnyNode) => {
                  const settled = promiseCompletions.get(item);
                  const result = promises.has(item) ? promises.get(item) : item;
                  if (method === "all") return result;
                  const fulfilled = settled?.normal !== false;
                  return {
                    type: "ObjectExpression",
                    properties: [
                      {
                        type: "Property",
                        kind: "init",
                        key: { type: "Identifier", name: "status" },
                        value: { type: "Literal", value: fulfilled ? "fulfilled" : "rejected" },
                      },
                      {
                        type: "Property",
                        kind: "init",
                        key: { type: "Identifier", name: fulfilled ? "value" : "reason" },
                        value: fulfilled ? result : settled?.value,
                      },
                    ],
                  };
                }),
              });
            else if (method === "race" || method === "any") {
              const winner = method === "any" ? candidates.find(canFulfill) : candidates[0];
              promises.set(promise, winner ? (promises.get(winner) ?? winner) : undefined);
            }
            if (method === "any" && !items.length) completion.abrupt = true;
            const previous = promiseCompletions.get(promise);
            const next = {
              ...completion,
              value: method === "race" && !completion.normal ? firstCompletion?.value : undefined,
            };
            promiseCompletions.set(promise, next);
            if ((next.normal || next.abrupt) && !previous?.normal && !previous?.abrupt)
              enqueueReactions(promise, {
                ...next,
                value: next.normal ? promises.get(promise) : next.value,
              });
          };
          updateAggregate();
          for (const item of new Set(items)) {
            if (!pendingUserPromises.has(item)) continue;
            const reactions = pendingPromiseReactions.get(item) ?? [];
            reactions.push({ environment, result: promise, settled: updateAggregate });
            pendingPromiseReactions.set(item, reactions);
          }
          if (items.some((item: AnyNode) => pendingUserPromises.has(item)))
            pendingUserPromises.add(promise);
          returned.set(node, promise);
          return true;
        }
        if (method === "resolve") promises.set(promise, promises.get(value) ?? value);
        promiseCompletions.set(
          promise,
          method === "resolve"
            ? (promiseCompletions.get(value) ?? {
                normal: true,
                abrupt:
                  value?.type !== "Literal" &&
                  value?.type !== "ObjectExpression" &&
                  value?.type !== "ArrayExpression" &&
                  value !== undefined &&
                  !resources.some((resource) => resource.value === value),
                value,
              })
            : { normal: false, abrupt: true, value },
        );
        returned.set(node, promise);
        return true;
      }
      if (node.type === "CallExpression" && identity(node.callee, environment) === "fetch") {
        const promise = {};
        promiseCompletions.set(promise, { normal: true, abrupt: true });
        pendingFetchPromises.add(promise);
        returned.set(node, promise);
        return true;
      }
      if (
        (method === "then" || method === "catch" || method === "finally") &&
        node.callee.type === "MemberExpression" &&
        !replacedMethod &&
        promiseCompletions.has(identity(node.callee.object, environment))
      ) {
        const promise = identity(node.callee.object, environment);
        const previous = promiseCompletions.get(promise)!;
        const fulfilledHandler = method === "then" ? node.arguments[0] : undefined;
        const rejectedHandler =
          method === "then"
            ? node.arguments[1]
            : method === "catch"
              ? node.arguments[0]
              : undefined;
        const finallyHandler = method === "finally" ? node.arguments[0] : undefined;
        const result = {};
        if (!previous.normal && !previous.abrupt) {
          const reactions = pendingPromiseReactions.get(promise) ?? [];
          reactions.push({
            fulfilled: fulfilledHandler ?? finallyHandler,
            rejected: rejectedHandler ?? finallyHandler,
            finally: finallyHandler,
            environment,
            result,
          });
          pendingPromiseReactions.set(promise, reactions);
          pendingUserPromises.add(result);
          promiseCompletions.set(result, { normal: false, abrupt: false });
          returned.set(node, result);
          return true;
        }
        if (pendingFetchPromises.has(promise)) {
          for (const callback of [
            previous.normal ? fulfilledHandler : undefined,
            previous.abrupt ? rejectedHandler : undefined,
            previous.normal || previous.abrupt ? finallyHandler : undefined,
          ]) {
            if (callback) lateReactions.push({ callback, args: [], environment });
          }
        }
        promiseCompletions.set(result, { normal: false, abrupt: false });
        returned.set(node, result);
        microtasks.push({
          environment,
          task: () => {
            const mixed = previous.normal && previous.abrupt;
            const before = mixed ? snapshot() : undefined;
            const parentPath = currentPath;
            const settlement = {};
            const runFinally = (incoming: Completion | undefined): Completion | undefined => {
              if (!finallyHandler || !incoming) return incoming;
              const final = adoptPromise(inspect(finallyHandler, [], environment, module));
              return final.abrupt
                ? {
                    normal: incoming.normal && final.normal,
                    abrupt: true,
                    value: final.value,
                  }
                : incoming;
            };
            if (mixed) currentPath = new Map(parentPath).set(settlement, true);
            const fulfilled = runFinally(
              previous.normal
                ? fulfilledHandler
                  ? inspect(fulfilledHandler, [promises.get(promise)], environment, module)
                  : { normal: true, abrupt: false, value: promises.get(promise) }
                : undefined,
            );
            const afterFulfilled = mixed ? snapshot() : undefined;
            if (before) {
              restore(before);
              currentPath = new Map(parentPath).set(settlement, false);
            }
            const rejected = runFinally(
              previous.abrupt
                ? rejectedHandler
                  ? inspect(rejectedHandler, [previous.value], environment, module)
                  : { normal: false, abrupt: true, value: previous.value }
                : undefined,
            );
            if (afterFulfilled) merge(afterFulfilled, snapshot());
            currentPath = parentPath;
            const completion: Completion = {
              normal: Boolean(fulfilled?.normal || rejected?.normal),
              abrupt: Boolean(fulfilled?.abrupt || rejected?.abrupt),
              value: fulfilled?.value ?? rejected?.value,
            };
            const settled = adoptPromise(completion);
            if (pendingFetchPromises.has(promise)) pendingFetchPromises.add(result);
            if (settled.normal) promises.set(result, settled.value);
            promiseCompletions.set(result, settled);
            enqueueReactions(result, settled);
          },
        });
        return true;
      }
      if (
        method === "from" &&
        node.callee.type === "MemberExpression" &&
        identity(node.callee.object, environment) === "Array" &&
        !replacedMethod
      ) {
        const input = identity(node.arguments[0], environment);
        if (input?.type === "ArrayExpression") {
          const elements = expand(arrayElements(input), environment);
          if (node.arguments[1]) {
            const mapped: AnyNode[] = [];
            for (const [index, element] of elements.entries()) {
              const call = {
                type: "CallExpression",
                callee: identity(node.arguments[1], environment),
                arguments: [identity(element, environment), { type: "Literal", value: index }],
              };
              if (visit(call, identity(node.arguments[2], environment)) === false) return false;
              mapped.push(returned.get(call));
            }
            returned.set(node, { type: "ArrayExpression", elements: mapped });
          } else returned.set(node, { type: "ArrayExpression", elements });
          return true;
        }
      }
      if (
        (method === "addEventListener" || method === "removeEventListener") &&
        !(node.callee.type === "Identifier" && resolve(node.callee))
      ) {
        const receiver =
          node.callee.type === "Identifier"
            ? (resolve(node.callee) ?? "window")
            : receiverIdentity(node.callee.object, environment);
        const eventValue = identity(node.arguments[0], environment);
        const event =
          eventValue?.type === "TemplateLiteral" && eventValue.expressions.length === 0
            ? eventValue.quasis[0].value.cooked
            : (eventValue?.value ?? eventValue);
        const handler = receiverIdentity(node.arguments[1], environment);
        if (method === "addEventListener" && (handler === undefined || handler?.value === null))
          return true;
        const listenerOptions = identity(node.arguments[2], environment);
        const captureDescriptor = effectiveProperties(listenerOptions, environment).get("capture");
        const captureCompletion =
          captureDescriptor?.accessor &&
          captureDescriptor.property.kind === "get" &&
          !properties.get(listenerOptions)?.has("capture")
            ? inspect(
                captureDescriptor.property.value,
                [],
                environment,
                module,
                captureDescriptor.receiver,
              )
            : undefined;
        if (captureCompletion?.abrupt) {
          abrupt = true;
          exits.push(new Set(cleaned));
          thrownExits.add(exits[exits.length - 1]);
          throwStates.set(exits[exits.length - 1], snapshot());
        }
        if (captureCompletion && !captureCompletion.normal) return false;
        const captureValue = !listenerOptions
          ? undefined
          : listenerOptions.type !== "ObjectExpression"
            ? listenerOptions
            : captureCompletion
              ? captureCompletion.value
              : captureDescriptor || properties.get(listenerOptions)?.has("capture")
                ? identity(
                    {
                      type: "MemberExpression",
                      object: listenerOptions,
                      property: { type: "Identifier", name: "capture" },
                      computed: false,
                    },
                    environment,
                  )
                : undefined;
        const options =
          captureValue?.type === "Literal" ? Boolean(captureValue.value) : (captureValue ?? false);
        if (method === "addEventListener") {
          const descriptor = effectiveProperties(listenerOptions, environment).get("once");
          const onceCompletion =
            descriptor?.accessor &&
            descriptor.property.kind === "get" &&
            !properties.get(listenerOptions)?.has("once")
              ? inspect(descriptor.property.value, [], environment, module, descriptor.receiver)
              : undefined;
          if (onceCompletion?.abrupt) {
            abrupt = true;
            exits.push(new Set(cleaned));
            thrownExits.add(exits[exits.length - 1]);
            throwStates.set(exits[exits.length - 1], snapshot());
          }
          if (onceCompletion && !onceCompletion.normal) return false;
          const once = onceCompletion
            ? onceCompletion.value
            : identity(
                {
                  type: "MemberExpression",
                  object: listenerOptions,
                  property: { type: "Identifier", name: "once" },
                  computed: false,
                },
                environment,
              );
          const passiveDescriptor = effectiveProperties(listenerOptions, environment).get(
            "passive",
          );
          const passiveCompletion =
            passiveDescriptor?.accessor &&
            passiveDescriptor.property.kind === "get" &&
            !properties.get(listenerOptions)?.has("passive")
              ? inspect(
                  passiveDescriptor.property.value,
                  [],
                  environment,
                  module,
                  passiveDescriptor.receiver,
                )
              : undefined;
          if (passiveCompletion?.abrupt) {
            abrupt = true;
            exits.push(new Set(cleaned));
            thrownExits.add(exits[exits.length - 1]);
            throwStates.set(exits[exits.length - 1], snapshot());
          }
          if (passiveCompletion && !passiveCompletion.normal) return false;
          const signalDescriptor = effectiveProperties(listenerOptions, environment).get("signal");
          const signalCompletion =
            signalDescriptor?.accessor &&
            signalDescriptor.property.kind === "get" &&
            !properties.get(listenerOptions)?.has("signal")
              ? inspect(
                  signalDescriptor.property.value,
                  [],
                  environment,
                  module,
                  signalDescriptor.receiver,
                )
              : undefined;
          if (signalCompletion?.abrupt) {
            abrupt = true;
            exits.push(new Set(cleaned));
            thrownExits.add(exits[exits.length - 1]);
            throwStates.set(exits[exits.length - 1], snapshot());
          }
          if (signalCompletion && !signalCompletion.normal) return false;
          const signal = signalCompletion
            ? signalCompletion.value
            : identity(
                {
                  type: "MemberExpression",
                  object: listenerOptions,
                  property: { type: "Identifier", name: "signal" },
                  computed: false,
                },
                environment,
              );
          const controller =
            signal?.type === "MemberExpression" && propertyKey(signal) === "signal"
              ? identity(signal.object, environment)
              : undefined;
          if (
            controller &&
            abortedControllers
              .get(controller)
              ?.some((path) =>
                [...path].every(([condition, side]) => currentPath.get(condition) === side),
              )
          )
            return true;
          listeners.push({
            receiver,
            event,
            handler,
            capture: options,
            controller,
            value: node,
            once: once?.type === "Literal" && Boolean(once.value),
            path: new Map(currentPath),
          });
          resourcePaths.set(node, new Map(currentPath));
          resources.push({
            value: node,
            kind: "listener",
            cleanup: "removeEventListener",
            method: true,
          });
        }
        if (method === "removeEventListener" && !replacedMethod) {
          for (const listener of listeners) {
            if (
              receiver === listener.receiver &&
              event === listener.event &&
              handler &&
              handler === listener.handler &&
              options === listener.capture
            )
              cleaned.add(listener.value);
          }
        }
      }
      if (method === "abort" && !replacedMethod) {
        const controller = identity(node.callee.object, environment);
        abortedControllers.set(controller, [
          ...(abortedControllers.get(controller) ?? []),
          new Map(currentPath),
        ]);
        for (const listener of listeners) {
          if (listener.controller && listener.controller === controller)
            cleaned.add(listener.value);
        }
      }
      for (const resource of resources) {
        if (resource.kind === "listener") continue;
        const receiver = resource.method ? node.callee.object : node.arguments[0];
        const matches = resource.method
          ? propertyKey(node.callee) === resource.cleanup
          : [
              resource.cleanup,
              ...(["interval", "timeout"].includes(resource.kind)
                ? ["clearInterval", "clearTimeout"].flatMap((name) => [
                    name,
                    `window.${name}`,
                    `globalThis.${name}`,
                    `self.${name}`,
                  ])
                : []),
              `window.${resource.cleanup}`,
              `globalThis.${resource.cleanup}`,
              `self.${resource.cleanup}`,
            ].includes(callee ?? "");
        const global = resource.method ? null : (node.callee.object ?? node.callee);
        if (
          matches &&
          !replacedMethod &&
          (identity(receiver, environment) === resource.value ||
            alternatives.get(identity(receiver, environment))?.includes(resource.value)) &&
          (!global || !resolve(global) || globalAlias || typeof calleeValue === "string")
        )
          cleaned.add(resource.value);
      }
      const array =
        node.callee.type === "MemberExpression"
          ? identity(node.callee.object, environment)
          : undefined;
      if (mapCollections.has(array) && !replacedMethod) {
        const entries = arrayElements(array);
        if (method === "get") {
          const key = identity(node.arguments[0], environment);
          const entry = entries.find(
            (item: AnyNode) => item && sameMapKey(arrayElements(item)[0], key),
          );
          returned.set(node, entry ? arrayElements(entry)[1] : undefined);
          return true;
        }
        if (method === "set") {
          const key = identity(node.arguments[0], environment);
          const value = identity(node.arguments[1], environment);
          const index = entries.findIndex(
            (entry: AnyNode) => entry && sameMapKey(arrayElements(entry)[0], key),
          );
          const stored = properties.get(array) ?? new Map<string, AnyNode>();
          stored.set(String(index < 0 ? entries.length : index), {
            type: "ArrayExpression",
            elements: [key, value],
          });
          stored.set("length", {
            type: "Literal",
            value: index < 0 ? entries.length + 1 : entries.length,
          });
          properties.set(array, stored);
          returned.set(node, array);
          return true;
        }
        if (method === "clear" || method === "delete") {
          const key = identity(node.arguments[0], environment);
          const deleted = entries.some(
            (entry: AnyNode) => entry && sameMapKey(arrayElements(entry)[0], key),
          );
          const stored = new Map<string, AnyNode>();
          entries.forEach((entry: AnyNode, index: number) =>
            stored.set(
              String(index),
              method === "clear" || (entry && sameMapKey(arrayElements(entry)[0], key))
                ? null
                : entry,
            ),
          );
          stored.set("length", { type: "Literal", value: entries.length });
          properties.set(array, stored);
          if (method === "delete") returned.set(node, { type: "Literal", value: deleted });
          return true;
        }
        if (method === "forEach") {
          const iterationLimit = Math.max(2048, entries.length);
          for (let position = 0; position < arrayElements(array).length; position++) {
            if (position >= iterationLimit) {
              truncatedSetIteration ||= arrayElements(array)
                .slice(position)
                .some(
                  (entry: AnyNode) =>
                    entry &&
                    resources.some(
                      (resource) =>
                        resource.value === arrayElements(entry)[1] && !cleaned.has(resource.value),
                    ),
                );
              break;
            }
            const entry = arrayElements(array)[position];
            if (!entry) continue;
            const [key, value] = arrayElements(entry);
            if (
              visit(
                {
                  type: "CallExpression",
                  callee: identity(node.arguments[0], environment),
                  arguments: [value, key, array],
                },
                identity(node.arguments[1], environment),
              ) === false
            )
              return false;
          }
          return true;
        }
      }
      if (setCollections.has(array) && !replacedMethod) {
        const elements = arrayElements(array);
        if (method === "add") {
          const value = identity(node.arguments[0], environment);
          if (!elements.includes(value)) {
            const stored = properties.get(array) ?? new Map();
            stored.set(String(elements.length), value);
            stored.set("length", { type: "Literal", value: elements.length + 1 });
            properties.set(array, stored);
            for (const iteration of setIterations.get(array) ?? []) iteration.push(value);
          }
          returned.set(node, array);
          return true;
        }
        if (method === "delete") {
          const value = identity(node.arguments[0], environment);
          const index = elements.findIndex(
            (element: AnyNode) =>
              element === value ||
              (resolve(node.arguments[0]) && resolve(element) === resolve(node.arguments[0])),
          );
          if (index !== -1) {
            const remaining = elements.filter((_, position) => position !== index);
            const stored = new Map<string, AnyNode>();
            remaining.forEach((element, position) => stored.set(String(position), element));
            stored.set("length", { type: "Literal", value: remaining.length });
            properties.set(array, stored);
            for (const iteration of setIterations.get(array) ?? []) {
              for (let position = 0; position < iteration.length; position++)
                if (iteration[position] === value) iteration[position] = null;
            }
          }
          returned.set(node, { type: "Literal", value: index !== -1 });
          return true;
        }
        if (method === "clear") {
          properties.set(array, new Map([["length", { type: "Literal", value: 0 }]]));
          for (const iteration of setIterations.get(array) ?? []) iteration.fill(null);
          return true;
        }
        if (method === "forEach") {
          const iteration: AnyNode[] = [...elements];
          const iterationLimit = Math.max(2048, iteration.length);
          const active = setIterations.get(array) ?? [];
          active.push(iteration);
          setIterations.set(array, active);
          for (let position = 0; position < iteration.length; position++) {
            if (position >= iterationLimit) {
              truncatedSetIteration ||= iteration
                .slice(position)
                .some((value) =>
                  resources.some((resource) => resource.value === value && !cleaned.has(value)),
                );
              break;
            }
            const element = iteration[position];
            if (element === null) continue;
            const call = {
              type: "CallExpression",
              callee: identity(node.arguments[0], environment),
              arguments: [element, element, array],
            };
            if (visit(call, identity(node.arguments[1], environment)) === false) {
              active.pop();
              return false;
            }
          }
          active.pop();
          return true;
        }
      }
      if (
        array?.type === "ArrayExpression" &&
        !arrayChoices.has(array) &&
        !replacedMethod &&
        method === "at"
      ) {
        const index = identity(node.arguments[0], environment);
        if (index?.type === "Literal" && Number.isInteger(index.value)) {
          const elements = arrayElements(array);
          const position = index.value < 0 ? elements.length + index.value : index.value;
          returned.set(
            node,
            identity(
              {
                type: "MemberExpression",
                object: array,
                property: { type: "Literal", value: position },
                computed: true,
              },
              environment,
            ),
          );
        }
        return true;
      }
      if (
        array?.type === "ArrayExpression" &&
        !arrayChoices.has(array) &&
        !replacedMethod &&
        method === "slice"
      ) {
        const indices = node.arguments.map((argument: AnyNode) => identity(argument, environment));
        if (
          indices.every(
            (index: AnyNode) => index?.type === "Literal" && Number.isInteger(index.value),
          )
        )
          returned.set(node, {
            type: "ArrayExpression",
            elements: arrayElements(array).slice(indices[0]?.value, indices[1]?.value),
          });
        return true;
      }
      if (arrayChoices.has(array) && !replacedMethod) {
        const before = snapshot();
        const parentPath = currentPath;
        const resultBinding = {};
        let merged: ReturnType<typeof snapshot> | undefined;
        let continues = true;
        for (const choice of arrayChoices.get(array)!) {
          restore(before);
          currentPath = choice.path;
          const call = { ...node, callee: { ...node.callee, object: choice.array } };
          continues = visit(call, receiver) !== false && continues;
          environment.set(resultBinding, returned.get(call));
          const after = snapshot();
          if (merged) merge(merged, after);
          merged = snapshot();
        }
        currentPath = parentPath;
        returned.set(node, environment.get(resultBinding));
        environment.delete(resultBinding);
        return continues;
      }
      if (
        array?.type === "ArrayExpression" &&
        !replacedMethod &&
        ["pop", "shift", "splice", "unshift", "reverse", "sort", "fill", "copyWithin"].includes(
          method!,
        )
      ) {
        const elements = [...arrayElements(array)];
        const args = node.arguments.map((argument: AnyNode) => identity(argument, environment));
        let result: AnyNode;
        if (method === "pop") result = elements.pop();
        else if (method === "shift") result = elements.shift();
        else if (method === "unshift")
          result = { type: "Literal", value: elements.unshift(...args) };
        else if (method === "reverse") {
          elements.reverse();
          result = array;
        } else if (method === "sort") {
          const sortable = elements.filter(
            (element) =>
              element &&
              identity(element, environment) !== "undefined" &&
              !(element.type === "Literal" && element.value === undefined),
          );
          if (sortable.length > 1 && args[0]) {
            const resourceStart = resources.length;
            loopDepth++;
            const completion = inspect(args[0], [{}, {}], environment, module);
            loopDepth--;
            for (const resource of resources.slice(resourceStart))
              if (cleaned.has(resource.value)) repeated.delete(resource.value);
            if (completion.abrupt) {
              abrupt = true;
              exits.push(new Set(cleaned));
              thrownExits.add(exits[exits.length - 1]);
              throwStates.set(exits[exits.length - 1], snapshot());
            }
            if (!completion.normal) return false;
          }
          result = array;
        } else if (
          method === "splice" &&
          args
            .slice(0, 2)
            .every((arg: AnyNode) => arg?.type === "Literal" && typeof arg.value === "number")
        ) {
          const removed =
            args.length === 0
              ? []
              : args.length === 1
                ? elements.splice(args[0].value)
                : elements.splice(args[0].value, args[1].value, ...args.slice(2));
          result = { type: "ArrayExpression", elements: removed };
        } else {
          elements.splice(0, elements.length, { type: "SpreadElement", argument: {} });
          result = {};
        }
        const stored = new Map(elements.map((element, index) => [String(index), element]));
        stored.set("length", { type: "Literal", value: elements.length });
        if (method === "sort" && elements.length > 1) stored.set("__doctorUnknownOrder", true);
        properties.set(array, stored);
        returned.set(node, result);
        return true;
      }
      if (array?.type === "ArrayExpression" && !replacedMethod && method === "push") {
        const elements = arrayElements(array);
        if (
          elements.some((element) => element?.type === "SpreadElement") ||
          node.arguments.some((argument: AnyNode) => argument.type === "SpreadElement")
        )
          return true;
        if (!properties.has(array)) properties.set(array, new Map());
        const stored = properties.get(array)!;
        for (const [index, argument] of node.arguments.entries())
          stored.set(String(elements.length + index), identity(argument, environment));
        const length = { type: "Literal", value: elements.length + node.arguments.length };
        stored.set("length", length);
        returned.set(node, length);
        return true;
      }
      if (
        array?.type === "ArrayExpression" &&
        !replacedMethod &&
        [
          "forEach",
          "map",
          "flatMap",
          "filter",
          "some",
          "every",
          "find",
          "findIndex",
          "findLast",
          "findLastIndex",
          "reduce",
          "reduceRight",
        ].includes(method!)
      ) {
        const elements: AnyNode[] = [];
        let knownSelection = true;
        let accumulator = identity(node.arguments[1], environment);
        let hasAccumulator = node.arguments.length > 1;
        const searching = ["find", "findIndex", "findLast", "findLastIndex"].includes(method!);
        let selected: AnyNode = {
          type: "Literal",
          value: method?.endsWith("Index") ? -1 : undefined,
        };
        const reducing = method === "reduce" || method === "reduceRight";
        const entries = [...expand(arrayElements(array), environment).entries()];
        if (["reduceRight", "findLast", "findLastIndex"].includes(method!)) entries.reverse();
        let optionalTail: ReturnType<typeof snapshot> | undefined;
        for (const [index] of entries) {
          const current = arrayElements(array);
          const element = current.some((item) => item?.type === "SpreadElement")
            ? expand(current, environment)[index]
            : current[index];
          if ((!element && !searching) || element?.type === "SpreadElement") continue;
          if (reducing && !hasAccumulator) {
            accumulator = identity(element, environment);
            hasAccumulator = true;
            continue;
          }
          const call = {
            type: "CallExpression",
            callee: identity(node.arguments[0], environment),
            arguments: [
              identity(element ?? undefined, environment),
              { type: "Literal", value: index },
              array,
            ],
          };
          if (reducing) call.arguments.unshift(accumulator);
          if (
            visit(call, reducing ? undefined : identity(node.arguments[1], environment)) === false
          )
            return false;
          const result = returned.get(call);
          if (reducing) accumulator = result;
          if (
            ["some", "every", "find", "findIndex", "findLast", "findLastIndex"].includes(method!)
          ) {
            const known = result?.type === "Literal" || promises.has(result);
            const truthy = promises.has(result) || Boolean(result?.value);
            if (known && (method === "every" ? !truthy : truthy)) {
              if (searching)
                selected = optionalTail
                  ? {}
                  : method?.endsWith("Index")
                    ? { type: "Literal", value: index }
                    : identity(element, environment);
              break;
            }
            if (!known) {
              if (optionalTail) merge(optionalTail, snapshot());
              optionalTail = snapshot();
            }
          }
          if (method === "filter") {
            if (result?.type === "Literal") {
              if (result.value) elements.push(identity(element, environment));
            } else knownSelection = false;
          } else if (method === "flatMap" && result?.type === "ArrayExpression") {
            elements.push(...arrayElements(result).filter((element) => element != null));
          } else elements.push(result);
        }
        if (optionalTail) merge(optionalTail, snapshot());
        if (searching) returned.set(node, optionalTail ? {} : selected);
        if (reducing) returned.set(node, accumulator);
        if (method === "map" || method === "flatMap" || (method === "filter" && knownSelection))
          returned.set(node, { type: "ArrayExpression", elements });
        return true;
      }
      const completion =
        node.callee.type === "Super"
          ? (superConstructors.get(environment.get(thisBinding))?.(
              node.arguments.map((arg: AnyNode) => identity(arg, environment)),
            ) ?? { normal: true, abrupt: false })
          : inspect(node.callee, node.arguments, environment, module, receiver);
      if (completion.value) {
        returned.set(node, completion.value);
        if (node.callee.type === "Super") environment.set(thisBinding, completion.value);
      }
      if (completion.abrupt) {
        abrupt = true;
        exits.push(new Set(cleaned));
        thrownExits.add(exits[exits.length - 1]);
        throwStates.set(exits[exits.length - 1], snapshot());
      }
      return completion.normal;
    };
    const snapshot = () => ({
      path: new Map(currentPath),
      disposers: [...disposers],
      cleaned: new Set(cleaned),
      values: new Map(environment),
      properties: new Map([...properties].map(([key, entries]) => [key, new Map(entries)])),
    });
    const restore = (state: ReturnType<typeof snapshot>) => {
      disposers = [...state.disposers];
      cleaned.clear();
      for (const value of state.cleaned) cleaned.add(value);
      environment.clear();
      for (const [key, value] of state.values) environment.set(key, value);
      properties.clear();
      for (const [key, entries] of state.properties) properties.set(key, new Map(entries));
    };
    const merge = (left: ReturnType<typeof snapshot>, right: ReturnType<typeof snapshot>) => {
      restore(left);
      disposers = [...new Set([...left.disposers, ...right.disposers])];
      const absent = (value: AnyNode, state: ReturnType<typeof snapshot>) =>
        [...(resourcePaths.get(value) ?? [])].some(
          ([condition, side]) => state.path.has(condition) && state.path.get(condition) !== side,
        );
      for (const value of new Set([...left.cleaned, ...right.cleaned])) {
        if (
          (left.cleaned.has(value) || absent(value, left)) &&
          (right.cleaned.has(value) || absent(value, right))
        )
          cleaned.add(value);
        else cleaned.delete(value);
      }
      const mergedObjects = new Map<AnyNode, Map<AnyNode, AnyNode>>();
      const mergeValue = (a: AnyNode, b: AnyNode): AnyNode => {
        if (a === b) return a;
        if (a?.type === "ArrayExpression" && b?.type === "ArrayExpression") {
          const previous = mergedObjects.get(a)?.get(b);
          if (previous) return previous;
          const value = { type: "ArrayExpression", elements: [] as AnyNode[] };
          if (!mergedObjects.has(a)) mergedObjects.set(a, new Map());
          mergedObjects.get(a)!.set(b, value);
          arrayChoices.set(value, [
            ...(arrayChoices.get(a) ?? [
              {
                array: {
                  type: "ArrayExpression",
                  elements: arrayElements(a, left.properties).map((item) =>
                    identity(item, left.values),
                  ),
                },
                path: left.path,
              },
            ]),
            ...(arrayChoices.get(b) ?? [
              {
                array: {
                  type: "ArrayExpression",
                  elements: arrayElements(b, right.properties).map((item) =>
                    identity(item, right.values),
                  ),
                },
                path: right.path,
              },
            ]),
          ]);
          const first = arrayElements(a, left.properties);
          const second = arrayElements(b, right.properties);
          for (let index = 0; index < Math.max(first.length, second.length); index++)
            value.elements.push(
              mergeValue(
                identity(first[index], left.values),
                identity(second[index], right.values),
              ),
            );
          return value;
        }
        if (a?.type === "ObjectExpression" && b?.type === "ObjectExpression") {
          const previous = mergedObjects.get(a)?.get(b);
          if (previous) return previous;
          const value = { type: "ObjectExpression", properties: [] as AnyNode[] };
          if (!mergedObjects.has(a)) mergedObjects.set(a, new Map());
          mergedObjects.get(a)!.set(b, value);
          const readMembers = (object: AnyNode, state: ReturnType<typeof snapshot>) => {
            const entries = new Map<string, AnyNode>();
            for (const property of object.properties) {
              if (property.type !== "Property" || property.computed || property.kind !== "init")
                continue;
              entries.set(
                String(property.key.name ?? property.key.value),
                identity(property.value, state.values),
              );
            }
            for (const [key, member] of state.properties.get(object) ?? [])
              entries.set(key, member);
            return entries;
          };
          const first = readMembers(a, left);
          const second = readMembers(b, right);
          for (const key of new Set([...first.keys(), ...second.keys()])) {
            value.properties.push({
              type: "Property",
              kind: "init",
              computed: false,
              key: { type: "Literal", value: key },
              value: mergeValue(first.get(key), second.get(key)),
            });
          }
          return value;
        }
        const value = {};
        callbackChoices.set(
          value,
          [a, b].flatMap((choice) => callbackChoices.get(choice) ?? [choice]),
        );
        const handles = [a, b]
          .flatMap((choice) => alternatives.get(choice) ?? [choice])
          .filter((choice) => resources.some((resource) => resource.value === choice));
        if (
          handles.length &&
          handles.every((handle) =>
            [left, right].every(
              (state, index) =>
                (alternatives.get([a, b][index]) ?? [[a, b][index]]).includes(handle) ||
                absent(handle, state),
            ),
          )
        )
          alternatives.set(value, handles);
        return value;
      };
      for (const key of new Set([...left.values.keys(), ...right.values.keys()])) {
        if (!left.values.has(key)) environment.set(key, right.values.get(key));
        else if (right.values.has(key))
          environment.set(key, mergeValue(left.values.get(key), right.values.get(key)));
      }
      for (const object of new Set([...left.properties.keys(), ...right.properties.keys()])) {
        const a = left.properties.get(object) ?? new Map();
        const b = right.properties.get(object) ?? new Map();
        if (!properties.has(object)) properties.set(object, new Map());
        for (const key of new Set([...a.keys(), ...b.keys()])) {
          properties.get(object)!.set(key, mergeValue(a.get(key), b.get(key)));
        }
      }
    };
    const branch = (
      left: AnyNode,
      right: AnyNode,
      expression?: AnyNode,
      includeAbrupt = false,
      catches = false,
      condition?: AnyNode,
    ): boolean => {
      const resourceStart = resources.length;
      const before = snapshot();
      const parentPath = currentPath;
      let inverted = false;
      condition = unwrapResourceExpression(condition);
      while (condition?.type === "UnaryExpression" && condition.operator === "!") {
        inverted = !inverted;
        condition = unwrapResourceExpression(condition.argument);
      }
      const conditionValue = ["Identifier", "MemberExpression"].includes(condition?.type)
        ? identity(condition, environment)
        : undefined;
      if (conditionValue !== undefined && !conditions.has(conditionValue))
        conditions.set(conditionValue, {});
      const choice = conditions.get(conditionValue) ?? {};
      if (parentPath.has(choice)) {
        const selected = parentPath.get(choice) === !inverted ? left : right;
        const continues = walk(selected);
        if (expression) returned.set(expression, identity(selected, environment));
        return continues;
      }
      const selectPath = (side: boolean) => {
        if (includeAbrupt) return;
        currentPath = new Map(parentPath).set(choice, side);
        if (module)
          disposers = disposers.map((disposer) => ({
            callback: disposer.callback,
            path: new Map(disposer.path).set(choice, side),
          }));
      };
      selectPath(!inverted);
      const firstExit = exits.length;
      const beforeAbrupt = abrupt;
      const leftContinues = walk(left);
      const leftExits = exits.slice(firstExit);
      const leftAbrupt = abrupt;
      abrupt = beforeAbrupt;
      const leftValue = identity(left, environment);
      const afterLeft = snapshot();
      restore(before);
      if (catches) {
        const throws = leftExits.filter((exit) => thrownExits.has(exit));
        if (!throws.length) {
          restore(afterLeft);
          currentPath = parentPath;
          abrupt ||= leftAbrupt;
          return leftContinues;
        }
        restore(throwStates.get(throws[0])!);
        for (const exit of throws.slice(1)) merge(snapshot(), throwStates.get(exit)!);
      }
      selectPath(inverted);
      const rightContinues = walk(right);
      abrupt ||= leftAbrupt && (!catches || leftExits.some((exit) => !thrownExits.has(exit)));
      const rightValue = identity(right, environment);
      const afterRight = snapshot();
      const arrayExpression =
        expression &&
        leftValue?.type === "ArrayExpression" &&
        rightValue?.type === "ArrayExpression";
      if (arrayExpression) {
        afterLeft.values.set(expression, leftValue);
        afterRight.values.set(expression, rightValue);
      }
      currentPath = parentPath;
      if (expression && leftContinues && rightContinues) {
        const choices = [leftValue, rightValue].flatMap(
          (value) => alternatives.get(value) ?? [value],
        );
        const callbacksValue = {};
        callbackChoices.set(
          callbacksValue,
          [leftValue, rightValue].flatMap((value) => callbackChoices.get(value) ?? [value]),
        );
        returned.set(expression, callbacksValue);
        const created = new Set(resources.slice(resourceStart).map((resource) => resource.value));
        if (choices.some((value) => created.has(value))) {
          const value = {};
          alternatives.set(value, choices);
          returned.set(expression, value);
        }
      }
      const caughtThrowOnly =
        catches &&
        !leftContinues &&
        leftExits.length > 0 &&
        leftExits.every((exit) => thrownExits.has(exit));
      if (catches) {
        for (const exit of leftExits) {
          if (thrownExits.has(exit)) exits.splice(exits.indexOf(exit), 1);
        }
      }
      if (caughtThrowOnly) restore(afterRight);
      else if (includeAbrupt || (leftContinues && rightContinues)) merge(afterLeft, afterRight);
      else if (leftContinues) restore(afterLeft);
      if (arrayExpression) {
        returned.set(expression, environment.get(expression));
        environment.delete(expression);
      }
      if (leftContinues !== rightContinues)
        currentPath = new Map(leftContinues ? afterLeft.path : afterRight.path);
      return leftContinues || rightContinues;
    };
    const controls: {
      node: AnyNode;
      loop: boolean;
      continues: ReturnType<typeof snapshot>[];
      breaks?: ReturnType<typeof snapshot>[];
    }[] = [];
    const labels = new Map<string, { exit: Set<AnyNode>; state: ReturnType<typeof snapshot> }[]>();
    const completed = new Set<AnyNode>();
    const resumeExpression = (node: AnyNode, captured: Map<AnyNode, AnyNode>): AnyNode => {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map((child) => resumeExpression(child, captured));
      if (node.type === "AwaitExpression" || completed.has(node)) {
        const saved = { type: "Identifier", name: "__doctorAwaitValue" };
        returned.set(saved, node.type === "AwaitExpression" ? node : identity(node, captured));
        return saved;
      }
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => key !== "__doctorParent")
          .map(([key, child]) => [key, resumeExpression(child, captured)]),
      );
    };
    let walk: (node: AnyNode) => boolean;
    const walkNode = (node: AnyNode): boolean => {
      if (!node || typeof node !== "object") return true;
      if (Array.isArray(node)) return node.every(walk);
      if (typeof node.type !== "string") return true;
      if (node.type === "Program" || node.type === "BlockStatement") {
        for (const [index, statement] of node.body.entries()) {
          const continues = walk(statement);
          if (pendingAwait) {
            const awaited = pendingAwait;
            pendingAwait = undefined;
            suspendedAwait = awaited;
            if (!continues || index + 1 < node.body.length || resultPromise) {
              const captured = new Map(environment);
              const callback = {
                type: "ArrowFunctionExpression",
                params: [],
                body: {
                  type: "BlockStatement",
                  body: [
                    ...(!continues ? [resumeExpression(statement, captured)] : []),
                    ...node.body.slice(index + 1),
                  ],
                },
              };
              if (pendingUserPromises.has(awaited)) {
                const reactions = pendingPromiseReactions.get(awaited) ?? [];
                reactions.push({
                  fulfilled: callback,
                  environment: captured,
                  result: resultPromise ?? {},
                  resumeAwait: true,
                });
                pendingPromiseReactions.set(awaited, reactions);
              } else lateReactions.push({ callback, args: [], environment: captured });
            }
            return true;
          }
          if (!continues) return false;
        }
        return true;
      }
      if (
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      ) {
        if (node.type !== "FunctionDeclaration" || environment !== values) {
          const closure = {};
          lexicalEnvironments.set(closure, environment);
          if (node.type === "ArrowFunctionExpression")
            lexicalReceivers.set(closure, environment.get(thisBinding));
          callbacks.set(closure, node);
          if (node.type === "FunctionDeclaration") callbacks.set(node.id, closure);
          else returned.set(node, closure);
        }
        visit(node);
        return true;
      }
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        if (node.id) environment.set(resolve(node.id), node);
        if (!properties.has(node)) properties.set(node, new Map());
        for (const field of node.body.body) {
          if (
            field.static &&
            field.type === "MethodDefinition" &&
            ["method", "get", "set"].includes(field.kind)
          ) {
            const key = field.computed
              ? identity(field.key, environment)?.value
              : (field.key?.name ?? field.key?.value);
            if (key !== undefined) {
              if (field.kind === "get" || field.kind === "set") {
                const accessors = field.kind === "get" ? classGetters : classSetters;
                if (!accessors.has(node)) accessors.set(node, new Map());
                accessors.get(node)!.set(String(key), field.value);
              } else properties.get(node)!.set(String(key), field.value);
            }
          }
        }
        if (!walk(node.superClass)) return false;
        const superclass = identity(node.superClass, environment);
        for (const [key, value] of properties.get(superclass) ?? []) {
          if (
            !properties.get(node)!.has(key) &&
            !classGetters.get(node)?.has(key) &&
            !classSetters.get(node)?.has(key)
          )
            properties.get(node)!.set(key, value);
        }
        for (const [key, getter] of classGetters.get(superclass) ?? []) {
          if (
            !properties.get(node)!.has(key) &&
            !classGetters.get(node)?.has(key) &&
            !classSetters.get(node)?.has(key)
          ) {
            if (!classGetters.has(node)) classGetters.set(node, new Map());
            classGetters.get(node)!.set(key, getter);
          }
        }
        for (const [key, setter] of classSetters.get(superclass) ?? []) {
          if (
            !properties.get(node)!.has(key) &&
            !classGetters.get(node)?.has(key) &&
            !classSetters.get(node)?.has(key)
          ) {
            if (!classSetters.has(node)) classSetters.set(node, new Map());
            classSetters.get(node)!.set(key, setter);
          }
        }
        const walkStatic = (field: AnyNode, key?: string): boolean => {
          const hadReceiver = environment.has(thisBinding);
          const receiver = environment.get(thisBinding);
          environment.set(thisBinding, node);
          try {
            if (field.type === "PropertyDefinition") {
              if (!walk(field.value)) return false;
              if (key !== undefined)
                properties.get(node)!.set(String(key), identity(field.value, environment));
              return true;
            }
            return walk(field);
          } finally {
            if (hadReceiver) environment.set(thisBinding, receiver);
            else environment.delete(thisBinding);
          }
        };
        for (const field of node.body.body) {
          if (field.computed && !walk(field.key)) return false;
          if (field.type === "PropertyDefinition" && field.static) {
            const key = field.computed
              ? identity(field.key, environment)?.value
              : (field.key?.name ?? field.key?.value);
            if (!walkStatic(field, key)) return false;
          } else if (field.type === "StaticBlock" && !walkStatic(field)) return false;
        }
        return true;
      }
      if (node.type === "ObjectExpression") {
        const spreadGetters = (source: AnyNode): boolean => {
          for (const [key, { property, receiver, accessor }] of effectiveProperties(
            source,
            environment,
          )) {
            if (!accessor || property.kind !== "get") continue;
            const completion = inspect(property.value, [], environment, module, receiver);
            if (!completion.normal) return false;
            if (!properties.has(node)) properties.set(node, new Map());
            properties.get(node)!.set(key, completion.value);
          }
          return true;
        };
        for (const property of node.properties) {
          if (!walk(property)) return false;
          if (property.type === "SpreadElement" && !spreadGetters(property.argument)) return false;
          if (property.type === "Property") {
            const key = definitionKey(property, environment);
            if (key !== undefined && properties.get(node)?.has(key))
              properties.get(node)!.set(key, identity(property.value, environment));
          }
        }
        return true;
      }
      if (node.type === "NewExpression") {
        if (!walk(node.callee)) return false;
        const value = identity(node.callee, environment);
        const target = callbacks.get(value) ?? value;
        if (value === "Map" && !resolve(node.callee)) {
          if (!walk(node.arguments)) return false;
          const source = identity(node.arguments[0], environment);
          if (!source || source?.type === "ArrayExpression") {
            const entries: AnyNode[] = [];
            for (const entry of source ? expand(arrayElements(source), environment) : []) {
              const known = identity(entry, environment);
              if (known?.type !== "ArrayExpression") return true;
              const [key, item] = arrayElements(known);
              const index = entries.findIndex((existing) =>
                sameMapKey(arrayElements(existing)[0], identity(key, environment)),
              );
              const updated = {
                type: "ArrayExpression",
                elements: [identity(key, environment), identity(item, environment)],
              };
              if (index < 0) entries.push(updated);
              else entries[index] = updated;
            }
            const collection = {
              type: "ArrayExpression",
              elements: entries,
            };
            mapCollections.add(collection);
            returned.set(node, collection);
          }
          return true;
        }
        if (value === "Set" && !resolve(node.callee) && !node.arguments[0]) {
          const collection = { type: "ArrayExpression", elements: [] };
          setCollections.add(collection);
          returned.set(node, collection);
          return true;
        }
        if (value === "Set" && !resolve(node.callee)) {
          if (!walk(node.arguments)) return false;
          const source = identity(node.arguments[0], environment);
          if (source?.type === "ArrayExpression") {
            const collection = {
              type: "ArrayExpression",
              elements: expand(arrayElements(source), environment)
                .map((element: AnyNode) => identity(element, environment))
                .filter(
                  (element: AnyNode, index: number, elements: AnyNode[]) =>
                    elements.findIndex((other) => sameMapKey(element, other)) === index,
                ),
            };
            setCollections.add(collection);
            returned.set(node, collection);
          }
          return true;
        }
        if (
          value === "Promise" ||
          (value?.type === "MemberExpression" &&
            propertyKey(value) === "Promise" &&
            ["window", "globalThis", "self"].includes(identity(value.object, environment)))
        ) {
          if (!walk(node.arguments)) return false;
          const promise = {};
          pendingUserPromises.add(promise);
          const resolve = {};
          const reject = {};
          let completion: Completion = { normal: false, abrupt: false };
          const settledPaths: Map<object, boolean>[] = [];
          const alreadySettled = () => {
            const covers = (path: Map<object, boolean>): boolean => {
              if (
                settledPaths.some((settled) =>
                  [...settled].every(([condition, value]) => path.get(condition) === value),
                )
              )
                return true;
              const choice = settledPaths
                .flatMap((settled) => [...settled.keys()])
                .find((condition) => !path.has(condition));
              return (
                choice !== undefined &&
                covers(new Map(path).set(choice, true)) &&
                covers(new Map(path).set(choice, false))
              );
            };
            return covers(currentPath);
          };
          promiseSettlers.set(resolve, (value) => {
            if (alreadySettled()) return;
            settledPaths.push(new Map(currentPath));
            const adopted = adoptPromise({ normal: true, abrupt: false, value });
            completion = {
              ...completion,
              normal: completion.normal || adopted.normal,
              abrupt: completion.abrupt || adopted.abrupt,
              value: adopted.value,
            };
            promiseCompletions.set(promise, completion);
            if (completion.normal) promises.set(promise, completion.value);
            enqueueReactions(promise, completion);
          });
          promiseSettlers.set(reject, (value) => {
            if (alreadySettled()) return;
            settledPaths.push(new Map(currentPath));
            completion = { ...completion, abrupt: true, value };
            promiseCompletions.set(promise, completion);
            enqueueReactions(promise, completion);
          });
          const executor = inspect(node.arguments[0], [resolve, reject], environment, module);
          if (executor.abrupt && !alreadySettled()) completion.abrupt = true;
          promiseCompletions.set(promise, completion);
          if (completion.normal) promises.set(promise, completion.value);
          returned.set(node, promise);
          return true;
        }
        if (
          [
            "ClassDeclaration",
            "ClassExpression",
            "FunctionDeclaration",
            "FunctionExpression",
          ].includes(target?.type) &&
          !target.async &&
          !target.generator
        ) {
          if (!walk(node.arguments)) return false;
          const constructing = new Set<AnyNode>();
          const construct = (
            target: AnyNode,
            args: AnyNode[],
            allocated: AnyNode = {},
          ): Completion => {
            if (constructing.has(target)) return { normal: false, abrupt: true };
            constructing.add(target);
            let instance: AnyNode = allocated;
            properties.set(instance, new Map());
            const local = new Map(environment);
            local.set(thisBinding, instance);
            const fields = ["ClassDeclaration", "ClassExpression"].includes(target.type)
              ? target.body.body
              : [];
            const initialize = (): Completion => {
              for (const field of fields) {
                if (field.static) continue;
                const key = field.computed
                  ? identity(field.key, local)?.value
                  : (field.key?.name ?? field.key?.value);
                if (field.type === "PropertyDefinition") {
                  if (field.value) {
                    const completion = evaluate(field.value, local, module);
                    if (!completion.normal) return completion;
                  }
                  if (key !== undefined)
                    properties.get(instance)!.set(key, identity(field.value, local));
                } else if (key !== undefined && ["get", "set"].includes(field.kind)) {
                  const accessors = field.kind === "get" ? classGetters : classSetters;
                  if (!accessors.has(instance)) accessors.set(instance, new Map());
                  accessors.get(instance)!.set(String(key), field.value);
                } else if (key !== undefined && field.kind !== "constructor") {
                  properties.get(instance)!.set(key, field.value);
                }
              }
              return { normal: true, abrupt: false };
            };
            const baseValue = identity(target.superClass, environment);
            const base = callbacks.get(baseValue) ?? baseValue;
            const derived = Boolean(target.superClass);
            const constructableBase =
              [
                "ClassDeclaration",
                "ClassExpression",
                "FunctionDeclaration",
                "FunctionExpression",
              ].includes(base?.type) &&
              !base.async &&
              !base.generator;
            const builtInResource =
              !constructableBase && ["WebSocket", "EventSource"].includes(base);
            const initializeBase = (baseArgs: AnyNode[]): Completion => {
              const completion = constructableBase
                ? construct(base, baseArgs, instance)
                : { normal: true, abrupt: false };
              if (!completion.normal) return completion;
              if (builtInResource) {
                resourcePaths.set(instance, new Map(currentPath));
                resources.push({ value: instance, kind: base, cleanup: "close", method: true });
              }
              if (completion.value) {
                instance = completion.value;
                local.set(thisBinding, instance);
                if (!properties.has(instance)) properties.set(instance, new Map());
              }
              const initialized = initialize();
              return initialized.normal ? completion : initialized;
            };
            const constructor =
              fields.find((field: AnyNode) => field.kind === "constructor")?.value ??
              (["FunctionDeclaration", "FunctionExpression"].includes(target.type)
                ? target
                : undefined);
            let completion: Completion = { normal: true, abrupt: false };
            if (derived) {
              if (constructor) superConstructors.set(instance, initializeBase);
              else completion = initializeBase(args);
            } else completion = initialize();
            if (constructor && completion.normal)
              completion = inspect(constructor, args, environment, module, instance);
            superConstructors.delete(allocated);
            constructing.delete(target);
            const replacement = completion.value;
            const returnsUndefined =
              replacement == null ||
              replacement === "undefined" ||
              (replacement.type === "UnaryExpression" && replacement.operator === "void");
            const primitive =
              !returnsUndefined &&
              !replacement.regex &&
              [
                "Literal",
                "UnaryExpression",
                "TemplateLiteral",
                "BinaryExpression",
                "UpdateExpression",
              ].includes(replacement.type);
            if (derived && primitive) return { normal: false, abrupt: true };
            if (!returnsUndefined && !primitive) instance = replacement;
            return { ...completion, value: instance };
          };
          const completion = construct(target, node.arguments);
          returned.set(node, completion.value);
          if (completion.abrupt) {
            abrupt = true;
            exits.push(new Set(cleaned));
            if (module) exitedDisposers.push(...disposers);
          }
          return completion.normal;
        }
      }
      if (node.type === "PropertyDefinition" && !node.static)
        return !node.computed || walk(node.key);
      if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
        if (!walk(node.test)) return false;
        const test = identity(node.test, environment);
        const constant = (expression: AnyNode): unknown => {
          const value = identity(expression, environment);
          if (value?.type === "Literal") return value.value;
          if (knownTruthyResource(value)) return true;
          if (value?.type === "UnaryExpression" && value.operator === "typeof") {
            const argument = identity(value.argument, environment);
            if (argument?.type === "Literal") return typeof argument.value;
            if (knownTruthyResource(argument))
              return resources.some(
                (resource) =>
                  resource.value === argument && ["interval", "timeout"].includes(resource.kind),
              )
                ? "number"
                : "object";
          }
          if (value?.type === "UnaryExpression" && value.operator === "!") {
            const argument = constant(value.argument);
            if (argument !== undefined) return !argument;
          }
          if (value?.type === "BinaryExpression") {
            const left = constant(value.left);
            const right = constant(value.right);
            if (left === undefined || right === undefined) {
              if (
                ["===", "!==", "==", "!="].includes(value.operator) &&
                ((knownTruthyResource(identity(value.left, environment)) && right === null) ||
                  (knownTruthyResource(identity(value.right, environment)) && left === null))
              )
                return value.operator === "!==" || value.operator === "!=";
              return undefined;
            }
            if (value.operator === "===") return left === right;
            if (value.operator === "!==") return left !== right;
            if (value.operator === "==") return left == right;
            if (value.operator === "!=") return left != right;
          }
          return undefined;
        };
        const known = constant(node.test);
        if (
          known !== undefined ||
          memberPath(node.test) === "import.meta.hot" ||
          knownTruthyResource(test)
        ) {
          const selected = known !== undefined && !known ? node.alternate : node.consequent;
          const continues = walk(selected);
          if (node.type === "ConditionalExpression")
            returned.set(node, identity(selected, environment));
          return continues;
        }
        return branch(
          node.consequent,
          node.alternate,
          node.type === "ConditionalExpression" ? node : undefined,
          false,
          false,
          node.test,
        );
      }
      if (node.type === "LabeledStatement") {
        const breaks: { exit: Set<AnyNode>; state: ReturnType<typeof snapshot> }[] = [];
        labels.set(node.label.name, breaks);
        const continues = walk(node.body);
        labels.delete(node.label.name);
        if (!continues && breaks.length) restore(breaks[0].state);
        for (const item of breaks) {
          merge(snapshot(), item.state);
          exits.splice(exits.indexOf(item.exit), 1);
        }
        return continues || breaks.length > 0;
      }
      if (node.type === "AssignmentExpression" && ["||=", "&&=", "??="].includes(node.operator)) {
        if (!walk(node.left)) return false;
        const left = identity(node.left, environment);
        const resource = knownTruthyResource(left);
        const known = resource || left?.type === "Literal" || left == null || left === "undefined";
        const assignment = { ...node, operator: "=" };
        if (!known) return branch(assignment, null);
        const value = resource ? true : left?.value;
        const useRight =
          node.operator === "&&="
            ? Boolean(value)
            : node.operator === "||="
              ? !value
              : value == null;
        if (useRight && !walk(assignment)) return false;
        returned.set(node, useRight ? identity(node.right, environment) : left);
        return true;
      }
      if (node.type === "LogicalExpression") {
        if (!walk(node.left)) return false;
        if (memberPath(node.left) === "import.meta.hot" && node.operator === "&&")
          return walk(node.right);
        const left = identity(node.left, environment);
        const known = left?.type === "Literal" || left === "undefined" || knownTruthyResource(left);
        if (known) {
          const value = knownTruthyResource(left)
            ? true
            : left === "undefined"
              ? undefined
              : left.value;
          const useRight =
            node.operator === "&&"
              ? Boolean(value)
              : node.operator === "||"
                ? !value
                : value == null;
          if (useRight && !walk(node.right)) return false;
          returned.set(node, useRight ? identity(node.right, environment) : left);
          return true;
        }
        return branch(
          node.operator === "||" ? null : node.right,
          node.operator === "||" ? node.right : null,
          node,
          false,
          false,
          node.operator === "??" ? undefined : node.left,
        );
      }
      if (node.type === "TryStatement") {
        const priorAwait = suspendedAwait;
        suspendedAwait = undefined;
        const firstExit = exits.length;
        const continues = branch(
          node.block,
          node.handler?.body ?? { type: "ThrowStatement" },
          undefined,
          true,
          Boolean(node.handler),
        );
        if (suspendedAwait && node.handler && pendingUserPromises.has(suspendedAwait)) {
          const reactions = pendingPromiseReactions.get(suspendedAwait) ?? [];
          reactions.push({
            rejected: {
              type: "ArrowFunctionExpression",
              params: [],
              body: node.handler.body,
            },
            environment: new Map(environment),
            result: {},
            resumeAwait: true,
          });
          pendingPromiseReactions.set(suspendedAwait, reactions);
        }
        suspendedAwait = priorAwait;
        if (!node.finalizer) return continues;
        const beforeFinally = new Set(cleaned);
        const finalizerExit = exits.length;
        const finallyContinues = walk(node.finalizer);
        for (const exit of exits.slice(firstExit, finalizerExit)) {
          for (const value of cleaned) if (!beforeFinally.has(value)) exit.add(value);
        }
        return continues && finallyContinues;
      }
      if (node.type === "ForOfStatement") {
        if (!walk(node.right)) return false;
        const iterable = identity(node.right, environment);
        if (
          iterable?.type === "ArrayExpression" &&
          !arrayElements(iterable).some((item: AnyNode) => item?.type === "SpreadElement")
        ) {
          const control = {
            node,
            loop: true,
            continues: [] as ReturnType<typeof snapshot>[],
            breaks: [] as ReturnType<typeof snapshot>[],
          };
          controls.push(control);
          let continues = true;
          for (const element of arrayElements(iterable)) {
            bindResource(
              node.left.type === "VariableDeclaration" ? node.left.declarations[0].id : node.left,
              identity(element, environment),
              environment,
              module,
            );
            control.continues = [];
            continues = walk(node.body);
            let next = continues ? snapshot() : undefined;
            for (const state of control.continues) {
              if (next) merge(next, state);
              else restore(state);
              next = snapshot();
            }
            if (!next) break;
            continues = true;
          }
          controls.pop();
          let combined = continues ? snapshot() : undefined;
          for (const state of control.breaks) {
            if (combined) merge(combined, state);
            else restore(state);
            combined = snapshot();
          }
          return Boolean(combined);
        }
      }
      if (
        [
          "ForStatement",
          "ForInStatement",
          "ForOfStatement",
          "WhileStatement",
          "DoWhileStatement",
          "SwitchStatement",
        ].includes(node.type)
      ) {
        const pretest = node.type === "WhileStatement" || node.type === "ForStatement";
        let testResources: AnyNode[] = [];
        let mandatory = node.type === "DoWhileStatement";
        if (pretest) {
          if (!walk(node.init)) return false;
          const resourceStart = resources.length;
          if (!walk(node.test)) return false;
          const test = identity(node.test, environment);
          if (test?.type === "Literal" && !test.value) return true;
          mandatory = !node.test || (test?.type === "Literal" && !!test.value);
          testResources = resources.slice(resourceStart).map((resource) => resource.value);
        }
        const loop = node.type !== "SwitchStatement";
        const control = { node, loop, continues: [] as ReturnType<typeof snapshot>[] };
        controls.push(control);
        const nontermination = new Set(cleaned);
        if (loop) {
          exits.push(nontermination);
          abrupt = true;
        }
        {
          const before = snapshot();
          const resourceStart = resources.length;
          const firstExit = exits.length;
          let bodyStopped = false;
          const repeats =
            node.type !== "DoWhileStatement" ||
            node.test?.type !== "Literal" ||
            Boolean(node.test.value);
          if (loop && repeats) loopDepth++;
          if (node.type === "ForStatement" || node.type === "DoWhileStatement") {
            const continues = walk(node.body);
            bodyStopped = !continues && !control.continues.length;
            let updateState = continues ? snapshot() : undefined;
            for (const state of control.continues) {
              if (updateState) merge(updateState, state);
              else restore(state);
              updateState = snapshot();
            }
            if (updateState && !walk(node.type === "ForStatement" ? node.update : node.test))
              bodyStopped = true;
          } else if (loop) {
            for (const [key, child] of Object.entries(node)) {
              if (
                key !== "__doctorParent" &&
                !(node.type === "ForOfStatement" && key === "right") &&
                !(pretest && ["init", "test"].includes(key))
              )
                if (!walk(child) && key === "body") bodyStopped = !control.continues.length;
            }
          } else {
            if (!walk(node.discriminant)) {
              controls.pop();
              return false;
            }
            const discriminant = identity(node.discriminant, environment);
            const entries: { index: number; state: ReturnType<typeof snapshot> }[] = [];
            let unmatched = true;
            for (const [index, item] of node.cases.entries()) {
              if (!item.test) continue;
              if (!walk(item.test)) {
                unmatched = false;
                break;
              }
              const test = identity(item.test, environment);
              const known = discriminant?.type === "Literal" && test?.type === "Literal";
              if (!known || discriminant.value === test.value)
                entries.push({ index, state: snapshot() });
              if (known && discriminant.value === test.value) {
                unmatched = false;
                break;
              }
            }
            if (unmatched)
              entries.push({
                index: node.cases.findIndex((item: AnyNode) => !item.test),
                state: snapshot(),
              });
            let combined: ReturnType<typeof snapshot> | undefined;
            for (const { index, state } of entries) {
              restore(state);
              if (index >= 0)
                walk(node.cases.slice(index).flatMap((item: AnyNode) => item.consequent));
              if (combined) merge(combined, snapshot());
              combined = snapshot();
            }
          }
          if (loop && repeats) loopDepth--;
          if (!bodyStopped) {
            for (const value of testResources) repeated.add(value);
          }
          controls.pop();
          const iterationCleaned = resources
            .slice(resourceStart)
            .filter(
              (resource) =>
                cleaned.has(resource.value) &&
                exits.slice(firstExit).every((exit) => exit.has(resource.value)),
            );
          if (bodyStopped) exits.splice(exits.indexOf(nontermination), 1);
          if (loop && !mandatory) merge(before, snapshot());
          if (mandatory && !bodyStopped) {
            nontermination.clear();
            for (const value of cleaned) nontermination.add(value);
          }
          if (loop) {
            for (const resource of iterationCleaned) {
              repeated.delete(resource.value);
              cleaned.add(resource.value);
              for (const exit of exits) exit.add(resource.value);
            }
          }
        }
        return true;
      }
      if (node.type === "BreakStatement" || node.type === "ContinueStatement") {
        const target = node.type === "BreakStatement" && labels.get(node.label?.name);
        if (target) {
          const exit = new Set(cleaned);
          exits.push(exit);
          target.push({ exit, state: snapshot() });
          return false;
        }
        if (node.type === "BreakStatement" && !node.label && controls.at(-1)?.breaks) {
          controls.at(-1)!.breaks!.push(snapshot());
          return false;
        }
        if (node.type === "ContinueStatement") {
          const control = controls.findLast(
            (item) =>
              item.loop &&
              (!node.label ||
                (item.node.__doctorParent?.type === "LabeledStatement" &&
                  item.node.__doctorParent.label.name === node.label.name)),
          );
          control?.continues.push(snapshot());
          if (control?.breaks) return false;
        }
        if (controls.at(-1)?.loop || node.type === "ContinueStatement" || node.label)
          exits.push(new Set(cleaned));
        return false;
      }
      if (
        node.type === "ChainExpression" ||
        node.type === "CallExpression" ||
        node.type === "MemberExpression"
      ) {
        if (optionalSkipped.delete(node)) returned.delete(node);
        const base =
          node.type === "ChainExpression"
            ? node.expression
            : node.type === "CallExpression"
              ? node.callee
              : node.object;
        if (!walk(base)) return false;
        const value = identity(base, environment);
        if (
          (node.optional &&
            (value === undefined || (value?.type === "Literal" && value.value == null))) ||
          optionalSkipped.has(base)
        ) {
          if (node.type !== "ChainExpression") optionalSkipped.add(node);
          returned.set(node, { type: "Literal", value: undefined });
          return true;
        }
        if (node.type === "ChainExpression") {
          returned.set(node, value);
          return true;
        }
        if (node.type === "MemberExpression") {
          if (node.computed && !walk(node.property)) return false;
          const object = identity(node.object, environment);
          const key = propertyKey(node, environment);
          const classGetter = classGetters.get(object)?.get(key!);
          if (classGetter && !properties.get(object)?.has(key!)) {
            const completion = inspect(classGetter, [], environment, module, object);
            returned.set(node, completion.value);
            if (completion.abrupt) {
              abrupt = true;
              exits.push(new Set(cleaned));
              thrownExits.add(exits[exits.length - 1]);
              throwStates.set(exits[exits.length - 1], snapshot());
            }
            return completion.normal;
          }
          if (object?.type === "ObjectExpression" && key !== undefined) {
            const descriptor = effectiveProperties(object, environment).get(key);
            const property = descriptor?.property;
            if (
              descriptor?.accessor &&
              property?.kind === "get" &&
              !properties.get(object)?.has(key)
            ) {
              const completion = inspect(
                property.value,
                [],
                environment,
                module,
                descriptor!.receiver,
              );
              returned.set(node, completion.value);
              if (completion.abrupt) {
                abrupt = true;
                exits.push(new Set(cleaned));
                thrownExits.add(exits[exits.length - 1]);
                throwStates.set(exits[exits.length - 1], snapshot());
              }
              return completion.normal;
            }
          }
          return true;
        }
        if (!walk(node.arguments)) return false;
        return visit(node) !== false;
      }
      if (node.type === "AwaitExpression") {
        if (!walk(node.argument)) return false;
        const awaited = identity(node.argument, environment);
        if (!asyncFunction && microtasks.length) drainMicrotasks();
        const completion = promiseCompletions.get(awaited);
        if (
          asyncFunction &&
          (pendingFetchPromises.has(awaited) ||
            completion?.normal ||
            (pendingUserPromises.has(awaited) && !completion?.abrupt) ||
            !completion)
        )
          pendingAwait = awaited;
        if (completion?.abrupt) {
          abrupt = true;
          exits.push(new Set(cleaned));
          thrownExits.add(exits[exits.length - 1]);
          throwStates.set(exits[exits.length - 1], snapshot());
        }
        return !pendingAwait && (completion?.normal ?? true);
      }
      if (node.type === "TaggedTemplateExpression") {
        if (!walk(node.tag) || !walk(node.quasi)) return false;
        const completion = inspect(
          node.tag,
          [{ type: "ArrayExpression", elements: [] }, ...node.quasi.expressions],
          environment,
          module,
        );
        if (completion.value) returned.set(node, completion.value);
        return completion.normal;
      }
      if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        node.left.type === "MemberExpression"
      ) {
        if (!walk(node.left.object)) return false;
        if (node.left.computed && !walk(node.left.property)) return false;
        if (!walk(node.right) || visit(node) === false) return false;
        returned.set(node, identity(node.right, environment));
        return true;
      }
      const bindsValue =
        node.type === "VariableDeclarator" ||
        node.type === "AssignmentExpression" ||
        node.type === "CallExpression" ||
        node.type === "NewExpression";
      if (!bindsValue && visit(node) === false) return false;
      for (const [key, child] of Object.entries(node)) {
        if (
          key !== "__doctorParent" &&
          !(node.type === "NewExpression" && key === "callee") &&
          !walk(child)
        )
          return false;
      }
      if (bindsValue && visit(node) === false) return false;
      if (node.type === "AssignmentExpression" && node.operator === "=")
        returned.set(node, identity(node.right, environment));
      if (node.type === "SequenceExpression")
        returned.set(node, identity(node.expressions.at(-1), environment));
      if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
        if (module) exitedDisposers.push(...disposers);
        exits.push(new Set(cleaned));
        if (node.type === "ReturnStatement") {
          normal = true;
          returns.push(identity(node.argument, environment));
          returnPaths.push(new Map(currentPath));
        } else {
          abrupt = true;
          thrownExits.add(exits[exits.length - 1]);
          throwStates.set(exits[exits.length - 1], snapshot());
        }
        return false;
      }
      return true;
    };
    walk = (node) => {
      const continues = walkNode(node);
      if (continues && !pendingAwait && node?.type && node.type !== "BlockStatement")
        completed.add(node);
      return continues;
    };
    if (walk(root)) {
      normal = true;
      returns.push(
        root.type === "BlockStatement" || root.type === "Program"
          ? undefined
          : identity(root, environment),
      );
      returnPaths.push(new Map(currentPath));
      exits.push(new Set(cleaned));
    }
    for (const value of cleaned) {
      if (exits.some((exit) => !exit.has(value))) cleaned.delete(value);
    }
    if (module) disposers = [...new Set([...disposers, ...exitedDisposers])];
    let value = returns[0];
    if (!returns.every((item) => item === value)) {
      value = {};
      callbackChoices.set(
        value,
        returns.flatMap((item) => callbackChoices.get(item) ?? [item]),
      );
      const handles = returns
        .flatMap((item) => alternatives.get(item) ?? [item])
        .filter((handle) => resources.some((resource) => resource.value === handle));
      if (
        handles.every((handle) =>
          returns.every(
            (item, index) =>
              (alternatives.get(item) ?? [item]).includes(handle) ||
              [...(resourcePaths.get(handle) ?? [])].some(
                ([condition, side]) =>
                  returnPaths[index].has(condition) && returnPaths[index].get(condition) !== side,
              ),
          ),
        )
      )
        alternatives.set(value, handles);
    }
    return { normal, abrupt, value, suspended: Boolean(suspendedAwait) };
  }
  const drainMicrotasks = () => {
    while (microtasks.length) {
      const { callback, args, environment, result, resumeAwait, task } = microtasks.shift()!;
      if (task) {
        task();
        continue;
      }
      const completion = adoptPromise(inspect(callback, args ?? [], environment, true));
      if (resumeAwait)
        for (const binding of values.keys()) {
          if (environment.has(binding)) values.set(binding, environment.get(binding));
        }
      if (result) {
        promiseCompletions.set(result, completion);
        if (completion.normal) promises.set(result, completion.value);
        enqueueReactions(result, completion);
      }
    }
  };
  evaluate(program, values, true);
  drainMicrotasks();
  const captureDisposalState = () => ({
    cleaned: new Set(cleaned),
    values: new Map(values),
    properties: new Map([...properties].map(([key, entries]) => [key, new Map(entries)])),
    resources: [...resources],
    resourceCount: resources.length,
  });
  const restoreDisposalState = (state: ReturnType<typeof captureDisposalState>) => {
    cleaned.clear();
    for (const value of state.cleaned) cleaned.add(value);
    values.clear();
    for (const [key, value] of state.values) values.set(key, value);
    properties.clear();
    for (const [key, entries] of state.properties) properties.set(key, new Map(entries));
    resources.splice(0, resources.length, ...state.resources);
  };
  const disposalStates = [captureDisposalState()];
  const beforeListeners = captureDisposalState();
  let truncatedListenerOrders = false;
  const fireListener = (listener: Listener) => {
    if (cleaned.has(listener.value)) return;
    const parentPath = currentPath;
    currentPath = new Map([...parentPath, ...listener.path]);
    const event = {
      type: "ObjectExpression",
      properties: [
        {
          type: "Property",
          key: { type: "Identifier", name: "type" },
          value: { type: "Literal", value: listener.event },
          kind: "init",
          computed: false,
        },
      ],
    };
    const functionListener =
      callbacks.has(listener.handler) ||
      lexicalEnvironments.has(listener.handler) ||
      ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
        listener.handler?.type,
      );
    for (let firing = 0; firing < (listener.once ? 1 : 8); firing++) {
      if (cleaned.has(listener.value)) break;
      const beforeFiring = captureDisposalState();
      timerSimulationDepth = 1;
      const descriptor = effectiveProperties(listener.handler, values).get("handleEvent");
      const classGetter = classGetters.get(listener.handler)?.get("handleEvent");
      const getter =
        !functionListener && !properties.get(listener.handler)?.has("handleEvent")
          ? classGetter
            ? inspect(classGetter, [], values, false, listener.handler)
            : descriptor?.accessor && descriptor.property.kind === "get"
              ? inspect(descriptor.property.value, [], values, false, descriptor.receiver)
              : undefined
          : undefined;
      const handler = getter
        ? getter.value
        : identity(
            {
              type: "MemberExpression",
              object: listener.handler,
              property: { type: "Identifier", name: "handleEvent" },
              computed: false,
            },
            values,
          );
      if (!getter || getter.normal)
        inspect(
          functionListener ? listener.handler : handler,
          [event],
          values,
          false,
          functionListener ? listener.receiver : listener.handler,
        );
      timerSimulationDepth = 0;
      drainMicrotasks();
      const afterFiring = captureDisposalState();
      disposalStates.push(afterFiring);
      if (
        beforeFiring.resources.length === afterFiring.resources.length &&
        beforeFiring.cleaned.size === afterFiring.cleaned.size &&
        beforeFiring.values.size === afterFiring.values.size &&
        [...beforeFiring.values].every(([key, value]) => afterFiring.values.get(key) === value) &&
        [...beforeFiring.cleaned].every((value) => afterFiring.cleaned.has(value))
      )
        break;
      if (
        firing === 7 &&
        !cleaned.has(listener.value) &&
        beforeFiring.resources.length === afterFiring.resources.length
      )
        truncatedListenerOrders = true;
    }
    currentPath = parentPath;
  };
  let listenerOrderCount = 0;
  const fireOrders = (remaining: Listener[]) => {
    if (listenerOrderCount++ >= 2048) {
      truncatedListenerOrders = true;
      return;
    }
    if (!remaining.length) {
      disposalStates.push(captureDisposalState());
      return;
    }
    const before = captureDisposalState();
    for (const [index, listener] of remaining.entries()) {
      restoreDisposalState(before);
      fireListener(listener);
      fireOrders(remaining.filter((_, position) => position !== index));
    }
    restoreDisposalState(before);
  };
  fireOrders(listeners);
  restoreDisposalState(beforeListeners);
  const fireSubscriptions = (state: ReturnType<typeof captureDisposalState>, depth: number) => {
    if (depth === 2) return;
    for (const { callback, environment } of subscriptions) {
      restoreDisposalState(state);
      timerSimulationDepth = 1;
      inspect(callback, [], environment);
      timerSimulationDepth = 0;
      drainMicrotasks();
      const emitted = captureDisposalState();
      disposalStates.push(emitted);
      fireSubscriptions(emitted, depth + 1);
    }
  };
  fireSubscriptions(beforeListeners, 0);
  const mayCreateResource = (node: AnyNode, seen = new Set<object>()): boolean => {
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((child) => mayCreateResource(child, seen));
    if (
      (node.type === "Identifier" &&
        ["setInterval", "setTimeout", "WebSocket", "EventSource"].includes(node.name)) ||
      (node.type === "CallExpression" && node.callee?.property?.name === "subscribe")
    )
      return true;
    return Object.entries(node).some(
      ([key, child]) => key !== "__doctorParent" && mayCreateResource(child, seen),
    );
  };
  const hasConditionalCreation = (node: AnyNode, seen = new Set<object>()): boolean => {
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((child) => hasConditionalCreation(child, seen));
    if (
      ["IfStatement", "ConditionalExpression", "LogicalExpression", "SwitchStatement"].includes(
        node.type,
      ) &&
      mayCreateResource(node)
    )
      return true;
    return Object.entries(node).some(
      ([key, child]) => key !== "__doctorParent" && hasConditionalCreation(child, seen),
    );
  };
  let timerOrderCount = 0;
  let truncatedTimerOrders = false;
  for (const listenerState of disposalStates.slice()) {
    restoreDisposalState(listenerState);
    const fireTimeouts = (remaining: typeof pendingTimeouts) => {
      if (timerOrderCount++ >= 2048) {
        truncatedTimerOrders = true;
        return;
      }
      if (!remaining.length) return;
      const before = captureDisposalState();
      const knownDelays = remaining.every(
        ({ delay }) => delay?.type === "Literal" && Number.isFinite(Number(delay.value)),
      );
      const earliest = knownDelays
        ? Math.min(...remaining.map(({ delay }) => Number(delay.value)))
        : undefined;
      for (const [index, { timeout, callback, args, environment, delay }] of remaining.entries()) {
        if (knownDelays && Number(delay.value) !== earliest) continue;
        restoreDisposalState(before);
        const scheduledBefore = pendingTimeouts.length;
        if (resources.some((resource) => resource.value === timeout) && !cleaned.has(timeout)) {
          const listenerCount = listeners.length;
          timerSimulationDepth = 1;
          inspect(callback, args, environment, false);
          timerSimulationDepth = 0;
          drainMicrotasks();
          if (resources.find((resource) => resource.value === timeout)?.kind === "timeout")
            cleaned.add(timeout);
          disposalStates.push(captureDisposalState());
          for (const listener of listeners.slice(listenerCount)) fireListener(listener);
          if (resources.find((resource) => resource.value === timeout)?.kind === "interval") {
            for (let firing = 1; firing < 8 && !cleaned.has(timeout); firing++) {
              const nextListenerCount = listeners.length;
              inspect(callback, args, environment, false);
              drainMicrotasks();
              disposalStates.push(captureDisposalState());
              for (const listener of listeners.slice(nextListenerCount)) fireListener(listener);
            }
            if (
              !cleaned.has(timeout) &&
              hasConditionalCreation(callbacks.get(callback) ?? callback)
            )
              truncatedTimerOrders = true;
          }
        }
        fireTimeouts([
          ...remaining.filter((_, position) => position !== index),
          ...pendingTimeouts.slice(scheduledBefore),
        ]);
        pendingTimeouts.length = scheduledBefore;
      }
      restoreDisposalState(before);
    };
    fireTimeouts(pendingTimeouts.slice());
  }
  let disposalLeak: string | undefined;
  for (const state of disposalStates) {
    restoreDisposalState(state);
    const outcomes = disposers.map(({ callback: disposer, path: disposerPath }) => {
      const resourceStart = resources.length;
      cleaned.clear();
      for (const value of state.cleaned) cleaned.add(value);
      values.clear();
      for (const [key, value] of state.values) values.set(key, value);
      properties.clear();
      for (const [key, entries] of state.properties) properties.set(key, new Map(entries));
      inspect(
        callbacks.get(disposer) && !lexicalEnvironments.has(disposer)
          ? callbacks.get(disposer)
          : disposer,
        [
          identity({
            type: "MemberExpression",
            object: {
              type: "MemberExpression",
              object: {
                type: "MetaProperty",
                meta: { name: "import" },
                property: { name: "meta" },
              },
              property: { name: "hot" },
              computed: false,
            },
            property: { name: "data" },
            computed: false,
          }),
        ],
      );
      if (
        resources.some(
          (resource) => resource.value === disposer && resource.kind === "subscription",
        )
      )
        cleaned.add(disposer);
      disposalLeak ??= resources
        .slice(resourceStart)
        .find((resource) => repeated.has(resource.value) || !cleaned.has(resource.value))?.kind;
      for (const { callback, args, environment } of lateReactions) {
        const beforeReactionState = captureDisposalState();
        const beforeReaction = resources.length;
        inspect(callback, args, environment);
        disposalLeak ??= resources
          .slice(beforeReaction)
          .find((resource) => repeated.has(resource.value) || !cleaned.has(resource.value))?.kind;
        restoreDisposalState(beforeReactionState);
      }
      resources.splice(resourceStart);
      for (const resource of resources.slice(0, state.resourceCount)) {
        const createdPath = resourcePaths.get(resource.value);
        if (
          createdPath &&
          [...createdPath].some(
            ([choice, side]) => disposerPath.has(choice) && disposerPath.get(choice) !== side,
          )
        )
          cleaned.add(resource.value);
      }
      return new Set(cleaned);
    });
    disposalLeak ??= resources
      .slice(0, state.resourceCount)
      .find(
        (resource) =>
          repeated.has(resource.value) || outcomes.some((outcome) => !outcome.has(resource.value)),
      )?.kind;
  }
  if (!disposalLeak && (truncatedListenerOrders || truncatedSetIteration || truncatedTimerOrders)) {
    if (mayCreateResource(program)) return "resource";
  }
  return disposalLeak ?? null;
}

function unwrapResourceExpression(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "ParenthesizedExpression",
    ].includes(node.type)
  )
    node = node.expression ?? node.argument;
  return node;
}

type ResourceScope = {
  parent?: ResourceScope;
  bindings: Map<string, AnyNode>;
  functionScope: boolean;
};

function resourceBindings(program: AnyNode): (node: AnyNode) => AnyNode {
  const scopes = new WeakMap<AnyNode, ResourceScope>();
  function bind(pattern: AnyNode, scope: ResourceScope): void {
    if (!pattern) return;
    if (pattern.type === "Identifier") scope.bindings.set(pattern.name, pattern);
    else if (pattern.type === "RestElement") bind(pattern.argument, scope);
    else if (pattern.type === "AssignmentPattern") bind(pattern.left, scope);
    else if (pattern.type === "ArrayPattern")
      for (const item of pattern.elements) bind(item, scope);
    else if (pattern.type === "ObjectPattern")
      for (const item of pattern.properties)
        bind(item.type === "RestElement" ? item.argument : item.value, scope);
  }
  function index(node: AnyNode, scope: ResourceScope): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) index(child, scope);
      return;
    }
    if (typeof node.type !== "string") return;
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration")
      bind(node.id, scope);
    const isFunction = [
      "ArrowFunctionExpression",
      "FunctionExpression",
      "FunctionDeclaration",
    ].includes(node.type);
    if (
      isFunction ||
      [
        "BlockStatement",
        "ClassExpression",
        "CatchClause",
        "ForStatement",
        "ForOfStatement",
        "ForInStatement",
        "SwitchStatement",
      ].includes(node.type)
    ) {
      scope = { parent: scope, bindings: new Map(), functionScope: isFunction };
      if (isFunction) {
        if (node.type === "FunctionExpression") bind(node.id, scope);
        for (const param of node.params) bind(param, scope);
      }
      if (node.type === "ClassExpression") bind(node.id, scope);
      if (node.type === "CatchClause") bind(node.param, scope);
    }
    scopes.set(node, scope);
    if (node.type === "VariableDeclaration") {
      let owner = scope;
      if (node.kind === "var") while (!owner.functionScope && owner.parent) owner = owner.parent;
      for (const declaration of node.declarations) bind(declaration.id, owner);
    }
    if (node.type === "ImportDeclaration")
      for (const specifier of node.specifiers) bind(specifier.local, scope);
    for (const [key, child] of Object.entries(node)) {
      if (key !== "__doctorParent") index(child, scope);
    }
  }
  index(program, { bindings: new Map(), functionScope: true });
  return (node) => {
    if (node?.type !== "Identifier") return undefined;
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      if (scope.bindings.has(node.name)) return scope.bindings.get(node.name);
    }
    return undefined;
  };
}

function walkEvaluation(node: AnyNode, visit: (node: AnyNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkEvaluation(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type))
    return;
  for (const [key, child] of Object.entries(node)) {
    if (key !== "__doctorParent") walkEvaluation(child, visit);
  }
}

function isPluginSource(path: string): boolean {
  return isViteConfigFile(path) || /(?:^|\/)plugins?\/.*\.[cm]?[jt]s$/.test(path);
}

function isPluginObject(node: AnyNode): boolean {
  if (node?.type !== "ObjectExpression") return false;
  return (node.properties ?? []).some((property: AnyNode) =>
    ["config", "resolveId", "load", "transform", "generateBundle", "writeBundle"].includes(
      property.key?.name ?? property.key?.value,
    ),
  );
}

function isTransformProperty(node: AnyNode): boolean {
  return (
    (node?.type === "Property" || node?.type === "ObjectProperty") &&
    (node.key?.name ?? node.key?.value) === "transform"
  );
}

function isServerSidePath(path: string): boolean {
  return /(?:^|\/)(?:src\/node|server|node|packages\/vite\/src\/node)\//.test(path);
}

function isFixturePath(path: string): boolean {
  return /(?:^|\/)(?:playground|fixtures?|test|tests|__tests__)\//.test(path);
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n\r]*/g, "")
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, "");
}
