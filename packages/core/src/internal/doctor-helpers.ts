import { visitorKeys } from "oxc-parser";
import type { DoctorHelpers } from "../primitives.js";

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
      return (node as any)?.type === "CallExpression" && (!name || getCalleeName(node) === name);
    },
    report(ctx, node, diagnostic) {
      ctx.report({
        ...diagnostic,
        file: diagnostic.file ?? ctx.file.path,
        range: diagnostic.range ?? (node ? ctx.range(node) : undefined),
      });
    },
    hasVueDirective(node, name, argument) {
      return ((node as any)?.startTag?.attributes ?? []).some(
        (attr: any) =>
          attr.directive &&
          attr.key?.name?.name === name &&
          (!argument || attr.key?.argument?.name === argument),
      );
    },
    hasVueAttribute(node, name) {
      return ((node as any)?.startTag?.attributes ?? []).some(
        (attr: any) => !attr.directive && attr.key?.name === name,
      );
    },
    getStaticVueAttributeValue(node, name) {
      const attr = ((node as any)?.startTag?.attributes ?? []).find(
        (item: any) => !item.directive && item.key?.name === name,
      );
      return attr?.value?.value ?? null;
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
  let current = (node as any)?.__doctorParent;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    parents.push(current);
    current = current.__doctorParent;
  }
  return parents;
}

function isClientGuardAncestor(parent: unknown, node: unknown, source: string): boolean {
  const value = parent as any;
  if (value?.type !== "IfStatement" && value?.type !== "ConditionalExpression") return false;
  if (
    (node as any) !== value.consequent &&
    !isDescendantOf((node as any)?.__doctorParent, value.consequent)
  )
    return false;
  return (
    isClientGuardText(source.slice(value.test?.start ?? 0, value.test?.end ?? 0)) ||
    isClientGuardText(source.slice(value.start ?? 0, value.consequent?.start ?? value.end ?? 0))
  );
}

function isShortCircuitedByClientGuard(parent: unknown, node: unknown, source: string): boolean {
  const value = parent as any;
  if (value?.type !== "LogicalExpression" || value.operator !== "&&") return false;
  if (!isDescendantOf((node as any)?.__doctorParent, value.right)) return false;
  return isClientGuardText(source.slice(value.left?.start ?? 0, value.left?.end ?? 0));
}

function isDescendantOf(node: unknown, ancestor: unknown): boolean {
  let current = node as any;
  while (current && typeof current === "object") {
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
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    (node as any)?.type,
  );
}

function isClientOnlyCallback(functionNode: unknown, source: string): boolean {
  const parent = (functionNode as any)?.__doctorParent;
  if (!parent || parent.type !== "CallExpression") return false;
  const callee = getCalleeName(parent);
  if (!callee) return false;
  if (CLIENT_LIFECYCLE_CALLEES.has(callee) || CLIENT_EVENT_CALLEES.has(callee)) return true;
  if (callee.endsWith(".addEventListener")) return true;
  if (isNuxtClientHookCallback(functionNode, parent, source)) return true;

  const before = source.slice(Math.max(0, parent.start - 80), parent.start);
  return /@[\w:-]+\s*=|v-on:[\w:-]+\s*=/.test(before);
}

function isNuxtClientHookCallback(functionNode: unknown, call: unknown, source: string): boolean {
  const value = call as any;
  const callee = getCalleeName(value);
  if (!callee?.endsWith(".hook") && !callee?.endsWith(".hookOnce")) return false;
  if (value.arguments?.[1] !== functionNode) return false;
  const first = value.arguments?.[0];
  const hookName =
    first?.type === "Literal" && typeof first.value === "string"
      ? first.value
      : source.slice(first?.start ?? 0, first?.end ?? 0).replace(/^['"]|['"]$/g, "");
  return /^(app:mounted|page:loading:end|page:finish|page:transition:finish)$/.test(hookName);
}

function isComputedSetter(functionNode: unknown): boolean {
  const property = (functionNode as any)?.__doctorParent;
  if (property?.type !== "Property") return false;
  if ((property.key?.name ?? property.key?.value) !== "set") return false;
  const objectExpression = property.__doctorParent;
  const call = objectExpression?.__doctorParent;
  return objectExpression?.type === "ObjectExpression" && getCalleeName(call) === "computed";
}

function isClientOnlyObjectCallback(functionNode: unknown): boolean {
  const property = (functionNode as any)?.__doctorParent;
  const key = property?.key?.name ?? property?.key?.value;
  if (property?.type !== "Property" || key !== "handler") return false;
  return getDoctorParents(property).some((parent) => getCalleeName(parent) === "defineShortcuts");
}

function isDeferredCallback(functionNode: unknown): boolean {
  const parent = (functionNode as any)?.__doctorParent;
  if (!parent || parent.type !== "CallExpression") return false;
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
      const value = parent as any;
      return (
        value?.type === "ReturnStatement" ||
        (value?.type === "Property" &&
          ((value.key?.name ?? value.key?.value) === name || value.value === functionNode))
      );
    })
  )
    return true;

  let returned = false;
  walkAst(outer, (node) => {
    const value = node as any;
    if (value?.type !== "ReturnStatement" || value.argument?.type !== "ObjectExpression") return;
    returned ||= value.argument.properties?.some((property: any) => {
      return (
        property?.type === "Property" &&
        ((property.key?.name ?? property.key?.value) === name ||
          (property.value?.type === "Identifier" && property.value.name === name))
      );
    });
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
  if (!root || typeof root !== "object") return false;
  if (seen.has(name)) return false;
  seen.add(name);
  const declarationNames = collectDeclarations(root);
  const declarationRange = getFunctionDeclarationRange(declaration);
  const calls: any[] = [];
  walkAst(root, (node) => {
    const value = node as any;
    if (value?.type === "CallExpression" && getCalleeName(node) === name) calls.push(node);
    if (
      value?.type === "Identifier" &&
      value.name === name &&
      !isInsideDeclaration(value, declaration) &&
      !isInsideRange(value, declarationRange) &&
      !declarationNames.has(value.name)
    )
      calls.push(value);
  });
  const externalCalls = calls.filter(
    (call) => !isInsideDeclaration(call, declaration) && !isInsideRange(call, declarationRange),
  );
  if (!externalCalls.length) return false;
  return externalCalls.every((call) => {
    if (isClientOnlyExecutionContext(call, source, seen)) return true;
    const parent = (call as any).__doctorParent;
    const callee = parent?.type === "CallExpression" ? getCalleeName(parent) : null;
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
  const value = node as any;
  if (value?.type === "FunctionDeclaration") return value.id?.name ?? null;
  if (value?.type === "VariableDeclarator" && value.id?.type === "Identifier") return value.id.name;
  if (value?.type === "Identifier") {
    const parent = value.__doctorParent;
    if (parent?.type === "FunctionDeclaration" && parent.id === value) return value.name;
    if (parent?.type === "VariableDeclarator" && parent.id === value) return value.name;
  }
  return null;
}

function isInsideDeclaration(node: unknown, declaration: unknown): boolean {
  let current = node as any;
  while (current && typeof current === "object") {
    if (current === declaration) return true;
    if (current.__doctorParent === declaration) return true;
    current = current.__doctorParent;
  }
  return false;
}

function getFunctionDeclarationRange(declaration: unknown): { start: number; end: number } | null {
  const node = declaration as any;
  if (typeof node?.start === "number" && typeof node?.end === "number")
    return { start: node.start, end: node.end };
  const parent = node?.__doctorParent;
  if (parent?.type === "VariableDeclarator") {
    const statement = parent.__doctorParent;
    if (typeof statement?.start === "number" && typeof statement?.end === "number")
      return { start: statement.start, end: statement.end };
  }
  return null;
}

function isInsideRange(node: unknown, range: { start: number; end: number } | null): boolean {
  const value = node as any;
  return (
    !!range &&
    typeof value?.start === "number" &&
    value.start >= range.start &&
    value.start <= range.end
  );
}

function walkAst(node: unknown, visit: (node: unknown) => void) {
  const stack = [node];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const typed = current as any;
    if (!typed.type) continue;
    visit(typed);
    const keys = visitorKeys[typed.type] ?? [];
    for (let keyIndex = keys.length - 1; keyIndex >= 0; keyIndex--) {
      const value = typed[keys[keyIndex]];
      if (Array.isArray(value)) {
        for (let childIndex = value.length - 1; childIndex >= 0; childIndex--) {
          stack.push(value[childIndex]);
        }
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
}

function getFunctionLikeName(functionNode: unknown): string | null {
  const node = functionNode as any;
  if (!node || typeof node !== "object") return null;
  if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") return node.id.name;
  const parent = node.__doctorParent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier")
    return parent.id.name;
  if (
    parent?.type === "Property" &&
    (parent.key?.type === "Identifier" || parent.key?.type === "Literal")
  )
    return String(parent.key.name ?? parent.key.value);
  return null;
}

function getObjectPropertyKeyName(functionNode: unknown): string | null {
  const parent = (functionNode as any).__doctorParent;
  if (
    parent?.type === "Property" &&
    (parent.key?.type === "Identifier" || parent.key?.type === "Literal")
  )
    return String(parent.key.name ?? parent.key.value);
  return null;
}

function isTemplateEventHandlerReference(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:@|v-on:)[\\w:-]+\\s*=\\s*["'][^"']*\\b${escaped}\\b`).test(source);
}

function isTypeOnlyContext(node: unknown): boolean {
  return getDoctorParents(node).some((parent) => {
    const type = parent?.type;
    return (
      typeof type === "string" &&
      (type.startsWith("TS") ||
        type === "TypeAnnotation" ||
        type === "TypeAlias" ||
        type === "InterfaceDeclaration")
    );
  });
}

function hasLocalBindingBefore(node: unknown, source: string): boolean {
  const value = node as any;
  if (value?.type !== "Identifier" || typeof value.name !== "string") return false;
  const parent = value.__doctorParent;
  if (parent?.type === "VariableDeclarator" && parent.id === value) return true;
  if (parent?.type === "FunctionDeclaration" && parent.id === value) return true;
  if (parent?.type === "Property" && parent.key === value && !parent.computed) return true;

  const name = value.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = source.slice(0, value.start);
  return new RegExp(
    String.raw`(?:\b(?:const|let|var)\s+${name}\b|[,(]\s*${name}\s*(?::[^)=]+)?=>|\(\s*${name}\s*(?::[^)]*)?\)\s*=>|function[^(]*\([^)]*\b${name}\b|[,(]\s*\{[^)]*\b${name}\b[^)]*\}\s*(?::[^)=]+)?=>|function[^(]*\([^)]*\{[^)]*\b${name}\b)`,
  ).test(before);
}

function isTypeofOperand(node: unknown): boolean {
  const parent = (node as any)?.__doctorParent;
  return parent?.type === "UnaryExpression" && parent.operator === "typeof";
}

function getNodeName(node: unknown): string | null {
  const value = node as any;
  if (!value) return null;
  if (value.type === "Identifier") return value.name;
  if (value.type === "Literal") return String(value.value);
  if (value.type === "StaticMemberExpression" || value.type === "MemberExpression") {
    const object = getNodeName(value.object);
    const property = getNodeName(value.property);
    return object && property ? `${object}.${property}` : (object ?? property);
  }
  return null;
}

function getCalleeName(node: unknown): string | null {
  return getNodeName((node as any)?.callee);
}
