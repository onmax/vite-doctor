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
const TEMPLATE_EVENT_RE_G = /(?:@|v-on:)[\w:-]+(?:\.[\w.]+)?\s*=\s*["']([^"']+)["']/g;
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
  // Event bindings do not exclude SSR calls to the same helper. Preserve source offsets for guards.
  const executionSource = text.replace(TEMPLATE_BLOCK_RE, (template) =>
    template.replace(TEMPLATE_EVENT_RE_G, (event) => " ".repeat(event.length)),
  );
  if (ctx.helpers.isClientOnlyExecutionContext(node, executionSource)) return false;
  const source = sourceForNode(node, text);
  if (!source) return false;
  const template = getTemplateSource(ctx);
  if (template.includes(source)) return true;

  const declarator = nearestVariableDeclarator(node);
  const name = declarator?.id?.type === "Identifier" ? declarator.id.name : "";
  if (name && getRenderedReferences(ctx).some((reference) => reference.name === name)) return true;
  if (name && new RegExp(`{{[^}]*\\b${escapeRegExp(name)}\\b[^}]*}}`).test(template)) return true;
  if (isHydratingStateValue(node)) return true;
  const owner = nearestFunctionOrProgram(node);
  if (owner && renderedSetupWrite(ctx, node, owner)) return true;
  return Boolean(
    owner &&
    contributesToReturn(node, owner, getScriptParents(ctx)) &&
    functionFlowsToTemplate(ctx, owner, new Set(), node),
  );
}

function renderedSetupWrite(ctx: RuleContext, source: AnyNode, owner: AnyNode): boolean {
  const parents = getScriptParents(ctx);
  let assignment = source;
  while (assignment && assignment !== owner) {
    if (assignment.type === "AssignmentExpression" && assignment.operator === "=") break;
    assignment = parents.get(assignment);
  }
  if (
    !assignment ||
    assignment === owner ||
    !contributesToReturn(source, owner, parents, new Set(), assignment.right)
  )
    return false;
  let target = unwrapExpression(assignment.left);
  while (target?.type === "MemberExpression") target = unwrapExpression(target.object);
  if (target?.type !== "Identifier") return false;
  const binding = resolveLocalBinding(assignment, target.name, parents);
  if (
    !binding ||
    hasPriorAliasWrite({ start: Infinity }, binding, owner, parents, assignment) ||
    resolveLocalBinding(ctx.file.scriptAst, target.name, parents) !== binding ||
    !getRenderedReferences(ctx).some(
      (reference) =>
        reference.name === target.name &&
        projectionIncludes(source, assignment, reference, parents),
    )
  )
    return false;
  const executes = (fn: AnyNode, seen: Set<AnyNode>): boolean => {
    if (seen.has(fn) || fn.generator || fn.async) return false;
    seen.add(fn);
    let found = false;
    walkScriptLocal(ctx.file.scriptAst, (call) => {
      if (call.type !== "CallExpression" || resolveLocalValue(call.callee, parents) !== fn) return;
      if (ctx.helpers.isClientOnlyExecutionContext(call, ctx.file.text)) return;
      if (isInactivePath(call, containingFunction(call, parents), parents)) return;
      const caller = containingFunction(call, parents);
      if (caller) {
        if (executes(caller, new Set(seen))) found = true;
      } else if (
        !hasPriorAliasWrite({ start: Infinity }, binding, ctx.file.scriptAst, parents, {
          ...assignment,
          start: call.start,
        })
      )
        found = true;
    });
    return found;
  };
  return executes(owner, new Set());
}

function functionFlowsToTemplate(
  ctx: RuleContext,
  fn: AnyNode,
  seen: Set<AnyNode>,
  source: AnyNode,
): boolean {
  const parents = getScriptParents(ctx);
  if (seen.has(fn)) return false;
  seen.add(fn);
  const callbackCall = resultCallbackCall(fn, parents);
  if (callbackCall) {
    const owner = containingFunction(callbackCall, parents);
    if (
      !owner &&
      (callbackCall.callee.type === "MemberExpression" ||
        unwrapExpression(callbackCall.callee) === fn) &&
      isLikelyRenderedTimeExpression(ctx, callbackCall) &&
      getRenderedReferences(ctx).some((reference) => {
        const variable = nearestVariableDeclarator(callbackCall);
        return (
          variable &&
          patternBinds(variable.id, reference.name) &&
          projectionIncludes(source, variable, reference, parents)
        );
      })
    )
      return true;
    if (owner && contributesToReturn(callbackCall, owner, parents))
      return functionFlowsToTemplate(ctx, owner, seen, callbackCall);
  }
  const getter = parents.get(fn)?.kind === "get";
  const binding = functionBinding(fn, parents);
  const functionName = binding.id?.type === "Identifier" ? binding.id.name : null;
  if (!functionName) return false;
  const memberPath: string[] = [];
  for (let current = fn; current && current !== binding; current = parents.get(current)) {
    const parent = parents.get(current);
    if (parent?.type !== "Property") continue;
    const key = parent.computed ? parent.key?.value : (parent.key?.name ?? parent.key?.value);
    if (key === undefined) return false;
    memberPath.unshift(String(key));
  }
  const capturedReferences = new WeakMap<AnyNode, AnyNode>();
  const matchesCallee = (callee: AnyNode): boolean => {
    const original = callee;
    if (invocationMethod(callee)) {
      let target = resolveLocalValue(callee.object, parents, new Set(), [], ctx.file.scriptAst);
      const aliases = new Set<AnyNode>();
      while (target?.type === "Identifier" && !aliases.has(target)) {
        aliases.add(target);
        target = resolveLocalValue(target, parents);
      }
      if (target === fn) callee = callee.object;
    }
    if (!memberPath.length && callee?.type === "MemberExpression") {
      let value = resolveLocalValue(callee, parents, new Set(), [], ctx.file.scriptAst);
      const captured = value;
      const aliases = new Set<AnyNode>();
      while (value?.type === "Identifier" && !aliases.has(value)) {
        aliases.add(value);
        value = resolveLocalValue(value, parents);
      }
      if (value === fn) {
        capturedReferences.set(original, captured);
        return true;
      }
    }
    const path = [...memberPath];
    const visited = new Set<AnyNode>();
    let captured: AnyNode;
    while (callee) {
      callee = unwrapExpression(callee);
      if (callee?.type === "MemberExpression") {
        const accessed = callee.computed ? callee.property?.value : callee.property?.name;
        if (!path.length || String(accessed) !== path.pop()) return false;
        callee = callee.object;
        continue;
      }
      if (callee?.type !== "Identifier") return false;
      const local = resolveLocalBinding(
        parents.has(callee) ? callee : ctx.file.scriptAst,
        callee.name,
        parents,
      );
      if (local === binding) {
        if (path.length) return false;
        if (captured) capturedReferences.set(original, captured);
        return true;
      }
      if (!local || visited.has(local) || local.type !== "VariableDeclarator") return false;
      visited.add(local);
      const reference = parents.has(callee) ? callee : { start: Infinity };
      const owner = containingFunction(local, parents) ?? ctx.file.scriptAst;
      if (hasPriorAliasWrite(reference, local, owner, parents)) return false;
      if (!memberPath.length || path.length) captured = local;
      const aliasPath = patternPath(local.id, callee.name);
      if (!aliasPath) return false;
      for (const key of aliasPath.toReversed()) {
        if (path.pop() !== key) return false;
      }
      callee = local.init;
    }
    return false;
  };
  const reachesCall = (call: AnyNode, template = false): boolean => {
    if (call.type === "NewExpression") {
      let returnsObject = false;
      walkScriptLocal(fn.body, (statement) => {
        if (statement.type !== "ReturnStatement" || containingFunction(statement, parents) !== fn)
          return;
        const value = resolveLocalValue(statement.argument, parents);
        if (
          [
            "ObjectExpression",
            "ArrayExpression",
            "FunctionExpression",
            "ArrowFunctionExpression",
            "NewExpression",
          ].includes(value?.type) &&
          contributesToReturn(source, fn, parents, new Set(), statement.argument)
        )
          returnsObject = true;
      });
      if (!returnsObject) return false;
    }
    const captured = capturedReferences.get(getter ? call : call.callee);
    const reference = captured ?? (template ? { start: Infinity } : call);
    const assignment = parents.get(fn);
    if (
      assignment?.type === "AssignmentExpression" &&
      (assignment.start >= reference.start ||
        !writeDominatesReference(
          assignment,
          reference,
          containingFunction(assignment, parents) ?? ctx.file.scriptAst,
          parents,
        ))
    )
      return false;
    for (
      let current = source, child = source;
      current && current !== fn;
      child = current, current = parents.get(current)
    ) {
      if (current.type !== "AssignmentPattern" || current.right !== child) continue;
      const argument = parameterValue(current, fn, call, parents);
      if (argument && !isUndefinedValue(argument, parents, ctx.file.scriptAst)) return false;
    }
    let replaced = false;
    walkScriptLocal(ctx.file.scriptAst, (write) => {
      if (
        write.type !== "AssignmentExpression" ||
        write.operator !== "=" ||
        (assignment?.type === "AssignmentExpression" && write.start <= assignment.start) ||
        (binding.type !== "FunctionDeclaration" && write.start <= binding.start) ||
        write.start >= reference.start
      )
        return;
      let target = write.left;
      const path: string[] = [];
      while (target?.type === "MemberExpression") {
        const key = target.computed ? target.property?.value : target.property?.name;
        if (key === undefined) return;
        path.unshift(String(key));
        target = target.object;
      }
      if (target?.name !== functionName || !path.every((key, index) => memberPath[index] === key))
        return;
      if (resolveLocalBinding(write, functionName, parents) !== binding) return;
      const owner = containingFunction(write, parents);
      if (owner !== (template ? null : containingFunction(call, parents))) return;
      if (writeDominatesReference(write, reference, owner ?? ctx.file.scriptAst, parents))
        replaced = true;
    });
    return !replaced;
  };
  const renderedReferences = getRenderedReferences(ctx);
  if (
    resolveLocalBinding(ctx.file.scriptAst, functionName, parents) === binding &&
    renderedReferences.some((reference) => {
      let callee = reference;
      while (
        callee.parent?.type === "MemberExpression" &&
        callee.parent.object === callee &&
        !(getter && matchesCallee(callee))
      )
        callee = callee.parent;
      const call = getter ? callee : callee.parent;
      return (
        (getter ||
          (["CallExpression", "NewExpression"].includes(call?.type) && call.callee === callee)) &&
        matchesCallee(callee) &&
        reachesCall(call, true) &&
        projectionIncludes(source, fn, call, parents) &&
        (!fn.generator ||
          isConsumedIterator(
            call,
            (node) => node.parent,
            () => !resolveLocalBinding(ctx.file.scriptAst, "Array", parents),
            () => reachesFirstYield(source, fn, parents),
          )) &&
        (!fn.async ||
          asyncResultIsConsumed(
            call,
            (node) => node.parent,
            () => !resolveLocalBinding(ctx.file.scriptAst, "Promise", parents),
          ))
      );
    })
  )
    return true;
  const visit = (node: AnyNode, owner: AnyNode, variable: AnyNode): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((child) => visit(child, owner, variable));
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    ) {
      const call = resultCallbackCall(node, parents);
      if (!call || (owner && !contributesToReturn(call, owner, parents))) variable = null;
      owner = node;
    }
    if (node.type === "VariableDeclarator") return visit(node.init, owner, node);
    if (node.type === "AssignmentExpression" && node.operator === "=")
      return visit(node.right, owner, node);
    const callback =
      node.type === "CallExpression" &&
      node.arguments.some(
        (argument: AnyNode) =>
          matchesCallee(argument) && resultCallbackCall(fn, parents, argument) === node,
      );

    if (
      (getter
        ? node.type === "MemberExpression"
        : ["CallExpression", "NewExpression"].includes(node.type)) &&
      (callback || matchesCallee(getter ? node : node.callee)) &&
      reachesCall(node)
    ) {
      if (
        fn.generator &&
        !isConsumedIterator(
          node,
          (node) => parents.get(node),
          (call) => !resolveLocalBinding(call, "Array", parents),
          () => reachesFirstYield(source, fn, parents),
        )
      )
        return false;
      const originalVariable = variable;
      for (const result of fn.async ? resultAliases(node, parents) : [node]) {
        const owner = containingFunction(result, parents);
        let variable = result === node ? originalVariable : null;
        if (result !== node) {
          for (let current = result; current && current !== owner; current = parents.get(current)) {
            if (["VariableDeclarator", "AssignmentExpression"].includes(current.type)) {
              variable = current;
              break;
            }
          }
        }
        if (
          fn.async &&
          !asyncResultIsConsumed(
            result,
            (node) => parents.get(node),
            (aggregate) => !resolveLocalBinding(aggregate, "Promise", parents),
          )
        )
          continue;
        if (
          variable &&
          (!owner || contributesToReturn(result, owner, parents)) &&
          renderedReferences.some(
            (reference) =>
              patternBinds(variable.id ?? variable.left, reference.name) &&
              resolveLocalBinding(ctx.file.scriptAst, reference.name, parents) ===
                (variable.type === "AssignmentExpression"
                  ? resolveLocalBinding(variable, reference.name, parents)
                  : variable) &&
              !hasPriorAliasWrite(
                reference,
                resolveLocalBinding(ctx.file.scriptAst, reference.name, parents),
                ctx.file.scriptAst,
                parents,
                variable,
              ) &&
              projectionIncludes(result, variable, reference, parents, [source, fn]),
          )
        )
          return true;
        if (
          owner &&
          owner !== fn &&
          contributesToReturn(result, owner, parents) &&
          functionFlowsToTemplate(ctx, owner, new Set(seen), result)
        )
          return true;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "__doctorParent" || key === "parent") continue;
      if (value && typeof value === "object" && visit(value, owner, variable)) return true;
    }
    return false;
  };
  return visit(ctx.file.scriptAst, null, null);
}

function resultAliases(
  node: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  seen = new Set<AnyNode>(),
): AnyNode[] {
  if (seen.has(node)) return [];
  seen.add(node);
  const results = [node];
  let expression = node;
  while (
    parents.get(expression) &&
    unwrapExpression(parents.get(expression)) === unwrapExpression(expression)
  )
    expression = parents.get(expression);
  const binding = parents.get(expression);
  if (
    binding?.type !== "VariableDeclarator" ||
    binding.init !== expression ||
    binding.id.type !== "Identifier"
  )
    return results;
  let scope = containingFunction(binding, parents);
  if (!scope) {
    scope = binding;
    while (parents.get(scope)) scope = parents.get(scope);
  }
  walkScriptLocal(scope.body, (reference) => {
    if (
      reference.type === "Identifier" &&
      reference.start > binding.start &&
      resolveLocalBinding(reference, reference.name, parents) === binding &&
      !hasPriorAliasWrite(reference, binding, scope, parents)
    ) {
      results.push(...resultAliases(reference, parents, seen));
    }
  });
  return results;
}

function isUndefinedValue(
  node: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  scope = node,
): boolean {
  return (
    !node ||
    (node.type === "Identifier" &&
      node.name === "undefined" &&
      !resolveLocalBinding(parents.has(node) ? node : scope, "undefined", parents)) ||
    (node.type === "UnaryExpression" && node.operator === "void")
  );
}

function parameterValue(
  pattern: AnyNode,
  fn: AnyNode,
  call: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
): AnyNode {
  const index = fn.params?.indexOf(pattern) ?? -1;
  if (index >= 0) {
    const method =
      resolveLocalValue(call.callee, parents, new Set(), [], fn) === fn
        ? null
        : invocationMethod(call.callee);
    const args =
      method === "call"
        ? call.arguments.slice(1)
        : method === "apply"
          ? call.arguments[1]?.type === "ArrayExpression"
            ? call.arguments[1].elements
            : null
          : call.arguments;
    if (!args) return undefined;
    if (args.slice(0, index + 1).some((arg: AnyNode) => arg?.type === "SpreadElement"))
      return undefined;
    return args[index] ?? null;
  }
  const parent = parents.get(pattern);
  if (parent?.type === "AssignmentPattern" && parent.left === pattern) {
    const value = parameterValue(parent, fn, call, parents);
    return value === undefined
      ? undefined
      : isUndefinedValue(value, parents)
        ? parent.right
        : value;
  }
  if (parent?.type === "Property" && parent.value === pattern) {
    const value = parameterValue(parents.get(parent), fn, call, parents);
    const key = parent.computed ? parent.key?.value : (parent.key?.name ?? parent.key?.value);
    if (value?.type !== "ObjectExpression" || key === undefined) return undefined;
    for (const property of [...value.properties].reverse()) {
      if (property.type === "SpreadElement") return undefined;
      const propertyKey = property.computed
        ? property.key?.value
        : (property.key?.name ?? property.key?.value);
      if (propertyKey === undefined) return undefined;
      if (String(propertyKey) === String(key)) return property.value;
    }
    return null;
  }
  if (parent?.type === "ArrayPattern") {
    const value = parameterValue(parent, fn, call, parents);
    const index = parent.elements.indexOf(pattern);
    if (value?.type !== "ArrayExpression" || index < 0) return undefined;
    if (value.elements.slice(0, index + 1).some((item: AnyNode) => item?.type === "SpreadElement"))
      return undefined;
    return value.elements[index] ?? null;
  }
  return undefined;
}

function arrayElementCount(array: AnyNode, includeHoles: boolean): number {
  let count = 0;
  for (const element of array.elements ?? []) {
    if (element?.type === "SpreadElement") {
      if (element.argument?.type !== "ArrayExpression") return Infinity;
      count += arrayElementCount(element.argument, true);
    } else if (element || includeHoles) count++;
  }
  return count;
}

function unwrapExpression(node: AnyNode): AnyNode {
  while (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "TSInstantiationExpression",
    ].includes(node?.type)
  )
    node = node.expression;
  return node;
}

function resultCallbackCall(
  fn: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  expression = fn,
): AnyNode {
  if (fn.generator) return null;
  while (
    parents.get(expression) &&
    unwrapExpression(parents.get(expression)) === unwrapExpression(expression)
  )
    expression = parents.get(expression);
  const call = parents.get(expression);
  if (call?.type !== "CallExpression") return null;
  if (call.callee === expression)
    return !fn.async ||
      asyncResultIsConsumed(
        call,
        (node) => parents.get(node),
        (node) => !resolveLocalBinding(node, "Promise", parents),
      )
      ? call
      : null;
  if (fn.async) return null;
  if (
    call.callee?.type === "MemberExpression" &&
    call.callee.object?.name === "Array" &&
    !resolveLocalBinding(call, "Array", parents) &&
    (call.callee.computed ? call.callee.property?.value : call.callee.property?.name) === "from" &&
    call.arguments[1] === expression
  ) {
    const input = unwrapExpression(call.arguments[0]);
    return input?.type === "ArrayExpression" && arrayElementCount(input, true) > 0 ? call : null;
  }
  if (call.arguments[0] !== expression) return null;
  if (call.callee?.type === "Identifier" && call.callee.name === "computed") {
    const binding = resolveLocalBinding(call, "computed", parents);
    return !binding ||
      (binding.type === "ImportSpecifier" &&
        binding.imported?.name === "computed" &&
        ["vue", "#imports"].includes(parents.get(binding)?.source?.value))
      ? call
      : null;
  }
  if (
    call.callee?.type === "MemberExpression" &&
    !call.callee.computed &&
    [
      "map",
      "flatMap",
      "sort",
      "toSorted",
      "filter",
      "some",
      "every",
      "find",
      "findIndex",
      "findLast",
      "findLastIndex",
      "reduce",
      "reduceRight",
    ].includes(call.callee.property?.name)
  ) {
    const receiver = unwrapExpression(call.callee.object);
    const bindings = new Set<AnyNode>();
    let value = receiver;
    let scope = containingFunction(call, parents);
    if (!scope) {
      scope = call;
      while (parents.get(scope)) scope = parents.get(scope);
    }
    while (value?.type === "Identifier") {
      const binding = resolveLocalBinding(value, value.name, parents);
      if (!binding || bindings.has(binding) || hasPriorAliasWrite(call, binding, scope, parents))
        return null;
      bindings.add(binding);
      value = unwrapExpression(binding.init);
    }
    if (value?.type === "ArrayExpression") {
      const method = call.callee.property.name;
      const count = arrayElementCount(
        value,
        ["find", "findIndex", "findLast", "findLastIndex"].includes(method),
      );
      const minimum =
        ["sort", "toSorted"].includes(method) ||
        (["reduce", "reduceRight"].includes(method) && call.arguments.length < 2)
          ? 2
          : 1;
      if (count < minimum) return null;
      let methodReplaced = false;
      for (const binding of bindings)
        walkScriptLocal(scope.body, (write) => {
          const target =
            write.type === "AssignmentExpression" ? unwrapExpression(write.left) : null;
          if (
            write.start <= binding.start ||
            write.start >= call.start ||
            target?.type !== "MemberExpression" ||
            unwrapExpression(target.object)?.type !== "Identifier"
          )
            return;
          const key = target.computed ? target.property?.value : target.property?.name;
          if (
            (key === undefined || String(key) === method) &&
            resolveLocalBinding(write, unwrapExpression(target.object).name, parents) === binding &&
            writeDominatesReference(write, call, scope, parents)
          )
            methodReplaced = true;
        });
      if (!methodReplaced) return call;
    }
  }
  return null;
}

function alwaysReplacesCompletion(node: AnyNode): boolean {
  if (!node) return false;
  if (
    ["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(node.type)
  )
    return true;
  if (node.type === "BlockStatement") return node.body.some(alwaysReplacesCompletion);
  if (node.type === "IfStatement")
    return alwaysReplacesCompletion(node.consequent) && alwaysReplacesCompletion(node.alternate);
  if (node.type === "TryStatement")
    return (
      alwaysReplacesCompletion(node.finalizer) ||
      (alwaysReplacesCompletion(node.block) &&
        (!node.handler || alwaysReplacesCompletion(node.handler.body)))
    );
  return false;
}

function returnIsOverridden(node: AnyNode, parentOf: (node: AnyNode) => AnyNode): boolean {
  for (let current = node; current; current = parentOf(current)) {
    const parent = parentOf(current);
    if (
      !parent ||
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(parent.type)
    )
      return false;
    if (
      parent.type === "TryStatement" &&
      current !== parent.finalizer &&
      alwaysReplacesCompletion(parent.finalizer)
    )
      return true;
  }
  return false;
}

function parameterContributesToReturn(
  fn: AnyNode,
  index: number,
  parents: WeakMap<AnyNode, AnyNode>,
  seen = new Set<AnyNode>(),
  argumentSource?: [AnyNode, AnyNode],
): boolean {
  const parameter =
    fn.params[index] ?? fn.params.find((param: AnyNode) => param.type === "RestElement");
  if (!parameter) return false;
  let contributes = false;
  walkScriptLocal(fn.body, (reference) => {
    if (
      reference.type === "Identifier" &&
      patternBinds(parameter, reference.name) &&
      resolveLocalBinding(reference, reference.name, parents) === parameter &&
      !hasPriorAliasWrite(reference, parameter, fn, parents) &&
      (!argumentSource ||
        projectionIncludes(argumentSource[0], argumentSource[1], reference, parents)) &&
      contributesToReturn(reference, fn, parents, new Set(seen))
    )
      contributes = true;
  });
  return contributes;
}

function invocationMethod(callee: AnyNode): string | null {
  if (callee?.type !== "MemberExpression") return null;
  const method = callee.computed ? callee.property?.value : callee.property?.name;
  return method === "call" || method === "apply" ? method : null;
}

function isInactivePath(
  node: AnyNode,
  owner: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
): boolean {
  for (let current = node; current && current !== owner; current = parents.get(current)) {
    if (expressionBranchIsInactive(parents.get(current), current)) return true;
  }
  return false;
}

function reachesFirstYield(
  source: AnyNode,
  fn: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
): boolean {
  const yields: AnyNode[] = [];
  walkScriptLocal(fn.body, (node) => {
    if (
      node.type === "YieldExpression" &&
      containingFunction(node, parents) === fn &&
      !isInactivePath(node, fn, parents)
    )
      yields.push(node);
  });
  return yields.some(
    (yielded) =>
      contributesToReturn(source, fn, parents, new Set(), yielded.argument) &&
      !yields.some(
        (prior) =>
          !prior.delegate &&
          prior.end <= yielded.start &&
          writeDominatesReference(prior, yielded, fn, parents),
      ),
  );
}

function expressionBranchIsInactive(parent: AnyNode, current: AnyNode): boolean {
  const selector = unwrapExpression(
    ["ConditionalExpression", "IfStatement"].includes(parent?.type) ? parent.test : parent?.left,
  );
  if (selector?.type !== "Literal") return false;
  if (["ConditionalExpression", "IfStatement"].includes(parent.type))
    return current === (selector.value ? parent.alternate : parent.consequent);
  return (
    parent.type === "LogicalExpression" &&
    current === parent.right &&
    ((parent.operator === "&&" && !selector.value) ||
      (parent.operator === "||" && Boolean(selector.value)) ||
      (parent.operator === "??" && selector.value != null))
  );
}

function asyncResultIsConsumed(
  node: AnyNode,
  parentOf: (node: AnyNode) => AnyNode,
  hasNativePromise: (node: AnyNode) => boolean,
): boolean {
  let awaited = false;
  for (let current = node; current; current = parentOf(current)) {
    const parent = parentOf(current);
    if (!parent) return awaited;
    if (parent.type === "SequenceExpression" && parent.expressions.at(-1) !== current) return false;
    if (parent.type === "UnaryExpression" && parent.operator === "void") return false;
    if (!awaited) {
      if (parent.type === "MemberExpression" && parent.object === current) {
        const chain = parentOf(parent);
        const method = parent.computed ? parent.property?.value : parent.property?.name;
        if (
          chain?.type !== "CallExpression" ||
          chain.callee !== parent ||
          !["then", "catch", "finally"].includes(method)
        )
          return false;
        if (method === "then" && chain.arguments[0] && chain.arguments[0].type !== "Literal") {
          const callbackParents = new WeakMap<AnyNode, AnyNode>();
          let root = chain;
          while (parentOf(root)) root = parentOf(root);
          walkScriptLocal(root, (child) => callbackParents.set(child, parentOf(child)));
          let callback = unwrapExpression(chain.arguments[0]);
          const bindings = new Set<AnyNode>();
          while (callback?.type === "Identifier") {
            const binding = resolveLocalBinding(callback, callback.name, callbackParents);
            if (!binding || bindings.has(binding)) return false;
            bindings.add(binding);
            const scope = containingFunction(chain, callbackParents) ?? root;
            if (hasPriorAliasWrite(chain, binding, scope, callbackParents)) return false;
            callback = unwrapExpression(
              binding.type === "VariableDeclarator" ? binding.init : binding,
            );
          }
          if (
            !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
              callback?.type,
            )
          )
            return false;
          if (!parameterContributesToReturn(callback, 0, callbackParents)) return false;
        }
        current = parent;
        continue;
      }
      if (parent.type === "AwaitExpression") awaited = true;
      else if (parent.type === "ReturnStatement" || parent.type === "ArrowFunctionExpression") {
        let owner = parent;
        while (
          owner &&
          !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
            owner.type,
          )
        )
          owner = parentOf(owner);
        return Boolean(owner?.async) && !returnIsOverridden(parent, parentOf);
      } else if (
        ![
          "ParenthesizedExpression",
          "SequenceExpression",
          "TSSatisfiesExpression",
          "TSAsExpression",
          "TSNonNullExpression",
          "TSTypeAssertion",
          "TSInstantiationExpression",
        ].includes(parent.type)
      ) {
        if (
          parent.type === "CallExpression" &&
          parent.arguments[0] === current &&
          parent.callee?.type === "MemberExpression" &&
          parent.callee.object?.name === "Promise" &&
          (parent.callee.computed
            ? parent.callee.property?.value
            : parent.callee.property?.name) === "resolve" &&
          hasNativePromise(parent)
        )
          continue;
        if (parent.type !== "ArrayExpression") return false;
        const aggregate = parentOf(parent);
        if (
          aggregate?.type !== "CallExpression" ||
          aggregate.arguments[0] !== parent ||
          aggregate.callee?.type !== "MemberExpression" ||
          aggregate.callee.object?.type !== "Identifier" ||
          aggregate.callee.object.name !== "Promise" ||
          !["all", "race", "any", "allSettled"].includes(
            aggregate.callee.computed
              ? aggregate.callee.property?.value
              : aggregate.callee.property?.name,
          ) ||
          !hasNativePromise(aggregate)
        )
          return false;
        current = parent;
      }
    } else if (parent.type === "AssignmentExpression" && parent.right === current) {
      return true;
    } else if (
      [
        "VariableDeclarator",
        "ReturnStatement",
        "ArrowFunctionExpression",
        "VExpressionContainer",
      ].includes(parent.type)
    ) {
      return true;
    } else if (parent.type === "ExpressionStatement") return false;
  }
  return awaited;
}

function isConsumedIterator(
  node: AnyNode,
  parentOf: (node: AnyNode) => AnyNode,
  hasNativeArray: (node: AnyNode) => boolean,
  reachesFirst: () => boolean,
): boolean {
  const parent = parentOf(node);
  const nextCall = parent && parentOf(parent);
  const value = nextCall && parentOf(nextCall);
  if (
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    (parent.computed ? parent.property?.value : parent.property?.name) === "next" &&
    nextCall?.type === "CallExpression" &&
    nextCall.callee === parent &&
    value?.type === "MemberExpression" &&
    value.object === nextCall &&
    (value.computed ? value.property?.value : value.property?.name) === "value"
  )
    return reachesFirst();
  return (
    (parent?.type === "VariableDeclarator" &&
      parent.init === node &&
      parent.id?.type === "ArrayPattern" &&
      parent.id.elements.length > 0) ||
    (parent?.type === "AssignmentExpression" &&
      parent.right === node &&
      parent.left?.type === "ArrayPattern" &&
      parent.left.elements.length > 0) ||
    (parent?.type === "YieldExpression" && parent.delegate && parent.argument === node) ||
    (parent?.type === "SpreadElement" &&
      ["ArrayExpression", "CallExpression", "NewExpression"].includes(parentOf(parent)?.type)) ||
    (["ForOfStatement", "VForExpression"].includes(parent?.type) && parent.right === node) ||
    (parent?.type === "CallExpression" &&
      parent.arguments[0] === node &&
      parent.callee?.type === "MemberExpression" &&
      parent.callee.object?.name === "Array" &&
      (parent.callee.computed ? parent.callee.property?.value : parent.callee.property?.name) ===
        "from" &&
      hasNativeArray(parent))
  );
}

function getRenderedReferences(ctx: RuleContext): AnyNode[] {
  const references: AnyNode[] = [];
  const visit = (node: AnyNode) => {
    if (!node) return;
    if (node.type === "VExpressionContainer") {
      for (const reference of node.references ?? []) {
        if (!reference.variable && reference.mode !== "w") references.push(reference.id);
      }
      return;
    }
    if (node.type === "VElement") {
      for (const attribute of node.startTag.attributes) {
        if (
          attribute.directive &&
          ["bind", "model", "if", "else-if", "show", "text", "html", "for"].includes(
            attribute.key.name.name,
          )
        ) {
          visit(attribute.value);
          if (attribute.key.name.name === "bind") visit(attribute.key.argument);
        }
      }
      for (const child of node.children) visit(child);
    }
  };
  visit(ctx.file.templateAst);
  return references;
}

function projectionIncludes(
  node: AnyNode,
  variable: AnyNode,
  reference: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  returnedSource?: [AnyNode, AnyNode],
): boolean {
  const path: (string | null)[] = [];
  for (const [start, end] of [...(returnedSource ? [returnedSource] : []), [node, variable]]) {
    for (let current = start; current && current !== end; current = parents.get(current)) {
      const parent = parents.get(current);
      if (["FunctionExpression", "ArrowFunctionExpression"].includes(current.type)) {
        const call = resultCallbackCall(current, parents);
        if (call && ["map", "from"].includes(call.callee.property?.name)) path.unshift(null);
      }
      if (parent?.type === "ArrayExpression") {
        const index = parent.elements.indexOf(current);
        if (
          parent.elements
            .slice(0, index + 1)
            .some((element: AnyNode) => element?.type === "SpreadElement")
        )
          return true;
        const aggregate = parents.get(parent);
        if (
          aggregate?.type === "CallExpression" &&
          aggregate.arguments[0] === parent &&
          aggregate.callee?.type === "MemberExpression" &&
          aggregate.callee.object?.name === "Promise" &&
          (aggregate.callee.computed
            ? aggregate.callee.property?.value
            : aggregate.callee.property?.name) === "allSettled" &&
          !resolveLocalBinding(aggregate, "Promise", parents)
        )
          path.unshift("value");
        path.unshift(String(index));
      }
      if (
        parent?.type === "Property" &&
        parent.value === current &&
        parents.get(parent)?.type === "ObjectExpression"
      ) {
        const key = parent.computed ? parent.key?.value : (parent.key?.name ?? parent.key?.value);
        if (key === undefined) return true;
        path.unshift(String(key));
      }
    }
  }
  let target = variable.id ?? variable.left;
  if (variable.type === "AssignmentExpression") {
    const storedPath: string[] = [];
    while (target?.type === "MemberExpression") {
      const key = target.computed ? target.property?.value : target.property?.name;
      if (key === undefined) return false;
      storedPath.unshift(String(key));
      target = unwrapExpression(target.object);
    }
    path.unshift(...storedPath);
  }
  const bindingPath = ["VariableDeclarator", "AssignmentExpression", "AssignmentPattern"].includes(
    variable.type,
  )
    ? patternPath(target, reference.name)
    : [];
  if (!bindingPath) return false;
  for (const key of bindingPath) {
    if (!path.length) break;
    const projected = path.shift();
    if (projected !== null && projected !== key) return false;
  }
  let current = reference;
  for (const key of path) {
    const member = parents.get(current) ?? current.parent;
    if (member?.type !== "MemberExpression" || member.object !== current) return true;
    const accessed = member.computed ? member.property?.value : member.property?.name;
    if (accessed === undefined) return true;
    if (key !== null && String(accessed) !== key) return false;
    current = member;
  }
  return true;
}

function patternPath(pattern: AnyNode, name: string): string[] | null {
  if (!pattern) return null;
  if (pattern.type === "Identifier") return pattern.name === name ? [] : null;
  if (pattern.type === "AssignmentPattern") return patternPath(pattern.left, name);
  const entries =
    pattern.type === "ArrayPattern"
      ? pattern.elements.map((element: AnyNode, index: number) => [String(index), element])
      : pattern.type === "ObjectPattern"
        ? pattern.properties.map((property: AnyNode) => [
            property.computed ? property.key?.value : (property.key?.name ?? property.key?.value),
            property.value,
          ])
        : [];
  for (const [key, value] of entries) {
    const path = patternPath(value, name);
    if (path && key !== undefined) return [String(key), ...path];
  }
  return null;
}

function containingFunction(node: AnyNode, parents: WeakMap<AnyNode, AnyNode>): AnyNode {
  let current = parents.get(node);
  while (current) {
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        current.type,
      )
    )
      return current;
    current = parents.get(current);
  }
  return null;
}

function resolveLocalValue(
  node: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  seen = new Set<AnyNode>(),
  path: string[] = [],
  referenceScope = node,
): AnyNode {
  node = unwrapExpression(node);
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "Identifier") {
    const binding = resolveLocalBinding(
      parents.has(node) ? node : referenceScope,
      node.name,
      parents,
    );
    if (!binding) return null;
    if (binding.type !== "VariableDeclarator") return binding;
    let scope = binding;
    while (parents.get(scope)) scope = parents.get(scope);
    if (hasPriorAliasWrite(parents.has(node) ? node : { start: Infinity }, binding, scope, parents))
      return null;
    const bindingPath = patternPath(binding.id, node.name) ?? [];
    const projectedPath = [...bindingPath, ...path];
    let memberWritten = false;
    walkScriptLocal(scope, (write) => {
      if (write.type !== "AssignmentExpression" || write.start >= (node.start ?? Infinity)) return;
      let target = unwrapExpression(write.left);
      if (target?.type !== "MemberExpression") return;
      const writtenPath: (string | undefined)[] = [];
      while (target?.type === "MemberExpression") {
        const key = target.computed ? target.property?.value : target.property?.name;
        writtenPath.unshift(key === undefined ? undefined : String(key));
        target = unwrapExpression(target.object);
      }
      if (
        target?.type === "Identifier" &&
        resolveLocalBinding(write, target.name, parents) === binding &&
        !writtenPath.some(
          (key, index) =>
            key !== undefined && projectedPath[index] !== undefined && key !== projectedPath[index],
        )
      )
        memberWritten = true;
    });
    if (memberWritten) return null;
    let value = resolveLocalValue(binding.init, parents, seen, projectedPath);
    for (const key of bindingPath) value = localObjectProperty(value, key);
    return value;
  }
  if (node.type === "MemberExpression") {
    const key = node.computed ? node.property?.value : node.property?.name;
    return key === undefined
      ? null
      : localObjectProperty(
          resolveLocalValue(node.object, parents, seen, [String(key), ...path], referenceScope),
          String(key),
        );
  }
  return node;
}

function localObjectProperty(value: AnyNode, key: string): AnyNode {
  if (value?.type !== "ObjectExpression") return null;
  for (const property of value.properties.toReversed()) {
    const name = property.computed
      ? property.key?.value
      : (property.key?.name ?? property.key?.value);
    if (property.type === "SpreadElement" || name === undefined) return null;
    if (String(name) === key)
      return property.kind === "get" ? null : unwrapExpression(property.value);
  }
  return null;
}

function contributesToReturn(
  node: AnyNode,
  owner: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  seen = new Set<AnyNode>(),
  sink?: AnyNode,
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  for (let current = node; current && current !== owner; current = parents.get(current)) {
    if (current === sink) return true;
    const parent = parents.get(current);
    if (
      parent?.type === "ExpressionStatement" ||
      (parent?.type === "UnaryExpression" && parent.operator === "void")
    )
      return false;
    if (parent?.type === "SequenceExpression" && parent.expressions.at(-1) !== current)
      return false;
    if (expressionBranchIsInactive(parent, current)) return false;
    if (parent?.type === "CallExpression" && parent.arguments.includes(current)) {
      const fn = resolveLocalValue(parent.callee, parents);
      if (
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
          fn?.type,
        ) &&
        !parameterContributesToReturn(fn, parent.arguments.indexOf(current), parents, seen, [
          node,
          current,
        ])
      )
        return false;
    }

    if (
      (parent?.type === "VariableDeclarator" && parent.init === current) ||
      (parent?.type === "AssignmentPattern" && parent.right === current) ||
      (parent?.type === "AssignmentExpression" && parent.right === current)
    ) {
      let identifier = parent.id ?? parent.left;
      while (identifier?.type === "MemberExpression")
        identifier = unwrapExpression(identifier.object);
      let returned = false;
      walkScriptLocal(owner.body, (reference) => {
        if (
          reference.type !== "Identifier" ||
          reference.start <= parent.start ||
          !patternBinds(identifier, reference.name) ||
          !projectionIncludes(node, parent, reference, parents)
        )
          return;
        const binding = ["AssignmentExpression", "AssignmentPattern"].includes(parent.type)
          ? resolveLocalBinding(parent, reference.name, parents)
          : parent;
        if (
          binding &&
          resolveLocalBinding(reference, reference.name, parents) === binding &&
          !hasPriorAliasWrite(reference, binding, owner, parents, parent) &&
          contributesToReturn(reference, owner, parents, seen, sink)
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
    if (
      (parent?.type === "IfStatement" && parent.test === current) ||
      (parent?.type === "SwitchStatement" && parent.discriminant === current) ||
      (parent?.type === "SwitchCase" && parent.test === current)
    ) {
      let selectsReturn = false;
      const branch = parent.type === "SwitchCase" ? parents.get(parent) : parent;
      walkScriptLocal(branch, (statement) => {
        if (
          statement.type === "ReturnStatement" &&
          containingFunction(statement, parents) === owner
        )
          selectsReturn = true;
      });
      if (selectsReturn) return !returnsSameLiteral(owner, parents);
    }
    if (parent?.type === "YieldExpression" && owner.generator) return !sink;
    if (parent?.type === "ReturnStatement") {
      let scope = parent;
      while (
        scope &&
        !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
          scope.type,
        )
      )
        scope = parents.get(scope);
      return (
        scope === owner &&
        !owner.generator &&
        !returnIsOverridden(parent, (node) => parents.get(node))
      );
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

function isInertExpression(node: AnyNode): boolean {
  if (!node) return true;
  if (node.type === "Literal") return true;
  if (node.type === "UnaryExpression" && node.operator !== "delete")
    return isInertExpression(node.argument);
  if (["BinaryExpression", "LogicalExpression"].includes(node.type))
    return isInertExpression(node.left) && isInertExpression(node.right);
  if (node.type === "ConditionalExpression")
    return [node.test, node.consequent, node.alternate].every(isInertExpression);
  if (node.type === "SequenceExpression") return node.expressions.every(isInertExpression);
  return false;
}

function returnsSameLiteral(owner: AnyNode, parents: WeakMap<AnyNode, AnyNode>): boolean {
  const alwaysReturns = (statement: AnyNode): boolean => {
    if (statement?.type === "ReturnStatement") return true;
    if (statement?.type === "BlockStatement") return alwaysReturns(statement.body.at(-1));
    return (
      statement?.type === "IfStatement" &&
      alwaysReturns(statement.consequent) &&
      alwaysReturns(statement.alternate)
    );
  };
  if (!alwaysReturns(owner.body)) return false;
  let first: AnyNode;
  let same = true;
  walkScriptLocal(owner.body, (statement) => {
    if (containingFunction(statement, parents) !== owner) return;
    if (
      (statement.type === "ExpressionStatement" && !isInertExpression(statement.expression)) ||
      (statement.type === "VariableDeclarator" &&
        statement.init &&
        !isInertExpression(statement.init)) ||
      ["AssignmentExpression", "UpdateExpression", "ThrowStatement"].includes(statement.type)
    )
      same = false;
    if (statement.type !== "ReturnStatement") return;
    const argument = statement.argument;
    const value =
      !argument ||
      (argument.type === "Identifier" &&
        argument.name === "undefined" &&
        !resolveLocalBinding(argument, "undefined", parents))
        ? { type: "Literal", value: undefined }
        : argument;
    if (value?.type !== "Literal" || value.regex) {
      same = false;
      return;
    }
    if (first && !Object.is(first.value, value.value)) same = false;
    first = value;
  });
  return same && !!first;
}

function hasPriorAliasWrite(
  reference: AnyNode,
  binding: AnyNode,
  owner: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
  source = binding,
  requireDominance = true,
): boolean {
  const name = reference.name ?? binding.id?.name ?? binding.left?.name;
  const storedPath: string[] = [];
  if (source.type === "AssignmentExpression") {
    let target = source.left;
    while (target?.type === "MemberExpression") {
      const key = target.computed ? target.property?.value : target.property?.name;
      if (key === undefined) break;
      storedPath.unshift(String(key));
      target = unwrapExpression(target.object);
    }
  }
  let reassigned = false;
  walkScriptLocal(owner.body, (write) => {
    if (
      write.start >= reference.start ||
      write.start <= source.start ||
      containingFunction(write, parents) !== (owner.type === "Program" ? null : owner)
    )
      return;
    const target =
      write.type === "AssignmentExpression"
        ? write.left
        : write.type === "UpdateExpression"
          ? write.argument
          : ["ForInStatement", "ForOfStatement"].includes(write.type)
            ? write.left
            : null;
    let replacesMember = false;
    if (storedPath.length && write.type === "AssignmentExpression" && write.operator === "=") {
      const writtenPath: string[] = [];
      let root = target;
      while (root?.type === "MemberExpression") {
        const key = root.computed ? root.property?.value : root.property?.name;
        if (key === undefined) break;
        writtenPath.unshift(String(key));
        root = unwrapExpression(root.object);
      }
      const aliases = new Set<AnyNode>();
      while (root?.type === "Identifier") {
        const alias = resolveLocalBinding(root, root.name, parents);
        if (alias === binding) {
          if (hasPriorAliasWrite(write, binding, owner, parents, root)) return;
          break;
        }
        if (
          alias?.type !== "VariableDeclarator" ||
          alias.id.type !== "Identifier" ||
          aliases.has(alias) ||
          alias.start >= write.start ||
          !writeDominatesReference(alias, write, owner, parents) ||
          hasPriorAliasWrite(root, alias, owner, parents, alias, false)
        )
          return;
        aliases.add(alias);
        root = unwrapExpression(alias.init);
      }
      replacesMember =
        root?.type === "Identifier" &&
        resolveLocalBinding(root, root.name, parents) === binding &&
        writtenPath.length > 0 &&
        writtenPath.every((key, index) => storedPath[index] === key);
    }
    if (
      ((patternBinds(target, name) && resolveLocalBinding(write, name, parents) === binding) ||
        replacesMember) &&
      (!requireDominance || writeDominatesReference(write, reference, owner, parents))
    )
      reassigned = true;
  });
  return reassigned;
}

function writeDominatesReference(
  write: AnyNode,
  reference: AnyNode,
  owner: AnyNode,
  parents: WeakMap<AnyNode, AnyNode>,
): boolean {
  const referenceAncestors = new Set<AnyNode>();
  for (let node = reference; node && node !== owner; node = parents.get(node))
    referenceAncestors.add(node);
  for (let node = write; node && node !== owner; node = parents.get(node)) {
    const parent = parents.get(node);
    if (referenceAncestors.has(node)) return true;
    if (parent?.type === "IfStatement" || parent?.type === "ConditionalExpression") {
      if (node !== parent.test && !referenceAncestors.has(node)) {
        const test = unwrapExpression(parent.test);
        if (test?.type !== "Literal" || expressionBranchIsInactive(parent, node)) return false;
      }
    }
    if (
      [
        "SwitchCase",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "WhileStatement",
        "DoWhileStatement",
        "CatchClause",
        "TryStatement",
      ].includes(parent?.type)
    )
      return false;
    if (parent?.type === "LogicalExpression" && parent.right === node) return false;
  }
  return true;
}

function getScriptParents(ctx: RuleContext): WeakMap<AnyNode, AnyNode> {
  const key = `nuxt:script-parents:${ctx.file.relativePath}:${ctx.file.hash}`;
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
  let expression = fn;
  while (parents.get(expression)?.type === "Property") {
    const property = parents.get(expression);
    const object = parents.get(property);
    if (property.value !== expression || object?.type !== "ObjectExpression") break;
    expression = object;
  }
  const parent = parents.get(expression);
  if (
    parent?.type === "AssignmentExpression" &&
    parent.operator === "=" &&
    parent.left.type === "Identifier"
  )
    return resolveLocalBinding(parent, parent.left.name, parents) ?? fn;
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
