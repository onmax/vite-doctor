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
  const alternatives = new Map<AnyNode, AnyNode[]>();
  const callbackChoices = new Map<AnyNode, AnyNode[]>();
  const superConstructors = new Map<AnyNode, (args: AnyNode[]) => Completion>();
  const values = new Map<AnyNode, AnyNode>();
  const returned = new Map<AnyNode, AnyNode>();
  const callbacks = new Map<AnyNode, AnyNode>();
  const properties = new Map<AnyNode, Map<string, AnyNode>>();
  const members = new Map<AnyNode, Map<string, AnyNode>>();
  const propertyKey = (node: AnyNode): string | undefined =>
    node?.computed ? node.property?.value : node?.property?.name;
  const cleaned = new Set<AnyNode>();
  const visited = new Set<AnyNode>();
  let disposers: AnyNode[] = [undefined];
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
    return typeof node.value === "boolean" ? node.value : node;
  };
  function bindResource(pattern: AnyNode, argument: AnyNode, local: Map<AnyNode, AnyNode>): void {
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
      target = lexicalReceivers.has(value) ? value : (callbacks.get(value) ?? value);
    }
    if (lexicalReceivers.has(target)) {
      receiver = lexicalReceivers.get(target);
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
    const local = new Map(environment);
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
      else bindResource(param, identity(args[index], environment), local);
    }
    const completion = evaluate(target.body, local, module);
    for (const binding of environment.keys()) {
      if (binding !== thisBinding && local.has(binding))
        environment.set(binding, local.get(binding));
    }
    visited.delete(target);
    return completion;
  }
  function evaluate(
    root: AnyNode,
    environment: Map<AnyNode, AnyNode>,
    module: boolean,
  ): Completion {
    const exits: Set<AnyNode>[] = [];
    const exitedDisposers: AnyNode[] = [];
    let normal = false;
    let abrupt = false;
    const returns: AnyNode[] = [];
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
        const global = node.callee?.object ?? node.callee;
        const globalValue = identity(global, environment);
        const globalAlias = ["window", "globalThis", "self"].includes(globalValue);
        const callee =
          (!resolve(global) || globalAlias) &&
          !(node.callee?.computed && typeof node.callee.property?.value !== "string")
            ? globalAlias && node.callee?.type === "MemberExpression"
              ? propertyKey(node.callee)
              : path?.replace(/^(?:window|globalThis|self)\./, "")
            : undefined;
        const kind =
          node.type === "CallExpression" && callee === "setInterval" && !resolve(node.callee)
            ? "interval"
            : node.type === "CallExpression" && callee === "setTimeout" && !resolve(node.callee)
              ? "timeout"
              : node.type === "NewExpression" &&
                  ["WebSocket", "EventSource"].includes(callee ?? "") &&
                  !resolve(node.callee)
                ? callee!
                : node.type === "CallExpression" && path?.endsWith(".subscribe")
                  ? "subscription"
                  : null;
        if (module && kind) {
          const value = {};
          returned.set(node, value);
          if (loopDepth) repeated.add(value);
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
      }
      if (node.type !== "CallExpression") return;
      const calleeGlobal = identity(node.callee?.object, environment);
      const globalAlias = ["window", "globalThis", "self"].includes(calleeGlobal);
      const callee = globalAlias ? `window.${propertyKey(node.callee)}` : memberPath(node.callee);
      if (module && callee === "import.meta.hot.dispose") {
        const callback = identity(node.arguments[0], environment);
        disposers = callbackChoices.get(callback) ?? [callback];
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
        if (module && method === "addEventListener") {
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
          (!global || !resolve(global) || globalAlias)
        )
          cleaned.add(resource.value);
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
      }
      return completion.normal;
    };
    const snapshot = () => ({
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
      for (const value of cleaned) if (!right.cleaned.has(value)) cleaned.delete(value);
      for (const key of new Set([...left.values.keys(), ...right.values.keys()])) {
        if (left.values.get(key) !== right.values.get(key)) environment.set(key, {});
      }
      for (const object of new Set([...left.properties.keys(), ...right.properties.keys()])) {
        const a = left.properties.get(object) ?? new Map();
        const b = right.properties.get(object) ?? new Map();
        if (!properties.has(object)) properties.set(object, new Map());
        for (const key of new Set([...a.keys(), ...b.keys()])) {
          if (a.get(key) !== b.get(key)) properties.get(object)!.set(key, {});
        }
      }
    };
    const branch = (
      left: AnyNode,
      right: AnyNode,
      expression?: AnyNode,
      includeAbrupt = false,
    ): boolean => {
      const resourceStart = resources.length;
      const before = snapshot();
      const leftContinues = walk(left);
      const leftValue = identity(left, environment);
      const afterLeft = snapshot();
      restore(before);
      const rightContinues = walk(right);
      const rightValue = identity(right, environment);
      const afterRight = snapshot();
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
      if (includeAbrupt || (leftContinues && rightContinues)) merge(afterLeft, afterRight);
      else if (leftContinues) restore(afterLeft);
      return leftContinues || rightContinues;
    };
    const walk = (node: AnyNode): boolean => {
      if (!node || typeof node !== "object") return true;
      if (Array.isArray(node)) return node.every(walk);
      if (typeof node.type !== "string") return true;
      if (
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      ) {
        if (node.type === "ArrowFunctionExpression") {
          const closure = {};
          lexicalReceivers.set(closure, environment.get(thisBinding));
          callbacks.set(closure, node);
          returned.set(node, closure);
        }
        visit(node);
        return true;
      }
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        if (node.id) environment.set(resolve(node.id), node);
      }
      if (node.type === "NewExpression") {
        if (!walk(node.callee)) return false;
        const target = identity(node.callee, environment);
        if (["ClassDeclaration", "ClassExpression"].includes(target?.type)) {
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
              ["Literal", "UnaryExpression", "TemplateLiteral"].includes(replacement.type);
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
        if (typeof test?.value === "boolean" || memberPath(node.test) === "import.meta.hot") {
          const selected = test?.value === false ? node.alternate : node.consequent;
          const continues = walk(selected);
          if (node.type === "ConditionalExpression")
            returned.set(node, identity(selected, environment));
          return continues;
        }
        return branch(
          node.consequent,
          node.alternate,
          node.type === "ConditionalExpression" ? node : undefined,
        );
      }
      if (node.type === "LogicalExpression") {
        if (!walk(node.left)) return false;
        if (memberPath(node.left) === "import.meta.hot" && node.operator === "&&")
          return walk(node.right);
        return branch(node.right, null);
      }
      if (node.type === "TryStatement" && node.finalizer) {
        const firstExit = exits.length;
        const continues = branch(
          node.block,
          node.handler?.body ?? { type: "ThrowStatement" },
          undefined,
          true,
        );
        const beforeFinally = new Set(cleaned);
        const finalizerExit = exits.length;
        const finallyContinues = walk(node.finalizer);
        for (const exit of exits.slice(firstExit, finalizerExit)) {
          for (const value of cleaned) if (!beforeFinally.has(value)) exit.add(value);
        }
        return continues && finallyContinues;
      }
      if (
        [
          "ForStatement",
          "ForInStatement",
          "ForOfStatement",
          "WhileStatement",
          "DoWhileStatement",
          "SwitchStatement",
          "TryStatement",
        ].includes(node.type)
      ) {
        exits.push(new Set(cleaned));
        abrupt = true;
        if (module) {
          const before = snapshot();
          const loop = !["SwitchStatement", "TryStatement"].includes(node.type);
          if (loop) loopDepth++;
          for (const [key, child] of Object.entries(node)) {
            if (key !== "__doctorParent") walk(child);
          }
          if (loop) loopDepth--;
          merge(before, snapshot());
        }
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
      if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
        if (module) exitedDisposers.push(...disposers);
        exits.push(new Set(cleaned));
        if (node.type === "ReturnStatement") {
          normal = true;
          returns.push(identity(node.argument, environment));
        } else abrupt = true;
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
      exits.push(new Set(cleaned));
    }
    for (const value of cleaned) {
      if (exits.some((exit) => !exit.has(value))) cleaned.delete(value);
    }
    if (module) disposers = [...new Set([...disposers, ...exitedDisposers])];
    const value =
      returns.length && returns.every((value) => value === returns[0]) ? returns[0] : undefined;
    return { normal, abrupt, value };
  }
  evaluate(program, values, true);
  const initialCleaned = new Set(cleaned);
  const initialValues = new Map(values);
  const initialProperties = new Map(
    [...properties].map(([key, entries]) => [key, new Map(entries)]),
  );
  const outcomes = disposers.map((disposer) => {
    cleaned.clear();
    for (const value of initialCleaned) cleaned.add(value);
    values.clear();
    for (const [key, value] of initialValues) values.set(key, value);
    properties.clear();
    for (const [key, entries] of initialProperties) properties.set(key, new Map(entries));
    inspect(
      callbacks.get(disposer) && !lexicalReceivers.has(disposer)
        ? callbacks.get(disposer)
        : disposer,
    );
    if (
      resources.some((resource) => resource.value === disposer && resource.kind === "subscription")
    )
      cleaned.add(disposer);
    return new Set(cleaned);
  });
  for (const value of cleaned)
    if (outcomes.some((outcome) => !outcome.has(value))) cleaned.delete(value);
  return (
    resources.find((resource) => repeated.has(resource.value) || !cleaned.has(resource.value))
      ?.kind ?? null
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
    ].includes(node.type)
  )
    node = node.expression;
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
