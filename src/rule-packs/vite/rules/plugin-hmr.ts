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
        const hasDispose = /import\.meta\.hot\.dispose\s*\(/.test(text);
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
  };
  type Completion = { normal: boolean; abrupt: boolean; value?: AnyNode };
  const resources: Resource[] = [];
  const repeated = new Set<AnyNode>();
  let loopDepth = 0;
  const listeners: Listener[] = [];
  const thisBinding = {};
  const lexicalReceivers = new Map<AnyNode, AnyNode>();
  const lexicalEnvironments = new Map<AnyNode, Map<AnyNode, AnyNode>>();
  const alternatives = new Map<AnyNode, AnyNode[]>();
  const callbackChoices = new Map<AnyNode, AnyNode[]>();
  const superConstructors = new Map<AnyNode, (args: AnyNode[]) => Completion>();
  const values = new Map<AnyNode, AnyNode>();
  const returned = new Map<AnyNode, AnyNode>();
  const optionalSkipped = new Set<AnyNode>();
  const callbacks = new Map<AnyNode, AnyNode>();
  const properties = new Map<AnyNode, Map<string, AnyNode>>();
  const members = new Map<AnyNode, Map<string, AnyNode>>();
  const propertyKey = (node: AnyNode): string | undefined =>
    node?.computed ? node.property?.value : node?.property?.name;
  const cleaned = new Set<AnyNode>();
  const visited = new Set<AnyNode>();
  type Disposer = { callback: AnyNode; path: Map<object, boolean> };
  let currentPath = new Map<object, boolean>();
  const conditions = new Map<AnyNode, object>();
  const resourcePaths = new Map<AnyNode, Map<object, boolean>>();
  let disposers: Disposer[] = [{ callback: undefined, path: new Map() }];
  const identity = (node: AnyNode, environment = values): AnyNode => {
    node = unwrapResourceExpression(node);
    if (node?.type === "ThisExpression") return environment.get(thisBinding);
    if (returned.has(node)) return identity(returned.get(node), environment);
    if (node?.type === "MemberExpression") {
      const key = propertyKey(node);
      if (key !== undefined) {
        const object = identity(node.object, environment);
        const stored = properties.get(object);
        if (stored?.has(key)) return stored.get(key);
        if (object?.type === "ArrayExpression" && /^(0|[1-9]\d*)$/.test(String(key))) {
          if (
            object.elements
              .slice(0, Number(key) + 1)
              .some((item: AnyNode) => item?.type === "SpreadElement")
          )
            return node;
          return identity(object.elements[Number(key)], environment);
        }
        if (object?.type === "ObjectExpression") {
          const property = object.properties.find(
            (item: AnyNode) => !item.computed && (item.key?.name ?? item.key?.value) === key,
          );
          if (property)
            return property.kind === "get" || property.kind === "set"
              ? node
              : identity(property.value, environment);
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
  const receiverIdentity = (node: AnyNode, environment: Map<AnyNode, AnyNode>): AnyNode => {
    node = unwrapResourceExpression(node);
    return identity(node, environment);
  };
  const capture = (node: AnyNode, environment: Map<AnyNode, AnyNode>): unknown => {
    node = identity(node, environment);
    if (!node) return false;
    if (node.type === "ObjectExpression") {
      if (properties.get(node)?.has("capture"))
        return capture(properties.get(node)!.get("capture"), environment);
      const property = node.properties.find(
        (item: AnyNode) => (item.key?.name ?? item.key?.value) === "capture",
      );
      return property ? capture(property.value, environment) : false;
    }
    return node.type === "Literal" ? Boolean(node.value) : node;
  };
  function bindResource(
    pattern: AnyNode,
    argument: AnyNode,
    local: Map<AnyNode, AnyNode>,
    module = false,
  ): void {
    const read = (object: AnyNode, key: string): AnyNode =>
      identity(
        {
          type: "MemberExpression",
          object,
          property: { type: "Literal", value: key },
          computed: true,
        },
        local,
      );
    const bind = (pattern: AnyNode, argument: AnyNode): void => {
      if (!pattern) return;
      if (pattern.type === "Identifier") local.set(pattern, argument);
      else if (pattern.type === "AssignmentPattern") {
        const useDefault =
          argument === undefined ||
          argument === "undefined" ||
          (argument?.type === "UnaryExpression" && argument.operator === "void");
        if (useDefault) evaluate(pattern.right, local, module);
        bind(pattern.left, useDefault ? identity(pattern.right, local) : argument);
      } else if (pattern.type === "ArrayPattern" && argument?.type === "ArrayExpression") {
        for (const [index, element] of pattern.elements.entries()) {
          if (element?.type === "RestElement")
            bind(element.argument, {
              type: "ArrayExpression",
              elements: argument.elements
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
    bind(pattern, argument);
  }
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
            ? forwarded.elements
            : [],
        environment,
        module,
        identity(args[0], environment),
      );
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
    const local = new Map([...(captured ?? []), ...environment]);
    if (target.type === "FunctionExpression" && target.id) local.set(target.id, target);
    local.set(thisBinding, receiver);
    for (const [index, param] of target.params.entries()) {
      if (param.type === "RestElement")
        bindResource(
          param.argument,
          {
            type: "ArrayExpression",
            elements: args.slice(index).map((arg) => identity(arg, environment)),
          },
          local,
        );
      else bindResource(param, identity(args[index], environment), local, module);
    }
    const parentPath = currentPath;
    const completion = evaluate(target.body, local, module);
    currentPath = parentPath;
    for (const binding of environment.keys()) {
      if (binding !== thisBinding && local.has(binding))
        environment.set(binding, local.get(binding));
    }
    visited.delete(target);
    return target.async ? { ...completion, value: {} } : completion;
  }
  function evaluate(
    root: AnyNode,
    environment: Map<AnyNode, AnyNode>,
    module: boolean,
  ): Completion {
    const exits: Set<AnyNode>[] = [];
    const exitedDisposers: Disposer[] = [];
    const thrownExits = new Set<Set<AnyNode>>();
    const throwStates = new Map<Set<AnyNode>, ReturnType<typeof snapshot>>();
    let normal = false;
    let abrupt = false;
    const returns: AnyNode[] = [];
    const returnPaths: Map<object, boolean>[] = [];
    walkEvaluation(root, (node) => {
      if (node.type === "FunctionDeclaration" && node.id) callbacks.set(node.id, node);
    });
    const visit = (node: AnyNode) => {
      if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
        const key = propertyKey(node.left);
        if (key !== undefined) {
          const object = identity(node.left.object, environment);
          if (!properties.has(object)) properties.set(object, new Map());
          properties
            .get(object)!
            .set(key, node.operator === "=" ? identity(node.right, environment) : node);
        }
      }
      const handle =
        node.type === "VariableDeclarator"
          ? node.id
          : node.type === "AssignmentExpression"
            ? node.left
            : null;
      if (handle && ["ObjectPattern", "ArrayPattern"].includes(handle.type))
        bindResource(handle, identity(node.init ?? node.right, environment), environment);
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
      }
      if (node.type !== "CallExpression") return;
      const calleeGlobal = identity(node.callee?.object, environment);
      const globalAlias = ["window", "globalThis", "self"].includes(calleeGlobal);
      const calleeValue = identity(node.callee, environment);
      const callee = globalAlias
        ? `window.${propertyKey(node.callee)}`
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
      const method =
        node.callee.type === "Identifier" ? node.callee.name : propertyKey(node.callee);
      const replacedMethod =
        node.callee.type === "MemberExpression" &&
        properties.get(identity(node.callee.object, environment))?.has(method!);
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
        const options = capture(node.arguments[2], environment);
        if (method === "addEventListener") {
          const listenerOptions = identity(node.arguments[2], environment);
          const signal = identity(
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
          listeners.push({ receiver, event, handler, capture: options, controller, value: node });
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
      if (
        array?.type === "ArrayExpression" &&
        !replacedMethod &&
        ["forEach", "map", "filter"].includes(method!)
      ) {
        const expand = (items: AnyNode[], seen = new Set<AnyNode>()): AnyNode[] =>
          items.flatMap((item) => {
            if (item?.type !== "SpreadElement") return [item];
            const spread = identity(item.argument, environment);
            if (spread?.type !== "ArrayExpression" || seen.has(spread)) return [item];
            return expand(spread.elements, new Set([...seen, spread])).map(
              (value) => value ?? { type: "Identifier", name: "undefined" },
            );
          });
        const elements: AnyNode[] = [];
        let knownSelection = true;
        for (const [index, element] of expand(array.elements).entries()) {
          if (!element || element.type === "SpreadElement") continue;
          const call = {
            type: "CallExpression",
            callee: node.arguments[0],
            arguments: [identity(element, environment), { type: "Literal", value: index }, array],
          };
          if (visit(call) === false) return false;
          const result = returned.get(call);
          if (method === "filter") {
            if (result?.type === "Literal") {
              if (result.value) elements.push(identity(element, environment));
            } else knownSelection = false;
          } else elements.push(result);
        }
        if (method === "map" || (method === "filter" && knownSelection))
          returned.set(node, { type: "ArrayExpression", elements });
        return true;
      }
      const completion =
        node.callee.type === "Super"
          ? (superConstructors.get(environment.get(thisBinding))?.(
              node.arguments.map((arg: AnyNode) => identity(arg, environment)),
            ) ?? { normal: true, abrupt: false })
          : inspect(node.callee, node.arguments, environment, module);
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
      const mergeValue = (a: AnyNode, b: AnyNode) => {
        if (a === b) return a;
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
      const conditionValue =
        condition?.type === "Identifier" ? identity(condition, environment) : undefined;
      if (conditionValue !== undefined && !conditions.has(conditionValue))
        conditions.set(conditionValue, {});
      const choice = conditions.get(conditionValue) ?? {};
      const selectPath = (side: boolean) => {
        if (!module || includeAbrupt) return;
        currentPath = new Map(parentPath).set(choice, side);
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
        if (throws.length) {
          restore(throwStates.get(throws[0])!);
          for (const exit of throws.slice(1)) merge(snapshot(), throwStates.get(exit)!);
        }
      }
      selectPath(inverted);
      const rightContinues = walk(right);
      abrupt ||= leftAbrupt && (!catches || leftExits.some((exit) => !thrownExits.has(exit)));
      const rightValue = identity(right, environment);
      const afterRight = snapshot();
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
        if (choices.every((value) => created.has(value))) {
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
    const walk = (node: AnyNode): boolean => {
      if (!node || typeof node !== "object") return true;
      if (Array.isArray(node)) return node.every(walk);
      if (typeof node.type !== "string") return true;
      if (
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      ) {
        if (node.type !== "FunctionDeclaration") {
          const closure = {};
          lexicalEnvironments.set(closure, environment);
          if (node.type === "ArrowFunctionExpression")
            lexicalReceivers.set(closure, environment.get(thisBinding));
          callbacks.set(closure, node);
          returned.set(node, closure);
        }
        visit(node);
        return true;
      }
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        if (node.id) environment.set(resolve(node.id), node);
        if (!properties.has(node)) properties.set(node, new Map());
        for (const field of node.body.body) {
          if (field.static && field.type === "MethodDefinition" && field.kind === "method") {
            const key = field.computed
              ? identity(field.key, environment)?.value
              : (field.key?.name ?? field.key?.value);
            if (key !== undefined) properties.get(node)!.set(key, field.value);
          }
        }
        if (!walk(node.superClass)) return false;
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
      if (node.type === "NewExpression") {
        if (!walk(node.callee)) return false;
        const value = identity(node.callee, environment);
        const target = callbacks.get(value) ?? value;
        if (
          value === "Promise" ||
          (value?.type === "MemberExpression" &&
            propertyKey(value) === "Promise" &&
            ["window", "globalThis", "self"].includes(identity(value.object, environment)))
        ) {
          if (!walk(node.arguments)) return false;
          inspect(node.arguments[0], [{}, {}], environment, module);
          returned.set(node, {});
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
            const initialize = (): void => {
              for (const field of fields) {
                if (field.static) continue;
                const key = field.computed
                  ? identity(field.key, local)?.value
                  : (field.key?.name ?? field.key?.value);
                if (field.type === "PropertyDefinition") {
                  if (field.value) evaluate(field.value, local, module);
                  if (key !== undefined)
                    properties.get(instance)!.set(key, identity(field.value, local));
                } else if (key !== undefined && field.kind !== "constructor") {
                  properties.get(instance)!.set(key, field.value);
                }
              }
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
            const initializeBase = (baseArgs: AnyNode[]): Completion => {
              const completion = construct(base, baseArgs, instance);
              if (!completion.normal) return completion;
              if (completion.value) {
                instance = completion.value;
                local.set(thisBinding, instance);
                if (!properties.has(instance)) properties.set(instance, new Map());
              }
              initialize();
              return completion;
            };
            const constructor =
              fields.find((field: AnyNode) => field.kind === "constructor")?.value ??
              (["FunctionDeclaration", "FunctionExpression"].includes(target.type)
                ? target
                : undefined);
            let completion: Completion = { normal: true, abrupt: false };
            if (constructableBase) {
              if (constructor) superConstructors.set(instance, initializeBase);
              else completion = initializeBase(args);
            } else initialize();
            if (constructor) completion = inspect(constructor, args, environment, module, instance);
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
        if (test?.type === "Literal" || memberPath(node.test) === "import.meta.hot") {
          const selected =
            test?.type === "Literal" && !test.value ? node.alternate : node.consequent;
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
        const resource = resources.some((resource) => resource.value === left);
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
        const known = left?.type === "Literal" || left === "undefined";
        if (known) {
          const value = left === "undefined" ? undefined : left.value;
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
        return branch(node.right, null);
      }
      if (node.type === "TryStatement") {
        const firstExit = exits.length;
        const continues = branch(
          node.block,
          node.handler?.body ?? { type: "ThrowStatement" },
          undefined,
          true,
          Boolean(node.handler),
        );
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
          !iterable.elements.some((item: AnyNode) => item?.type === "SpreadElement")
        ) {
          const control = {
            node,
            loop: true,
            continues: [] as ReturnType<typeof snapshot>[],
            breaks: [] as ReturnType<typeof snapshot>[],
          };
          controls.push(control);
          let continues = true;
          for (const element of iterable.elements) {
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
        if (pretest) {
          if (!walk(node.init)) return false;
          const resourceStart = resources.length;
          if (!walk(node.test)) return false;
          const test = identity(node.test, environment);
          if (test?.type === "Literal" && !test.value) return true;
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
          if (loop) loopDepth++;
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
          if (loop) loopDepth--;
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
          if (loop) merge(before, snapshot());
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
        if (node.type === "MemberExpression") return !node.computed || walk(node.property);
        if (!walk(node.arguments)) return false;
        return visit(node) !== false;
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
    return { normal, abrupt, value };
  }
  evaluate(program, values, true);
  const initialCleaned = new Set(cleaned);
  const initialValues = new Map(values);
  const initialProperties = new Map(
    [...properties].map(([key, entries]) => [key, new Map(entries)]),
  );
  let disposalLeak: string | undefined;
  const outcomes = disposers.map(({ callback: disposer, path: disposerPath }) => {
    const resourceStart = resources.length;
    cleaned.clear();
    for (const value of initialCleaned) cleaned.add(value);
    values.clear();
    for (const [key, value] of initialValues) values.set(key, value);
    properties.clear();
    for (const [key, entries] of initialProperties) properties.set(key, new Map(entries));
    inspect(
      callbacks.get(disposer) && !lexicalEnvironments.has(disposer)
        ? callbacks.get(disposer)
        : disposer,
    );
    if (
      resources.some((resource) => resource.value === disposer && resource.kind === "subscription")
    )
      cleaned.add(disposer);
    disposalLeak ??= resources
      .slice(resourceStart)
      .find((resource) => repeated.has(resource.value) || !cleaned.has(resource.value))?.kind;
    resources.splice(resourceStart);
    for (const resource of resources) {
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
  for (const value of cleaned)
    if (outcomes.some((outcome) => !outcome.has(value))) cleaned.delete(value);
  return (
    disposalLeak ??
    resources.find((resource) => repeated.has(resource.value) || !cleaned.has(resource.value))
      ?.kind ??
    null
  );
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
      "AwaitExpression",
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
