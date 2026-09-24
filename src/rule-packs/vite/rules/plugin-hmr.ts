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
  const resources: Resource[] = [];
  const listeners: Listener[] = [];
  const values = new Map<AnyNode, AnyNode>();
  const callbacks = new Map<AnyNode, AnyNode>();
  const properties = new Map<AnyNode, Map<string, AnyNode>>();
  const members = new Map<AnyNode, Map<string, AnyNode>>();
  const propertyKey = (node: AnyNode): string | undefined =>
    node?.computed ? node.property?.value : node?.property?.name;
  const cleaned = new Set<AnyNode>();
  const visited = new Set<AnyNode>();
  let callback: AnyNode;
  let callbackValue: AnyNode;
  const identity = (node: AnyNode, environment = values): AnyNode => {
    node = unwrapResourceExpression(node);
    if (node?.type === "MemberExpression") {
      const key = propertyKey(node);
      if (key !== undefined) {
        const object = identity(node.object, environment);
        const stored = properties.get(object);
        if (stored?.has(key)) return stored.get(key);
        if (object?.type === "ObjectExpression") {
          const property = object.properties.find(
            (item: AnyNode) => !item.computed && (item.key?.name ?? item.key?.value) === key,
          );
          if (property) return identity(property.value, environment);
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
      ? environment.get(binding)
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
  function inspect(target: AnyNode, args: AnyNode[] = [], environment = values): void {
    target = unwrapResourceExpression(target);
    if (target?.type === "Identifier") {
      const value = identity(target, environment);
      if (
        resources.some((resource) => resource.value === value && resource.kind === "subscription")
      )
        cleaned.add(value);
      target = callbacks.get(value) ?? value;
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
      if (bound.type === "MemberExpression") {
        if (identity(bound.object, environment) === identity(target.arguments[0], environment))
          evaluate(
            { type: "CallExpression", callee: bound, arguments: boundArgs },
            environment,
            false,
          );
      } else {
        inspect(bound, boundArgs, environment);
      }
      visited.delete(target);
      return;
    }
    if (
      !target ||
      visited.has(target) ||
      !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
        target.type,
      )
    )
      return;
    visited.add(target);
    const local = new Map(environment);
    for (const [index, param] of target.params.entries()) {
      const argument = identity(args[index], environment);
      if (param.type === "Identifier") local.set(param, argument);
      else if (param.type === "AssignmentPattern" && param.left.type === "Identifier") {
        const useDefault =
          argument === undefined ||
          argument === "undefined" ||
          (argument?.type === "UnaryExpression" && argument.operator === "void");
        local.set(param.left, useDefault ? identity(param.right, local) : argument);
      }
    }
    evaluate(target.body, local, false);
    visited.delete(target);
  }
  function evaluate(root: AnyNode, environment: Map<AnyNode, AnyNode>, module: boolean): void {
    walkEvaluation(root, (node) => {
      if (node.type === "FunctionDeclaration" && node.id) callbacks.set(node.id, node);
    });
    walkEvaluation(root, (node) => {
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
      if (handle?.type === "Identifier") {
        const binding = resolve(handle);
        const init = unwrapResourceExpression(
          node.type === "VariableDeclarator" ? node.init : node.right,
        );
        if (init) {
          const value = init.type === "Identifier" ? identity(init, environment) : init;
          environment.set(binding, value);
          if (["ArrowFunctionExpression", "FunctionExpression"].includes(init.type))
            callbacks.set(value, init);
          const path = memberPath(init.callee);
          const global = init.callee?.object ?? init.callee;
          const callee =
            !resolve(global) &&
            !(init.callee?.computed && typeof init.callee.property?.value !== "string")
              ? path?.replace(/^(?:window|globalThis|self)\./, "")
              : undefined;
          const kind =
            init.type === "CallExpression" && callee === "setInterval" && !resolve(init.callee)
              ? "interval"
              : init.type === "CallExpression" && callee === "setTimeout" && !resolve(init.callee)
                ? "timeout"
                : init.type === "NewExpression" &&
                    ["WebSocket", "EventSource"].includes(callee ?? "") &&
                    !resolve(init.callee)
                  ? callee!
                  : init.type === "CallExpression" && path?.endsWith(".subscribe")
                    ? "subscription"
                    : null;
          if (module && kind)
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
      const callee = memberPath(node.callee);
      if (module && callee === "import.meta.hot.dispose") {
        const argument = unwrapResourceExpression(node.arguments[0]);
        callbackValue = identity(argument, environment);
        callback =
          argument?.type === "Identifier"
            ? (callbacks.get(callbackValue) ?? callbackValue)
            : argument;
        return;
      }
      const method =
        node.callee.type === "Identifier" ? node.callee.name : propertyKey(node.callee);
      if (
        (method === "addEventListener" || method === "removeEventListener") &&
        !(node.callee.type === "Identifier" && resolve(node.callee))
      ) {
        const receiver =
          node.callee.type === "Identifier"
            ? (resolve(node.callee) ?? "window")
            : receiverIdentity(node.callee.object, environment);
        const event =
          node.arguments[0]?.value ?? identity(node.arguments[0], environment) ?? node.arguments[0];
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
        if (method === "removeEventListener") {
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
      if (method === "abort") {
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
          identity(receiver, environment) === resource.value &&
          (!global || !resolve(global))
        )
          cleaned.add(resource.value);
      }
      if (!module) inspect(node.callee, node.arguments, environment);
    });
  }
  evaluate(program, values, true);
  inspect(callback);
  if (
    resources.some(
      (resource) => resource.value === callbackValue && resource.kind === "subscription",
    )
  )
    cleaned.add(callbackValue);
  return resources.find((resource) => !cleaned.has(resource.value))?.kind ?? null;
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
