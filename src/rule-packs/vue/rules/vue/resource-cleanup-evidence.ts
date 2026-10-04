import type { SFCDescriptor } from "@vue/compiler-sfc";
import { parseForESLint } from "@typescript-eslint/parser";
import type { RuleContext } from "../../../../core/index.js";
import { type AnyNode } from "./shared.js";

type Variable = ReturnType<
  typeof parseForESLint
>["scopeManager"]["scopes"][number]["variables"][number];
type ResourceKind = "interval" | "timeout" | "observer" | "socket" | "listener";

interface Resource {
  node: AnyNode;
  kind: ResourceKind;
  handle?: string;
  owner: AnyNode;
  event?: { target: string; type?: string; listener?: string; capture?: boolean };
}

const GLOBAL_RECEIVERS = new Set(["window", "document", "globalThis", "self"]);
const LIFECYCLE_CLEANUP = new Set(["onUnmounted", "onBeforeUnmount", "onScopeDispose"]);
const MOUNT_HOOKS = new Set(["onMounted", "onBeforeMount"]);
const WATCHERS = new Set(["watch", "watchEffect", "watchPostEffect", "watchSyncEffect"]);

export function uncleanedLifecycleResources(
  ctx: RuleContext,
): Array<{ start: number; end: number }> {
  if (!mayAcquireResource(ctx.file.scriptAst)) return [];
  const evidence = createResourceEvidence(ctx);
  return evidence.resources
    .filter(
      (resource) =>
        resource.kind !== "timeout" &&
        !evidence.transfers(resource) &&
        !evidence.cleans(resource) &&
        !evidence.cleansWatcher(resource),
    )
    .map((resource) => ({ start: resource.node.start, end: resource.node.end }));
}

export function uncleanedWatcherResources(ctx: RuleContext): Array<{ start: number; end: number }> {
  if (!mayAcquireResource(ctx.file.scriptAst)) return [];
  const evidence = createResourceEvidence(ctx);
  return evidence.watcherResources
    .filter((resource) => !evidence.cleansWatcher(resource))
    .map((resource) => ({ start: resource.node.start, end: resource.node.end }));
}

function mayAcquireResource(node: AnyNode): boolean {
  if (!node) return false;
  const callee = unwrap(node.callee);
  const name =
    callee?.type === "Identifier"
      ? callee.name
      : callee?.type === "MemberExpression"
        ? memberName(callee)
        : undefined;
  if (
    node.type === "CallExpression" &&
    ["setInterval", "setTimeout", "addEventListener"].includes(name)
  )
    return true;
  if (
    node.type === "NewExpression" &&
    ["ResizeObserver", "IntersectionObserver", "WebSocket"].includes(name)
  )
    return true;
  return children(node).some(mayAcquireResource);
}

function createResourceEvidence(ctx: RuleContext) {
  const nodes: AnyNode[] = [];
  const parents = new Map<AnyNode, AnyNode>();
  const bindings = new Map<AnyNode, Variable | null>();
  const moduleBindings = new Map<string, Variable>();
  const variableIds = new Map<Variable, number>();
  const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
  const blocks = descriptor
    ? [descriptor.script, descriptor.scriptSetup]
        .filter((block) => block !== null)
        .map((block) => ({
          text: block.content,
          offset: block.loc.start.offset,
          jsx: block.lang === "jsx" || block.lang === "tsx",
          setup: block === descriptor.scriptSetup,
        }))
    : [
        {
          text: ctx.file.text,
          offset: 0,
          jsx: /\.[jt]sx$/.test(ctx.file.relativePath),
          setup: false,
        },
      ];

  for (const block of blocks) {
    try {
      const { ast, scopeManager } = parseForESLint(block.text, {
        range: true,
        sourceType: "module",
        ecmaFeatures: { jsx: block.jsx },
      });
      index(ast, undefined, block.offset);
      for (const scope of scopeManager.scopes) {
        for (const variable of scope.variables) {
          variableIds.set(variable, variableIds.size);
          for (const identifier of variable.identifiers) bindings.set(identifier, variable);
          if (!block.setup && scope.type === "module" && variable.isValueVariable)
            moduleBindings.set(variable.name, variable);
        }
        for (const reference of scope.references) {
          bindings.set(
            reference.identifier,
            reference.resolved ??
              (block.setup ? moduleBindings.get(reference.identifier.name) : null) ??
              null,
          );
        }
      }
    } catch {
      continue;
    }
  }

  function index(node: AnyNode, parent: AnyNode, offset: number) {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (parent) parents.set(node, parent);
    if (node.range) {
      node.start = offset + node.range[0];
      node.end = offset + node.range[1];
    }
    nodes.push(node);
    for (const child of children(node)) index(child, node, offset);
  }

  function identity(expression: AnyNode): string | undefined {
    const node = unwrap(expression);
    if (node?.type === "Identifier") {
      const variable = bindings.get(node);
      return variable ? `binding:${variableIds.get(variable)}` : `global:${node.name}`;
    }
    if (node?.type === "Literal") return `literal:${JSON.stringify(node.value)}`;
    if (node?.type === "MemberExpression") {
      const object = identity(node.object);
      const member = memberName(node);
      return object && member !== undefined ? `${object}[${JSON.stringify(member)}]` : undefined;
    }
    return undefined;
  }

  function browserApi(expression: AnyNode): string | undefined {
    const node = unwrap(expression);
    if (node?.type === "Identifier" && !bindings.get(node)) return node.name;
    if (node?.type !== "MemberExpression") return;
    const receiver = unwrap(node.object);
    if (
      receiver?.type === "Identifier" &&
      GLOBAL_RECEIVERS.has(receiver.name) &&
      !bindings.get(receiver)
    )
      return memberName(node);
  }

  function vueApi(expression: AnyNode): string | undefined {
    const node = unwrap(expression);
    if (node?.type === "Identifier") {
      const variable = bindings.get(node);
      if (!variable) return node.name;
      for (const definition of variable.defs) {
        if (
          definition.type === "ImportBinding" &&
          definition.parent.type === "ImportDeclaration" &&
          definition.parent.source.value === "vue" &&
          definition.node.type === "ImportSpecifier"
        )
          return definition.node.imported.type === "Identifier"
            ? definition.node.imported.name
            : definition.node.imported.value;
      }
    }
    if (node?.type === "MemberExpression") {
      const variable = bindings.get(unwrap(node.object));
      if (
        variable?.defs.some(
          (definition) =>
            definition.type === "ImportBinding" &&
            definition.parent.type === "ImportDeclaration" &&
            definition.parent.source.value === "vue" &&
            definition.node.type === "ImportNamespaceSpecifier",
        )
      )
        return memberName(node);
    }
  }

  function owner(node: AnyNode, includeMountHooks = true): AnyNode {
    let current = parents.get(node);
    while (current) {
      if (isFunction(current)) {
        const call = parents.get(current);
        if (
          includeMountHooks &&
          call?.type === "CallExpression" &&
          MOUNT_HOOKS.has(vueApi(call.callee) ?? "")
        ) {
          current = parents.get(call);
          continue;
        }
        return current;
      }
      if (current.type === "Program") return current;
      current = parents.get(current);
    }
    return node;
  }

  function assignedHandle(node: AnyNode): string | undefined {
    let current = node;
    let parent = parents.get(current);
    while (parent && unwrap(parent) === current) {
      current = parent;
      parent = parents.get(current);
    }
    if (parent?.type === "VariableDeclarator" && parent.init === current)
      return identity(parent.id);
    if (parent?.type === "AssignmentExpression" && parent.right === current)
      return identity(parent.left);
    return undefined;
  }

  function listenerTarget(callee: AnyNode): string {
    return callee.type === "Identifier" || callee.object?.name !== "document"
      ? "window"
      : "document";
  }

  const resources: Resource[] = [];
  for (const node of nodes) {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") continue;
    const api = browserApi(node.callee);
    let kind: ResourceKind | undefined;
    if (node.type === "CallExpression" && api === "setInterval") kind = "interval";
    if (node.type === "CallExpression" && api === "setTimeout") kind = "timeout";
    if (
      node.type === "NewExpression" &&
      (api === "ResizeObserver" || api === "IntersectionObserver")
    )
      kind = "observer";
    if (node.type === "NewExpression" && api === "WebSocket") kind = "socket";
    if (node.type === "CallExpression" && api === "addEventListener") kind = "listener";
    if (!kind) continue;
    resources.push({
      node,
      kind,
      handle: assignedHandle(node),
      owner: owner(node),
      event:
        kind === "listener"
          ? {
              target: listenerTarget(node.callee),
              type: identity(node.arguments[0]),
              listener: identity(node.arguments[1]),
              capture: captureValue(node.arguments[2]),
            }
          : undefined,
    });
  }

  function disposes(node: AnyNode, resource: Resource): boolean {
    if (node.type !== "CallExpression") return false;
    if (resource.kind === "listener") {
      const event = resource.event!;
      if (
        changedAfterAcquisition(event.type, resource, node) ||
        changedAfterAcquisition(event.listener, resource, node)
      )
        return false;
      return (
        browserApi(node.callee) === "removeEventListener" &&
        listenerTarget(node.callee) === event.target &&
        event.type !== undefined &&
        identity(node.arguments[0]) === event.type &&
        event.listener !== undefined &&
        identity(node.arguments[1]) === event.listener &&
        event.capture !== undefined &&
        captureValue(node.arguments[2]) === event.capture
      );
    }
    if (!resource.handle) return false;
    if (changedAfterAcquisition(resource.handle, resource, node)) return false;
    if (resource.kind === "interval" || resource.kind === "timeout") {
      return (
        ["clearInterval", "clearTimeout"].includes(browserApi(node.callee) ?? "") &&
        identity(node.arguments[0]) === resource.handle
      );
    }
    const callee = unwrap(node.callee);
    return (
      callee?.type === "MemberExpression" &&
      memberName(callee) === (resource.kind === "observer" ? "disconnect" : "close") &&
      identity(callee.object) === resource.handle
    );
  }

  function callback(expression: AnyNode): AnyNode {
    const node = unwrap(expression);
    if (isFunction(node)) return node;
    if (node?.type !== "Identifier") return undefined;
    const variable = bindings.get(node);
    for (const definition of variable?.defs ?? []) {
      const init = definition.type === "Variable" ? definition.node.init : undefined;
      if (
        variable?.references.some(
          (reference) =>
            reference.isWrite() &&
            reference.writeExpr !== init &&
            (reference.identifier as AnyNode).start < node.start,
        )
      )
        return undefined;
      if (definition.type === "FunctionName") return definition.node;
      if (definition.type === "Variable" && isFunction(unwrap(definition.node.init)))
        return unwrap(definition.node.init);
    }
  }

  function changedAfterAcquisition(
    key: string | undefined,
    resource: Resource,
    disposal: AnyNode,
  ): boolean {
    if (!key) return false;
    for (const node of nodes) {
      if (
        node.start <= resource.node.start ||
        (owner(node) === owner(disposal) && node.start > disposal.start)
      )
        continue;
      if (
        node.type === "AssignmentExpression" &&
        unwrap(node.right) !== resource.node &&
        replaces(identity(node.left), key)
      )
        return true;
      if (node.type === "UpdateExpression" && replaces(identity(node.argument), key)) return true;
    }
    return false;
  }

  function replaces(written: string | undefined, captured: string): boolean {
    return written !== undefined && (written === captured || captured.startsWith(`${written}[`));
  }

  function conditionValue(node: AnyNode, resource?: Resource): boolean | undefined {
    if (node?.type === "Literal") return Boolean(node.value);
    if (node?.type === "UnaryExpression" && node.operator === "!") {
      const value = conditionValue(node.argument, resource);
      return value === undefined ? undefined : !value;
    }
    if (resource?.handle && identity(node) === resource.handle) return true;
    return undefined;
  }

  function mayExit(node: AnyNode, resource?: Resource): boolean {
    if (!node || isFunction(node)) return false;
    if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return true;
    if (node.type === "IfStatement") {
      const value = conditionValue(node.test, resource);
      if (value !== undefined) return mayExit(value ? node.consequent : node.alternate, resource);
    }
    return children(node).some((child) => mayExit(child, resource));
  }

  function executes(
    node: AnyNode,
    predicate: (node: AnyNode) => boolean,
    resource?: Resource,
  ): boolean {
    if (!node || isFunction(node)) return false;
    if (predicate(node)) return true;
    if (node.type === "BlockStatement" || node.type === "Program") {
      for (const statement of node.body) {
        if (executes(statement, predicate, resource)) return true;
        if (mayExit(statement, resource)) break;
      }
      return false;
    }
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      if (executes(node.test, predicate, resource)) return true;
      const value = conditionValue(node.test, resource);
      if (value !== undefined)
        return executes(value ? node.consequent : node.alternate, predicate, resource);
      return (
        executes(node.consequent, predicate, resource) &&
        executes(node.alternate, predicate, resource)
      );
    }
    if (node.type === "TryStatement") {
      return (
        executes(node.finalizer, predicate, resource) ||
        (!!node.handler &&
          executes(node.block, predicate, resource) &&
          executes(node.handler.body, predicate, resource))
      );
    }
    if (
      [
        "WhileStatement",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "SwitchStatement",
        "LogicalExpression",
      ].includes(node.type)
    )
      return false;
    if (node.type === "CallExpression" && MOUNT_HOOKS.has(vueApi(node.callee) ?? "")) {
      const mounted = callback(node.arguments[0]);
      if (mounted && executes(mounted.body, predicate, resource)) return true;
    }
    return children(node).some((child) => executes(child, predicate, resource));
  }

  function transfers(resource: Resource): boolean {
    if (!resource.handle || resource.owner.type === "Program") return false;
    return executes(
      resource.owner.body,
      (node) => node.type === "ReturnStatement" && identity(node.argument) === resource.handle,
      resource,
    );
  }

  function cleans(resource: Resource): boolean {
    return executes(
      resource.owner.type === "Program" ? resource.owner : resource.owner.body,
      (node) => {
        if (node.start > resource.node.start && disposes(node, resource)) return true;
        if (node.type !== "CallExpression" || !LIFECYCLE_CLEANUP.has(vueApi(node.callee) ?? ""))
          return false;
        const cleanup = callback(node.arguments[0]);
        return !!cleanup && executes(cleanup.body, (call) => disposes(call, resource), resource);
      },
      resource,
    );
  }

  const watchers = new Map<AnyNode, AnyNode>();
  for (const node of nodes) {
    if (node.type !== "CallExpression") continue;
    const api = vueApi(node.callee);
    if (!WATCHERS.has(api ?? "")) continue;
    const effect = callback(node.arguments[api === "watch" ? 1 : 0]);
    if (!effect) continue;
    const parameter = effect.params[api === "watch" ? 2 : 0];
    watchers.set(effect, parameter?.type === "AssignmentPattern" ? parameter.left : parameter);
  }

  function suspendsBefore(node: AnyNode, registration: AnyNode, resource: Resource): boolean {
    if (!node || isFunction(node) || node.start >= registration.end) return false;
    const containsRegistration = (candidate: AnyNode) =>
      candidate && candidate.start <= registration.start && candidate.end >= registration.end;
    if (node.type === "AwaitExpression" && !containsRegistration(node)) return true;
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      if (suspendsBefore(node.test, registration, resource)) return true;
      if (containsRegistration(node.test)) return false;
      for (const branch of [node.consequent, node.alternate]) {
        if (containsRegistration(branch)) return suspendsBefore(branch, registration, resource);
      }
      const value = conditionValue(node.test, resource);
      if (value !== undefined)
        return suspendsBefore(value ? node.consequent : node.alternate, registration, resource);
      return (
        suspendsBefore(node.consequent, registration, resource) ||
        suspendsBefore(node.alternate, registration, resource)
      );
    }
    if (node.type === "BlockStatement") {
      for (const statement of node.body) {
        if (suspendsBefore(statement, registration, resource)) return true;
        if (
          containsRegistration(statement) ||
          executes(
            statement,
            (candidate) =>
              candidate.type === "ReturnStatement" || candidate.type === "ThrowStatement",
            resource,
          )
        )
          break;
      }
      return false;
    }
    return children(node).some((child) => suspendsBefore(child, registration, resource));
  }

  function cleansWatcher(resource: Resource): boolean {
    if (!watchers.has(resource.owner) || owner(resource.node, false) !== resource.owner)
      return false;
    const parameter = watchers.get(resource.owner);
    const registrar = parameter?.type === "Identifier" ? bindings.get(parameter) : undefined;
    return executes(
      resource.owner.body,
      (node) => {
        if (owner(node, false) !== resource.owner) return false;
        if (node.start > resource.node.start && disposes(node, resource)) return true;
        if (node.type !== "CallExpression") return false;
        const callee = unwrap(node.callee);
        const boundCleanup =
          registrar &&
          bindings.get(callee) === registrar &&
          !registrar.references.some(
            (reference) =>
              reference.isWrite() && (reference.identifier as AnyNode).start < node.start,
          );
        const watcherCleanup =
          vueApi(callee) === "onWatcherCleanup" &&
          !suspendsBefore(resource.owner.body, node, resource);
        if (!boundCleanup && !watcherCleanup) return false;
        const cleanup = callback(node.arguments[0]);
        return !!cleanup && executes(cleanup.body, (call) => disposes(call, resource), resource);
      },
      resource,
    );
  }

  return {
    resources,
    watcherResources: resources
      .map((resource) => ({ ...resource, owner: owner(resource.node, false) }))
      .filter((resource) => watchers.has(resource.owner)),
    cleans,
    cleansWatcher,
    transfers,
  };
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    ["TSAsExpression", "TSNonNullExpression", "TSTypeAssertion", "ChainExpression"].includes(
      node.type,
    )
  )
    node = node.expression;
  return node;
}

function isFunction(node: AnyNode): boolean {
  return (
    !!node &&
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
  );
}

function children(node: AnyNode): AnyNode[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (["parent", "__doctorParent", "comments", "tokens"].includes(key)) return [];
    return (Array.isArray(value) ? value : [value]).filter(
      (child: any) => child && typeof child === "object" && typeof child.type === "string",
    );
  });
}

function memberName(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.property?.type === "Literal" && typeof node.property.value === "string")
    return node.property.value;
}

function captureValue(node: AnyNode): boolean | undefined {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "boolean") return node.value;
  if (node.type !== "ObjectExpression") return undefined;
  if (node.properties.some((property: AnyNode) => property.type === "SpreadElement"))
    return undefined;
  if (
    node.properties.some(
      (property: AnyNode) => property.computed && property.key?.type !== "Literal",
    )
  )
    return undefined;
  const capture = node.properties.findLast(
    (property: AnyNode) =>
      (property.key?.type === "Literal" ? property.key.value : property.key?.name) === "capture",
  );
  if (!capture) return false;
  return capture.value?.type === "Literal" && typeof capture.value.value === "boolean"
    ? capture.value.value
    : undefined;
}
