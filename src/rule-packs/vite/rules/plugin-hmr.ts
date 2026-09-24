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
  const resources: Array<{ binding: AnyNode; kind: string; cleanup: string; method: boolean }> = [];
  const callbacks = new Map<AnyNode, AnyNode>();
  let callback: AnyNode;
  walkEvaluation(program, (node) => {
    if (node.type === "FunctionDeclaration" && node.id) callbacks.set(node.id, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      const init = node.init;
      if (["ArrowFunctionExpression", "FunctionExpression"].includes(init?.type)) {
        callbacks.set(node.id, init);
      }
      const callee = memberPath(init?.callee);
      const kind =
        init?.type === "CallExpression" && callee === "setInterval"
          ? "interval"
          : init?.type === "CallExpression" && callee === "setTimeout"
            ? "timeout"
            : init?.type === "NewExpression" && callee === "WebSocket"
              ? "WebSocket"
              : init?.type === "CallExpression" && callee?.endsWith(".subscribe")
                ? "subscription"
                : null;
      if (kind)
        resources.push({
          binding: node.id,
          kind,
          cleanup:
            kind === "interval"
              ? "clearInterval"
              : kind === "timeout"
                ? "clearTimeout"
                : kind === "WebSocket"
                  ? "close"
                  : "unsubscribe",
          method: kind === "WebSocket" || kind === "subscription",
        });
    }
    if (node.type === "CallExpression" && memberPath(node.callee) === "import.meta.hot.dispose") {
      callback = node.arguments[0];
    }
  });
  const cleaned = new Set<AnyNode>();
  const visited = new Set<AnyNode>();
  function inspect(target: AnyNode): void {
    if (target?.type === "Identifier") {
      const binding = resolve(target);
      if (
        resources.some(
          (resource) => resource.binding === binding && resource.kind === "subscription",
        )
      )
        cleaned.add(binding!);
      target = callbacks.get(binding!);
    }
    if (!target || visited.has(target)) return;
    if (
      !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
        target.type,
      )
    )
      return;
    visited.add(target);
    walkEvaluation(target.body, (node) => {
      if (node.type === "FunctionDeclaration" && node.id) callbacks.set(node.id, node);
      if (
        node.type === "VariableDeclarator" &&
        node.id?.type === "Identifier" &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)
      )
        callbacks.set(node.id, node.init);
    });
    walkEvaluation(target.body, (node) => {
      if (node.type !== "CallExpression") return;
      for (const resource of resources) {
        const callee = memberPath(node.callee);
        const receiver = resource.method ? node.callee.object : node.arguments[0];
        const matches = resource.method
          ? node.callee.property?.name === resource.cleanup && !node.callee.computed
          : [
              resource.cleanup,
              `window.${resource.cleanup}`,
              `globalThis.${resource.cleanup}`,
              `self.${resource.cleanup}`,
            ].includes(callee ?? "");
        const global = resource.method ? null : (node.callee.object ?? node.callee);
        if (
          matches &&
          receiver?.type === "Identifier" &&
          resolve(receiver) === resource.binding &&
          (!global || !resolve(global))
        )
          cleaned.add(resource.binding);
      }
      inspect(node.callee);
    });
  }
  inspect(callback);
  return resources.find((resource) => !cleaned.has(resource.binding))?.kind ?? null;
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
