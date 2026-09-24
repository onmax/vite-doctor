import { isBigint, isBoolean, isNumber, isRecord, isString } from "./value-schema.js";
import type { DoctorHelpers } from "../primitives.js";
import { isAstNode, isSourceOffset, stringLiteralValue } from "./ast-node.js";
import { getNodeVisitorKeys } from "./visitor-keys.js";

export function createHelpers(): DoctorHelpers {
  return {
    rangeFromOffsets(file, source, start, end = start) {
      const prefix = source.slice(0, start);
      const lines = prefix.split(/\r?\n/);
      return { start, end, line: lines.length, column: lines.at(-1)!.length + 1 };
    },
    isInSetupLikeContext() {
      return false;
    },
    isClientOnlyExecutionContext(node, source) {
      return isClientOnlyExecutionContext(node, source);
    },
    isTypeOnlyContext(node) {
      return isTypeOnlyContext(node);
    },
    hasLocalBindingBefore(node, source) {
      return hasLocalBindingBefore(node, source);
    },
    isTypeofOperand(node) {
      return isTypeofOperand(node);
    },
    getNodeName(node) {
      return getNodeName(node);
    },
    getCalleeName(node) {
      return getCalleeName(node);
    },
    isCall(node, name) {
      return (
        isAstNode(node) && node.type === "CallExpression" && (!name || getCalleeName(node) === name)
      );
    },
    report(ctx, node, diagnostic, metadata) {
      ctx.report(diagnostic, {
        ...metadata,
        file: metadata.file ?? ctx.file.path,
        range: metadata.range ?? (node ? ctx.range(node) : undefined),
      });
    },
    hasVueDirective(node, name, argument) {
      return templateAttributes(node).some((attr) => {
        const key = field(attr, "key");
        return (
          field(attr, "directive") === true &&
          field(field(key, "name"), "name") === name &&
          (!argument || field(field(key, "argument"), "name") === argument)
        );
      });
    },
    hasVueAttribute(node, name) {
      return templateAttributes(node).some(
        (attr) => field(attr, "directive") !== true && field(field(attr, "key"), "name") === name,
      );
    },
    getStaticVueAttributeValue(node, name) {
      const attr = templateAttributes(node).find(
        (item) => field(item, "directive") !== true && field(field(item, "key"), "name") === name,
      );
      const value = field(field(attr, "value"), "value");
      return isString(value) ? value : null;
    },
    isNuxtServerFile(relativePath) {
      return relativePath.startsWith("server/") || relativePath.startsWith("app/server/");
    },
    isLikelyEventHandler(text, offset) {
      const before = text.slice(Math.max(0, offset - 180), offset);
      return /function\s+on[A-Z]\w+|const\s+on[A-Z]\w+\s*=|@click|v-on:click|addEventListener|onMounted\s*\(/.test(
        before,
      );
    },
  };
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function templateAttributes(node: unknown): unknown[] {
  const attributes = field(field(node, "startTag"), "attributes");
  return Array.isArray(attributes) ? attributes : [];
}

function nodeStart(node: unknown): number {
  const start = field(node, "start");
  return isSourceOffset(start) ? start : 0;
}

function nodeEnd(node: unknown): number {
  const end = field(node, "end");
  return isSourceOffset(end) ? end : 0;
}

const CLIENT_LIFECYCLE_CALLEES = new Set([
  "onMounted",
  "onBeforeMount",
  "onUnmounted",
  "onBeforeUnmount",
  "onNuxtReady",
  "onPrehydrate",
]);

const CLIENT_EVENT_CALLEES = new Set([
  "addEventListener",
  "window.addEventListener",
  "document.addEventListener",
  "useEventListener",
  "onKeyDown",
  "onKeyUp",
  "onKeyStroke",
  "onClickOutside",
  "onLongPress",
  "usePointerSwipe",
  "useSwipe",
  "useIntersectionObserver",
  "useResizeObserver",
]);

const DEFERRED_CALLBACK_CALLEES = new Set(["watch", "watchPostEffect"]);
const TIMER_CALLBACK_CALLEES = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
]);

function isClientOnlyExecutionContext(
  node: unknown,
  source: string,
  seenCallChain = new Set<string>(),
): boolean {
  const parents = getDoctorParents(node);
  if (parents.some((parent) => isClientGuardAncestor(parent, node, source))) return true;
  if (parents.some((parent) => isShortCircuitedByClientGuard(parent, node, source))) return true;
  if (
    parents.some((parent) => {
      const callee = getCalleeName(parent);
      return (
        !!callee &&
        (CLIENT_LIFECYCLE_CALLEES.has(callee) ||
          CLIENT_EVENT_CALLEES.has(callee) ||
          callee.endsWith(".addEventListener"))
      );
    })
  )
    return true;

  const functionAncestors = parents.filter((parent) => isFunctionLike(parent));
  if (!functionAncestors.length) return false;

  return functionAncestors.some((functionAncestor) => {
    if (isClientOnlyCallback(functionAncestor, source)) return true;
    if (isDeferredCallback(functionAncestor)) return true;
    if (isComputedSetter(functionAncestor)) return true;
    if (isClientOnlyObjectCallback(functionAncestor)) return true;
    const propertyName = getObjectPropertyKeyName(functionAncestor);
    if (propertyName && /^on[A-Z]/.test(propertyName)) return true;
    const name = getFunctionLikeName(functionAncestor);
    return (
      !!name &&
      (isTemplateEventHandlerReference(source, name) ||
        isReturnedComposableFunction(functionAncestor) ||
        isOnlyCalledFromClientOnlyContext(
          name,
          functionAncestor,
          parents.at(-1),
          source,
          seenCallChain,
        ))
    );
  });
}

function getDoctorParents(node: unknown): any[] {
  const parents = [];
  const seen = new Set<unknown>();
  let current = isAstNode(node) ? node.__doctorParent : undefined;
  while (isAstNode(current) && !seen.has(current)) {
    seen.add(current);
    parents.push(current);
    current = current.__doctorParent;
  }
  return parents;
}

function isClientGuardAncestor(parent: unknown, node: unknown, source: string): boolean {
  if (
    !isAstNode(parent) ||
    (parent.type !== "IfStatement" && parent.type !== "ConditionalExpression")
  )
    return false;
  const consequent = parent.consequent;
  if (
    node !== consequent &&
    !isDescendantOf(isAstNode(node) ? node.__doctorParent : undefined, consequent)
  )
    return false;
  return (
    isClientGuardText(source.slice(nodeStart(parent.test), nodeEnd(parent.test))) ||
    isClientGuardText(
      source.slice(
        nodeStart(parent),
        isAstNode(consequent) ? nodeStart(consequent) : nodeEnd(parent),
      ),
    )
  );
}

function isShortCircuitedByClientGuard(parent: unknown, node: unknown, source: string): boolean {
  if (!isAstNode(parent) || parent.type !== "LogicalExpression" || parent.operator !== "&&")
    return false;
  if (!isDescendantOf(isAstNode(node) ? node.__doctorParent : undefined, parent.right))
    return false;
  return isClientGuardText(source.slice(nodeStart(parent.left), nodeEnd(parent.left)));
}

function isDescendantOf(node: unknown, ancestor: unknown): boolean {
  let current = node;
  while (isAstNode(current)) {
    if (current === ancestor) return true;
    current = current.__doctorParent;
  }
  return false;
}

function isClientGuardText(text: string): boolean {
  return (
    /\b(import\.meta\.client|process\.client)\b|(?:^|[^\w$])(isBrowser|isClient)(?:\(\)|[^\w$]|$)/.test(
      text,
    ) ||
    /typeof\s+(window|document|localStorage|sessionStorage|navigator)\s*!==?\s*["']undefined["']/.test(
      text,
    )
  );
}

function isFunctionLike(node: unknown): boolean {
  return (
    isAstNode(node) &&
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
  );
}

function isClientOnlyCallback(functionNode: unknown, source: string): boolean {
  const parent = isAstNode(functionNode) ? functionNode.__doctorParent : undefined;
  if (!isAstNode(parent) || parent.type !== "CallExpression") return false;
  const callee = getCalleeName(parent);
  if (!callee) return false;
  if (CLIENT_LIFECYCLE_CALLEES.has(callee) || CLIENT_EVENT_CALLEES.has(callee)) return true;
  if (callee.endsWith(".addEventListener")) return true;
  if (isNuxtClientHookCallback(functionNode, parent, source)) return true;

  const start = isSourceOffset(parent.start) ? parent.start : 0;
  const before = source.slice(Math.max(0, start - 80), start);
  return /@[\w:-]+\s*=|v-on:[\w:-]+\s*=/.test(before);
}

function isNuxtClientHookCallback(functionNode: unknown, call: unknown, source: string): boolean {
  if (!isAstNode(call) || !Array.isArray(call.arguments)) return false;
  const callee = getCalleeName(call);
  if (!callee?.endsWith(".hook") && !callee?.endsWith(".hookOnce")) return false;
  if (call.arguments[1] !== functionNode) return false;
  const first = call.arguments[0];
  const hookName =
    stringLiteralValue(first) ??
    source.slice(nodeStart(first), nodeEnd(first)).replace(/^['"]|['"]$/g, "");
  return /^(app:mounted|page:loading:end|page:finish|page:transition:finish)$/.test(hookName);
}

function isComputedSetter(functionNode: unknown): boolean {
  const property = isAstNode(functionNode) ? functionNode.__doctorParent : undefined;
  if (!isAstNode(property) || property.type !== "Property") return false;
  if (getNodeName(property.key) !== "set") return false;
  const objectExpression = property.__doctorParent;
  const call = isAstNode(objectExpression) ? objectExpression.__doctorParent : undefined;
  return (
    isAstNode(objectExpression) &&
    objectExpression.type === "ObjectExpression" &&
    getCalleeName(call) === "computed"
  );
}

function isClientOnlyObjectCallback(functionNode: unknown): boolean {
  const property = isAstNode(functionNode) ? functionNode.__doctorParent : undefined;
  if (
    !isAstNode(property) ||
    property.type !== "Property" ||
    getNodeName(property.key) !== "handler"
  )
    return false;
  return getDoctorParents(property).some((parent) => getCalleeName(parent) === "defineShortcuts");
}

function isDeferredCallback(functionNode: unknown): boolean {
  const parent = isAstNode(functionNode) ? functionNode.__doctorParent : undefined;
  if (!isAstNode(parent) || parent.type !== "CallExpression") return false;
  const callee = getCalleeName(parent);
  return !!callee && DEFERRED_CALLBACK_CALLEES.has(callee);
}

function isReturnedComposableFunction(functionNode: unknown): boolean {
  const name = getFunctionLikeName(functionNode);
  if (!name) return false;
  const outer = getDoctorParents(functionNode).find((parent) => isFunctionLike(parent));
  const outerName = getFunctionLikeName(outer);
  if (!outerName?.startsWith("use")) return false;
  if (
    getDoctorParents(functionNode).some((parent) => {
      return (
        parent?.type === "ReturnStatement" ||
        (parent?.type === "Property" &&
          (getNodeName(parent.key) === name || parent.value === functionNode))
      );
    })
  )
    return true;

  let returned = false;
  walkAst(outer, (node) => {
    if (!isAstNode(node) || node.type !== "ReturnStatement") return;
    const argument = node.argument;
    if (
      !isAstNode(argument) ||
      argument.type !== "ObjectExpression" ||
      !Array.isArray(argument.properties)
    )
      return;
    returned ||= argument.properties.some(
      (property) =>
        isAstNode(property) &&
        property.type === "Property" &&
        (getNodeName(property.key) === name || getNodeName(property.value) === name),
    );
  });
  return returned;
}

function isOnlyCalledFromClientOnlyContext(
  name: string,
  declaration: unknown,
  root: unknown,
  source: string,
  seen = new Set<string>(),
): boolean {
  return isOnlyCalledFromClientOnlyContextInner(name, declaration, root, source, seen);
}

function isOnlyCalledFromClientOnlyContextInner(
  name: string,
  declaration: unknown,
  root: unknown,
  source: string,
  seen: Set<string>,
): boolean {
  if (!isAstNode(root)) return false;
  if (seen.has(name)) return false;
  seen.add(name);
  const declarationNames = collectDeclarations(root);
  const declarationRange = getFunctionDeclarationRange(declaration);
  const calls: unknown[] = [];
  walkAst(root, (node) => {
    if (!isAstNode(node)) return;
    if (node.type === "CallExpression" && getCalleeName(node) === name) calls.push(node);
    if (
      node.type === "Identifier" &&
      node.name === name &&
      !isInsideDeclaration(node, declaration) &&
      !isInsideRange(node, declarationRange) &&
      !declarationNames.has(name)
    )
      calls.push(node);
  });
  const externalCalls = calls.filter(
    (call) => !isInsideDeclaration(call, declaration) && !isInsideRange(call, declarationRange),
  );
  if (!externalCalls.length) return false;
  return externalCalls.every((call) => {
    if (isClientOnlyExecutionContext(call, source, seen)) return true;
    const parent = isAstNode(call) ? call.__doctorParent : undefined;
    const callee =
      isAstNode(parent) && parent.type === "CallExpression" ? getCalleeName(parent) : null;
    if (
      callee &&
      TIMER_CALLBACK_CALLEES.has(callee) &&
      isClientOnlyExecutionContext(parent, source, seen)
    )
      return true;
    const caller = getDoctorParents(call).find((parent) => isFunctionLike(parent));
    const callerName = getFunctionLikeName(caller);
    return (
      !!callerName && isOnlyCalledFromClientOnlyContextInner(callerName, caller, root, source, seen)
    );
  });
}

function collectDeclarations(root: unknown): Set<string> {
  const names = new Set<string>();
  walkAst(root, (node) => {
    const name = getDeclaredName(node);
    if (name) names.add(name);
  });
  return names;
}

function getDeclaredName(node: unknown): string | null {
  if (!isAstNode(node)) return null;
  if (node.type === "FunctionDeclaration" || node.type === "VariableDeclarator")
    return getNodeName(node.id);
  if (node.type === "Identifier") {
    const parent = node.__doctorParent;
    if (
      isAstNode(parent) &&
      (parent.type === "FunctionDeclaration" || parent.type === "VariableDeclarator") &&
      parent.id === node
    )
      return getNodeName(node);
  }
  return null;
}

function isInsideDeclaration(node: unknown, declaration: unknown): boolean {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (current === declaration) return true;
    if (current.__doctorParent === declaration) return true;
    current = current.__doctorParent;
  }
  return false;
}

function getFunctionDeclarationRange(declaration: unknown): { start: number; end: number } | null {
  if (!isAstNode(declaration)) return null;
  if (isSourceOffset(declaration.start) && isSourceOffset(declaration.end))
    return { start: declaration.start, end: declaration.end };
  const parent = declaration.__doctorParent;
  if (isAstNode(parent) && parent.type === "VariableDeclarator") {
    const statement = parent.__doctorParent;
    if (isAstNode(statement) && isSourceOffset(statement.start) && isSourceOffset(statement.end))
      return { start: statement.start, end: statement.end };
  }
  return null;
}

function isInsideRange(node: unknown, range: { start: number; end: number } | null): boolean {
  return (
    !!range &&
    isAstNode(node) &&
    isSourceOffset(node.start) &&
    node.start >= range.start &&
    node.start <= range.end
  );
}

function walkAst(node: unknown, visit: (node: unknown) => void) {
  const stack = [node];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const current = stack.pop();
    if (!isAstNode(current) || seen.has(current)) continue;
    seen.add(current);
    visit(current);
    const keys = getNodeVisitorKeys(current);
    for (let keyIndex = keys.length - 1; keyIndex >= 0; keyIndex--) {
      const value = current[keys[keyIndex]];
      if (Array.isArray(value)) {
        for (let childIndex = value.length - 1; childIndex >= 0; childIndex--) {
          stack.push(value[childIndex]);
        }
      } else if (isAstNode(value)) {
        stack.push(value);
      }
    }
  }
}

function getFunctionLikeName(functionNode: unknown): string | null {
  if (!isAstNode(functionNode)) return null;
  if (functionNode.type === "FunctionDeclaration" && isAstNode(functionNode.id)) {
    if (functionNode.id.type === "Identifier" && isString(functionNode.id.name))
      return functionNode.id.name;
  }
  const parent = functionNode.__doctorParent;
  if (!isAstNode(parent)) return null;
  if (parent.type === "VariableDeclarator" && isAstNode(parent.id)) {
    if (parent.id.type === "Identifier" && isString(parent.id.name)) return parent.id.name;
  }
  if (parent.type === "Property" && isAstNode(parent.key)) {
    if (parent.key.type === "Identifier" && isString(parent.key.name)) return parent.key.name;
    if (parent.key.type === "Literal") return stringLiteralValue(parent.key);
  }
  return null;
}

function getObjectPropertyKeyName(functionNode: unknown): string | null {
  const parent = isAstNode(functionNode) ? functionNode.__doctorParent : undefined;
  return isAstNode(parent) && parent.type === "Property" ? getNodeName(parent.key) : null;
}

function isTemplateEventHandlerReference(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:@|v-on:)[\\w:-]+\\s*=\\s*["'][^"']*\\b${escaped}\\b`).test(source);
}

function isTypeOnlyContext(node: unknown): boolean {
  return getDoctorParents(node).some((parent) => {
    if (!isAstNode(parent)) return false;
    const type = parent.type;
    return (
      type.startsWith("TS") ||
      type === "TypeAnnotation" ||
      type === "TypeAlias" ||
      type === "InterfaceDeclaration"
    );
  });
}

function hasLocalBindingBefore(node: unknown, source: string): boolean {
  if (!isAstNode(node) || node.type !== "Identifier" || !isString(node.name)) return false;
  const parent = node.__doctorParent;
  if (
    isAstNode(parent) &&
    (parent.type === "VariableDeclarator" || parent.type === "FunctionDeclaration") &&
    parent.id === node
  )
    return true;
  if (isAstNode(parent) && parent.type === "Property" && parent.key === node && !parent.computed)
    return true;

  const name = node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = source.slice(0, nodeStart(node));
  return new RegExp(
    String.raw`(?:\b(?:const|let|var)\s+${name}\b|[,(]\s*${name}\s*(?::[^)=]+)?=>|\(\s*${name}\s*(?::[^)]*)?\)\s*=>|function[^(]*\([^)]*\b${name}\b|[,(]\s*\{[^)]*\b${name}\b[^)]*\}\s*(?::[^)=]+)?=>|function[^(]*\([^)]*\{[^)]*\b${name}\b)`,
  ).test(before);
}

function isTypeofOperand(node: unknown): boolean {
  const parent = isAstNode(node) ? node.__doctorParent : undefined;
  return isAstNode(parent) && parent.type === "UnaryExpression" && parent.operator === "typeof";
}

function getNodeName(node: unknown): string | null {
  if (!isAstNode(node)) return null;
  if (node.type === "Identifier") return isString(node.name) ? node.name : null;
  if (node.type === "Literal") {
    const value = node.value;
    return isString(value) || isNumber(value) || isBoolean(value) || isBigint(value)
      ? String(value)
      : null;
  }
  if (node.type === "StaticMemberExpression" || node.type === "MemberExpression") {
    const object = getNodeName(node.object);
    const property = getNodeName(node.property);
    return object && property ? `${object}.${property}` : (object ?? property);
  }
  return null;
}

function getCalleeName(node: unknown): string | null {
  return getNodeName(node instanceof Object ? Reflect.get(node, "callee") : undefined);
}
