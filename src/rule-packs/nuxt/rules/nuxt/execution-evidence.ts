import { parseSync } from "oxc-parser";
import type { RuleContext } from "../../../../core/index.js";
import {
  findAncestor,
  nearestFunctionOrProgram,
  sourceForNode,
  walkScriptLocal,
  type AnyNode,
} from "../../../../core/rule-authoring.js";

export type NuxtExecutionEvidence =
  | "setup-time"
  | "event-handler"
  | "returned-command"
  | "lifecycle-only"
  | "client-only"
  | "server-only"
  | "unknown";

const TEMPLATE_BLOCK_RE = /<template[^>]*>([\s\S]*?)<\/template>/;
const TEMPLATE_DIRECTIVE_RE_G = /[@:]\w+(?:\.[\w.]+)?\s*=\s*["']([^"']+)["']/g;
const TEMPLATE_EVENT_RE_G = /@\w+(?:\.[\w.]+)?\s*=\s*["']([^"']+)["']/g;
const IDENT_RE_G = /\b[A-Za-z_$][\w$]*\b/g;
const CLIENT_CALLBACK_RE =
  /^(useEventListener|addEventListener|onKeyDown|onKeyUp|onKeyStroke|onClickOutside|onLongPress|usePointerSwipe|useSwipe|useIntersectionObserver|useResizeObserver|useMutationObserver|defineShortcuts)$/;
const CLIENT_LIFECYCLE_RE = /^(onMounted|onBeforeMount|onBeforeUnmount|onUnmounted)$/;
const LIFECYCLE_RE =
  /^(onMounted|onBeforeMount|onBeforeUnmount|onUnmounted|watch|watchEffect|watchPostEffect|nextTick)$/;
const COMMAND_LIKE_RE =
  /^(on[A-Z]|handle|handler|callback|execute|run|open|close|toggle|submit|select|copy|download|navigate|scroll)/;

export function isClientOnlyPath(path: string) {
  return /\.client\.[cm]?[jt]sx?$/.test(path) || path.includes(".client.vue");
}

export function classifyExecutionEvidence(ctx: RuleContext, node: AnyNode): NuxtExecutionEvidence {
  if (!node || typeof node !== "object") return computeExecutionEvidence(ctx, node);
  const cache = getEvidenceCache(ctx);
  const hit = cache.get(node);
  if (hit) return hit;
  const result = computeExecutionEvidence(ctx, node);
  cache.set(node, result);
  return result;
}

export function isSsrExecutedEvidence(ctx: RuleContext, node: AnyNode) {
  const evidence = classifyExecutionEvidence(ctx, node);
  return evidence === "setup-time" || evidence === "unknown";
}

export function isClientCallableEvidence(ctx: RuleContext, node: AnyNode) {
  const evidence = classifyExecutionEvidence(ctx, node);
  return (
    evidence === "client-only" || evidence === "event-handler" || evidence === "returned-command"
  );
}

export function isPayloadSerializedEvidence(ctx: RuleContext, node: AnyNode) {
  return (
    !isClientOnlyPath(ctx.file.relativePath) &&
    classifyExecutionEvidence(ctx, node) !== "client-only"
  );
}

export function isReusableDataComposableContext(ctx: RuleContext, node: AnyNode) {
  if (/^app\/composables\/use[A-Z]\w+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return true;
  return isInsideExportedFunction(ctx.file.text, node.start ?? 0);
}

export function isSourceOnlyExecutionEvidence(ctx: RuleContext, node: AnyNode) {
  return (
    classifyExecutionEvidence(ctx, node) === "unknown" &&
    !ctx.project.nuxt?.manifest?.evidence?.buildManifest
  );
}

export function isTopLevelVueScriptSetupCall(ctx: RuleContext, node: AnyNode) {
  if (!ctx.file.relativePath.endsWith(".vue") || !/<script\b[^>]*\bsetup\b/.test(ctx.file.text))
    return false;
  return nearestFunctionOrProgram(node)?.type === "Program";
}

export function isLikelyRenderedTimeExpression(ctx: RuleContext, node: AnyNode) {
  const text = ctx.file.text;
  if (/<\s*(NuxtTime|ClientOnly)\b/.test(text)) return false;
  if (ctx.helpers.isClientOnlyExecutionContext(node, text)) return false;
  const source = sourceForNode(node, text);
  if (!source) return false;
  const template = getTemplateSource(ctx);
  if (template.includes(source)) return true;

  const declarator = nearestVariableDeclarator(node);
  const name = declarator?.id?.type === "Identifier" ? declarator.id.name : "";
  if (name && getTemplateBoundIdentifiers(ctx).has(name)) return true;
  if (name && new RegExp(`{{[^}]*\\b${escapeRegExp(name)}\\b[^}]*}}`).test(template)) return true;
  if (isHydratingStateValue(node)) return true;
  const owner = nearestFunctionOrProgram(node);
  return Boolean(owner && functionFlowsToTemplate(ctx, owner, template, new Set()));
}

function functionFlowsToTemplate(
  ctx: RuleContext,
  fn: AnyNode,
  template: string,
  seen: Set<AnyNode>,
): boolean {
  const parents = getScriptParents(ctx);
  const binding = functionBinding(fn, parents);
  const functionName = binding.id?.type === "Identifier" ? binding.id.name : null;
  if (!functionName || fn.generator || seen.has(fn) || seen.size >= 4) return false;
  seen.add(fn);
  const renderedExpressions = [...template.matchAll(/{{([\s\S]*?)}}/g)].map(
    (match) => match[1] ?? "",
  );
  for (const match of template.matchAll(
    /(?:\s:|\sv-(bind\b|if\b|else-if\b|show\b|text\b|html\b|for\b))[^=]*=\s*(["'])([\s\S]*?)\2/g,
  )) {
    const expression = match[3] ?? "";
    renderedExpressions.push(
      match[1] === "for" ? (expression.match(/\s+(?:in|of)\s+([\s\S]*)$/)?.[1] ?? "") : expression,
    );
  }
  const renderedIdentifier = (name: string) =>
    renderedExpressions.some((expression) =>
      new RegExp(`\\b${escapeRegExp(name)}\\b`).test(expression),
    );
  if (
    resolveLocalBinding(ctx.file.scriptAst, functionName, parents) === binding &&
    renderedExpressions.some((expression) => expressionCallsHelper(expression, functionName))
  )
    return true;
  const visit = (node: AnyNode, owner: AnyNode, variable: AnyNode): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((child) => visit(child, owner, variable));
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    ) {
      owner = node;
      variable = null;
    }
    if (node.type === "VariableDeclarator") return visit(node.init, owner, node);
    if (
      node.type === "CallExpression" &&
      node.callee?.name === functionName &&
      resolveLocalBinding(node, functionName, parents) === binding
    ) {
      const name = variable?.id?.type === "Identifier" ? variable.id.name : null;
      if (
        name &&
        resolveLocalBinding(ctx.file.scriptAst, name, parents) === variable &&
        renderedIdentifier(name)
      )
        return true;
      if (
        owner &&
        owner !== fn &&
        contributesToReturn(node, owner, parents) &&
        functionFlowsToTemplate(ctx, owner, template, new Set(seen))
      )
        return true;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "__doctorParent" || key === "parent") continue;
      if (value && typeof value === "object" && visit(value, owner, variable)) return true;
    }
    return false;
  };
  return visit(ctx.file.scriptAst, null, null);
}

function expressionCallsHelper(expression: string, name: string): boolean {
  try {
    const { program, errors } = parseSync("template.ts", `(${expression})`, { lang: "ts" });
    if (errors.length) return false;
    let found = false;
    walkScriptLocal(program, (node) => {
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === name
      )
        found = true;
    });
    return found;
  } catch {
    return false;
  }
}

function contributesToReturn(
  node: AnyNode,
  owner: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  seen = new Set<AnyNode>(),
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  for (let current = node; current && current !== owner; current = parents.get(current)) {
    const parent = parents.get(current);
    if (
      parent?.type === "ExpressionStatement" ||
      (parent?.type === "UnaryExpression" && parent.operator === "void")
    )
      return false;
    if (parent?.type === "SequenceExpression" && parent.expressions.at(-1) !== current)
      return false;
    if (
      (parent?.type === "VariableDeclarator" && parent.init === current) ||
      (parent?.type === "AssignmentPattern" && parent.right === current)
    ) {
      const identifier = parent.id ?? parent.left;
      if (identifier?.type !== "Identifier") return false;
      let reassigned = false;
      walkScriptLocal(owner.body, (write) => {
        const target =
          write.type === "AssignmentExpression"
            ? write.left
            : write.type === "UpdateExpression"
              ? write.argument
              : ["ForInStatement", "ForOfStatement"].includes(write.type)
                ? write.left
                : null;
        if (
          patternBinds(target, identifier.name) &&
          resolveLocalBinding(write, identifier.name, parents) === parent
        )
          reassigned = true;
      });
      if (reassigned) return false;
      let returned = false;
      walkScriptLocal(owner.body, (reference) => {
        if (
          reference.type === "Identifier" &&
          reference !== identifier &&
          reference.name === identifier.name &&
          resolveLocalBinding(reference, identifier.name, parents) === parent &&
          contributesToReturn(reference, owner, parents, seen)
        )
          returned = true;
      });
      return returned;
    }
    if (parent?.type === "MemberExpression" && parent.property === current && !parent.computed)
      return false;
    if (parent?.type === "Property" && parent.key === current && !parent.computed) return false;
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        parent?.type,
      ) &&
      parent !== owner
    )
      return false;
    if (parent?.type === "ReturnStatement") {
      let scope = parent;
      while (
        scope &&
        !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
          scope.type,
        )
      )
        scope = parents.get(scope);
      return scope === owner;
    }
    if (parent === owner)
      return (
        owner.type === "ArrowFunctionExpression" &&
        owner.body === current &&
        current.type !== "BlockStatement"
      );
  }
  return false;
}

function getScriptParents(ctx: RuleContext): WeakMap<AnyNode, AnyNode> {
  const key = `nuxt:script-parents:${ctx.file.hash}`;
  const cached = ctx.cache.get<WeakMap<AnyNode, AnyNode>>(key);
  if (cached) return cached;
  const parents = new WeakMap<AnyNode, AnyNode>();
  walkScriptLocal(ctx.file.scriptAst, (node) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === "__doctorParent" || key === "parent") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && "type" in child) parents.set(child, node);
      }
    }
  });
  ctx.cache.set(key, parents);
  return parents;
}

function functionBinding(fn: AnyNode, parents: WeakMap<AnyNode, AnyNode>) {
  const parent = parents.get(fn);
  return parent?.type === "VariableDeclarator" ? parent : fn;
}

function patternBinds(node: AnyNode, name: string): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "AssignmentPattern") return patternBinds(node.left, name);
  if (node.type === "RestElement") return patternBinds(node.argument, name);
  if (node.type === "ArrayPattern")
    return node.elements.some((item: AnyNode) => patternBinds(item, name));
  if (node.type === "ObjectPattern")
    return node.properties.some((item: AnyNode) => patternBinds(item.value ?? item.argument, name));
  return false;
}

function findFunctionVar(node: AnyNode, name: string): AnyNode {
  if (!node || typeof node !== "object") return null;
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type))
    return null;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    return node.declarations.find((item: AnyNode) => patternBinds(item.id, name)) ?? null;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    const found = findFunctionVar(value, name);
    if (found) return found;
  }
  return null;
}

function resolveLocalBinding(
  node: AnyNode,
  name: string,
  parents: WeakMap<AnyNode, AnyNode>,
): AnyNode {
  for (let scope = node, child = null; scope; child = scope, scope = parents.get(scope)) {
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(scope.type)
    ) {
      const parameter = scope.params.find((param: AnyNode) => patternBinds(param, name));
      if (parameter) return parameter;
      const local = child === scope.body ? findFunctionVar(scope.body, name) : null;
      if (local) return local;
      if (scope.id?.name === name) return scope;
    }
    if (scope.type === "CatchClause" && patternBinds(scope.param, name)) return scope.param;
    const statements =
      scope.type === "Program" || scope.type === "BlockStatement"
        ? scope.body
        : scope.type === "ForStatement"
          ? [scope.init].filter(Boolean)
          : ["ForOfStatement", "ForInStatement"].includes(scope.type)
            ? [scope.left]
            : scope.type === "SwitchStatement"
              ? scope.cases.flatMap((item: AnyNode) => item.consequent)
              : [];
    for (const statement of statements) {
      const declaration = statement.declaration ?? statement;
      if (
        ["FunctionDeclaration", "ClassDeclaration"].includes(declaration.type) &&
        declaration.id?.name === name
      )
        return declaration;
      if (declaration.type === "VariableDeclaration") {
        const binding = declaration.declarations.find((item: AnyNode) =>
          patternBinds(item.id, name),
        );
        if (binding) return binding;
      }
      if (declaration.type === "ImportDeclaration") {
        const binding = declaration.specifiers.find((item: AnyNode) => item.local?.name === name);
        if (binding) return binding;
      }
    }
  }
  return null;
}

export function isInsideExportedFunction(text: string, offset: number) {
  const before = text.slice(Math.max(0, offset - 260), offset);
  return /export\s+(async\s+)?function\s+use[A-Z]\w+|export\s+const\s+use[A-Z]\w+\s*=/.test(before);
}

function computeExecutionEvidence(ctx: RuleContext, node: AnyNode): NuxtExecutionEvidence {
  if (
    isClientOnlyPath(ctx.file.relativePath) ||
    ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
  )
    return "client-only";
  if (ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return "server-only";
  if (isCallFlowClientCallable(ctx, node)) return "event-handler";
  if (isReturnedCommandCallback(node)) return "returned-command";
  if (
    isTemplateBoundFunction(ctx, node) ||
    ctx.helpers.isLikelyEventHandler(ctx.file.text, node.start ?? 0)
  )
    return "event-handler";
  if (isLifecycleOrWatcherCallback(node)) return "lifecycle-only";
  return nearestFunctionOrProgram(node)?.type === "Program" ? "setup-time" : "unknown";
}

function getEvidenceCache(ctx: RuleContext): WeakMap<AnyNode, NuxtExecutionEvidence> {
  const key = `nuxt:evidence:${ctx.file.hash}`;
  let cache = ctx.cache.get<WeakMap<AnyNode, NuxtExecutionEvidence>>(key);
  if (!cache) {
    cache = new WeakMap();
    ctx.cache.set(key, cache);
  }
  return cache;
}

function getTemplateSource(ctx: RuleContext): string {
  const key = `nuxt:template:${ctx.file.hash}`;
  const cached = ctx.cache.get<string>(key);
  if (cached !== undefined) return cached;
  const value = ctx.file.text.match(TEMPLATE_BLOCK_RE)?.[1] ?? "";
  ctx.cache.set(key, value);
  return value;
}

function getTemplateBoundIdentifiers(ctx: RuleContext): Set<string> {
  const key = `nuxt:template-refs:${ctx.file.hash}`;
  const cached = ctx.cache.get<Set<string>>(key);
  if (cached) return cached;
  const set = new Set<string>();
  for (const match of getTemplateSource(ctx).matchAll(TEMPLATE_DIRECTIVE_RE_G)) {
    for (const id of (match[1] ?? "").matchAll(IDENT_RE_G)) set.add(id[0]);
  }
  ctx.cache.set(key, set);
  return set;
}

function isCallFlowClientCallable(ctx: RuleContext, node: AnyNode) {
  const flow = getCallFlowEvidence(ctx);
  return (
    findAncestor(node, (current) => {
      const name = namedFunctionForNode(current);
      return Boolean(name && flow.clientCallable.has(name));
    }) !== null
  );
}

function getCallFlowEvidence(ctx: RuleContext) {
  const key = `nuxt:call-flow:${ctx.file.hash}`;
  const cached = ctx.cache.get<{ clientCallable: Set<string> }>(key);
  if (cached) return cached;
  const graph = buildCallFlowEvidence(ctx);
  ctx.cache.set(key, graph);
  return graph;
}

function buildCallFlowEvidence(ctx: RuleContext) {
  const functions = new Map<string, AnyNode>();
  const calls = new Map<string, Set<string>>();
  const clientCallable = new Set<string>();

  walkScriptLocal(ctx.file.scriptAst, (node) => {
    const declared = functionDeclarationName(node);
    if (declared) functions.set(declared.name, declared.node);
  });

  for (const [name, node] of functions) {
    const directCalls = collectDirectCalledFunctionNames(node, functions);
    if (directCalls.size) calls.set(name, directCalls);
  }

  for (const match of getTemplateSource(ctx).matchAll(TEMPLATE_EVENT_RE_G)) {
    const name = match[1]?.match(IDENT_RE_G)?.[0];
    if (name && functions.has(name)) clientCallable.add(name);
  }

  walkScriptLocal(ctx.file.scriptAst, (node) => {
    if (node.type === "CallExpression") {
      const callee = ctx.helpers.getCalleeName(node);
      const owner = nearestNamedFunction(node);
      if (owner) {
        const called = calledFunctionName(node);
        if (called && functions.has(called)) {
          const ownerCalls = calls.get(owner) ?? new Set<string>();
          ownerCalls.add(called);
          calls.set(owner, ownerCalls);
        }
      }
      if (callee && CLIENT_CALLBACK_RE.test(callee)) {
        for (const arg of node.arguments ?? []) {
          const name = callbackArgumentName(arg);
          if (name && functions.has(name)) clientCallable.add(name);
        }
      }
      if (callee && CLIENT_LIFECYCLE_RE.test(callee)) {
        for (const arg of node.arguments ?? []) {
          const name = callbackArgumentName(arg);
          if (name && functions.has(name)) clientCallable.add(name);
          for (const called of collectDirectCalledFunctionNames(arg, functions)) {
            clientCallable.add(called);
          }
        }
      }
      return;
    }
    if (node.type === "Property") collectCommandPropertyName(node, functions, clientCallable);
    if (node.type === "ReturnStatement")
      collectReturnedCommandNames(node.argument, functions, clientCallable);
  });

  const queue = [...clientCallable];
  while (queue.length) {
    const name = queue.shift()!;
    for (const called of calls.get(name) ?? []) {
      if (!clientCallable.has(called)) {
        clientCallable.add(called);
        queue.push(called);
      }
    }
  }

  return { clientCallable };
}

function namedFunctionForNode(node: AnyNode) {
  if (node.type === "FunctionDeclaration" && node.id?.name) return node.id.name;
  const parent = node.__doctorParent ?? node.parent;
  if (
    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier"
  )
    return parent.id.name;
  if (
    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.type) &&
    parent?.type === "Property"
  )
    return String(parent.key?.name ?? parent.key?.value ?? "");
  return null;
}

function functionDeclarationName(node: AnyNode): { name: string; node: AnyNode } | null {
  if (node.type === "FunctionDeclaration" && node.id?.name) return { name: node.id.name, node };
  if (
    node.type === "VariableDeclarator" &&
    node.id?.type === "Identifier" &&
    ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init?.type)
  )
    return { name: node.id.name, node: node.init };
  return null;
}

function calledFunctionName(node: AnyNode) {
  return node.callee?.type === "Identifier" ? node.callee.name : null;
}

function callbackArgumentName(node: AnyNode) {
  return node.type === "Identifier" ? node.name : null;
}

function collectDirectCalledFunctionNames(
  node: AnyNode,
  functions: Map<string, AnyNode>,
): Set<string> {
  const called = new Set<string>();
  const visit = (current: AnyNode, isRoot = false) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (
      !isRoot &&
      (current.type === "FunctionDeclaration" ||
        current.type === "FunctionExpression" ||
        current.type === "ArrowFunctionExpression")
    )
      return;
    if (current.type === "CallExpression") {
      const name = calledFunctionName(current);
      if (name && functions.has(name)) called.add(name);
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "__doctorParent" || key === "parent") continue;
      visit(value);
    }
  };
  visit(node, true);
  return called;
}

function collectReturnedCommandNames(
  node: AnyNode,
  functions: Map<string, AnyNode>,
  clientCallable: Set<string>,
) {
  if (!node || node.type !== "ObjectExpression") return;
  for (const property of node.properties ?? []) {
    const key = String(property.key?.name ?? property.key?.value ?? "");
    const value = property.value ?? property.argument;
    if (!isCommandLikeName(key) && !isCommandLikeName(String(value?.name ?? ""))) continue;
    if (value?.type === "Identifier" && functions.has(value.name)) clientCallable.add(value.name);
    if (["FunctionExpression", "ArrowFunctionExpression"].includes(value?.type) && key)
      clientCallable.add(key);
  }
}

function collectCommandPropertyName(
  property: AnyNode,
  functions: Map<string, AnyNode>,
  clientCallable: Set<string>,
) {
  const key = String(property.key?.name ?? property.key?.value ?? "");
  if (!isCommandLikeName(key)) return;
  const value = property.value ?? property.argument;
  if (value?.type === "Identifier" && functions.has(value.name)) clientCallable.add(value.name);
}

function isReturnedCommandCallback(node: AnyNode) {
  const fn = nearestFunctionOrProgram(node);
  if (!fn) return false;
  return (
    findAncestor(
      fn,
      (parent) =>
        (parent.type === "Property" &&
          isCommandLikeName(String(parent.key?.name ?? parent.key?.value ?? ""))) ||
        parent.type === "ReturnStatement",
    ) !== null
  );
}

function isTemplateBoundFunction(ctx: RuleContext, node: AnyNode) {
  const fn = nearestNamedFunction(node);
  return Boolean(fn && getTemplateBoundIdentifiers(ctx).has(fn));
}

function nearestNamedFunction(node: AnyNode): string | null {
  const found = findAncestor(
    node,
    (current) =>
      (current.type === "FunctionDeclaration" && current.id?.name) ||
      (current.type === "VariableDeclarator" && current.id?.type === "Identifier"),
  );
  return found?.id?.name ?? null;
}

function isLifecycleOrWatcherCallback(node: AnyNode) {
  const fn = nearestFunctionOrProgram(node);
  if (!fn) return false;
  return (
    findAncestor(fn, (parent) => {
      if (parent.type !== "CallExpression") return false;
      const name = parent.callee?.name ?? parent.callee?.property?.name;
      return LIFECYCLE_RE.test(name ?? "");
    }) !== null
  );
}

function isCommandLikeName(name: string) {
  return COMMAND_LIKE_RE.test(name);
}

function nearestVariableDeclarator(node: AnyNode) {
  let current = node.__doctorParent ?? node.parent;
  while (current) {
    if (current.type === "VariableDeclarator") return current;
    if (nearestFunctionOrProgram(current) === current) return null;
    current = current.__doctorParent ?? current.parent;
  }
  return null;
}

function isHydratingStateValue(node: AnyNode) {
  return (
    findAncestor(
      node,
      (current) =>
        current.type === "CallExpression" &&
        (current.callee?.name === "useState" || current.callee?.name === "useAsyncData"),
    ) !== null
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
