import { parseForESLint } from "@typescript-eslint/parser";
import { createVueScriptForParsing } from "../../../../core/internal/sfc.js";
import { AnyNode, createRule, report } from "./shared.js";
import type { RuleContext } from "../../../../core/index.js";

const FACTORIES = new Map<string, ReactiveKind>([
  ["computed", "ref"],
  ["customRef", "ref"],
  ["ref", "ref"],
  ["toRef", "ref"],
  ["shallowRef", "shallow-ref"],
  ["reactive", "reactive"],
  ["shallowReactive", "shallow-reactive"],
]);
const MUTATING_METHODS = new Set(["push", "splice"]);

export const noMutationInOnUpdated = createRule({
  meta: {
    id: "vue/lifecycle/no-mutation-in-onupdated",
    title: "Do not mutate state in onUpdated",
    category: "lifecycle",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/api/composition-api-lifecycle.html#onupdated",
    requires: { script: true, vue: true },
    prefilter: { calls: ["onUpdated"] },
  },
  create(ctx) {
    let bindings: ReactiveBindings | undefined;
    return {
      CallExpression(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "onUpdated")) return;
        const callback = node.arguments?.[0];
        if (!isFunctionLike(callback)) return;
        bindings ??= reactiveBindings(ctx);
        if (!hasReactiveMutation(callback, bindings)) return;
        report(
          ctx,
          node,
          "vue/lifecycle/no-mutation-in-onupdated",
          "error",
          "lifecycle",
          "Mutating reactive state in onUpdated can create update loops.",
          "Move the reactive mutation to the event or state transition that owns it, or keep update bookkeeping in a non-reactive local.",
        );
      },
    };
  },
});

interface ReactiveBindings {
  byReference: Map<string, ReactiveKind>;
}

type ReactiveKind = "ref" | "reactive" | "shallow-ref" | "shallow-reactive";
type BindingKind =
  | ReactiveKind
  | `${ReactiveKind}-factory`
  | "namespace-vue"
  | "refs-factory"
  | "model-factory";

function factoryBindingKind(name: string): BindingKind | undefined {
  if (name === "toRefs") return "refs-factory";
  if (name === "useModel") return "model-factory";
  const kind = FACTORIES.get(name);
  return kind ? `${kind}-factory` : undefined;
}

function reactiveKind(kind: BindingKind | undefined): ReactiveKind | undefined {
  if (
    kind === "ref" ||
    kind === "reactive" ||
    kind === "shallow-ref" ||
    kind === "shallow-reactive"
  )
    return kind;
  return undefined;
}

function reactiveBindings(ctx: RuleContext): ReactiveBindings {
  const parsedVueScript = ctx.file.sfc
    ? createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text)
    : undefined;
  const source = parsedVueScript?.text ?? ctx.file.text;
  try {
    const parsed = parseForESLint(source, {
      range: true,
      sourceType: "module",
      ecmaVersion: "latest",
      ecmaFeatures: {
        jsx:
          parsedVueScript?.lang === "jsx" ||
          parsedVueScript?.lang === "tsx" ||
          /\.[jt]sx$/.test(ctx.file.relativePath),
      },
    });
    const variables = parsed.scopeManager.scopes.flatMap((scope) => scope.variables);
    const kinds = new Map<object, BindingKind>();
    for (const variable of variables) {
      const kind = importedFactoryKind(variable);
      if (kind) kinds.set(variable, kind);
    }

    const references = new Map<string, any>();
    for (const scope of parsed.scopeManager.scopes) {
      for (const reference of scope.references) {
        const range = reference.identifier.range;
        if (range) references.set(rangeKey(range[0], range[1]), reference);
      }
    }
    for (const variable of variables) {
      const kind = variableKind(
        variable,
        references,
        kinds,
        !!ctx.file.sfc?.blockHashes.scriptSetup,
      );
      if (kind) kinds.set(variable, kind);
    }

    const byReference = new Map<string, ReactiveKind>();
    for (const reference of references.values()) {
      const kind = reactiveKind(referenceKind(reference, kinds));
      if (kind) {
        const range = reference.identifier.range;
        byReference.set(rangeKey(range[0], range[1]), kind);
      }
    }
    return { byReference };
  } catch {
    return { byReference: new Map() };
  }
}

function importedFactoryKind(variable: any): BindingKind | undefined {
  for (const definition of variable.defs ?? []) {
    if (definition.type !== "ImportBinding") continue;
    const source = definition.parent?.source?.value;
    if (source !== "vue") continue;
    if (definition.node?.type === "ImportNamespaceSpecifier") return "namespace-vue";
    const imported = definition.node?.imported?.name;
    return factoryBindingKind(imported);
  }
  return undefined;
}

function variableKind(
  variable: any,
  references: Map<string, any>,
  kinds: Map<object, BindingKind>,
  scriptSetup: boolean,
) {
  for (const definition of variable.defs ?? []) {
    if (definition.type !== "Variable") continue;
    const init = unwrapExpression(definition.node?.init);
    if (init?.type !== "CallExpression") continue;
    const pattern = definition.node.id;
    const callee = init.callee;
    const reference = references.get(rangeKey(callee.range?.[0], callee.range?.[1]));
    if (
      scriptSetup &&
      callee.type === "Identifier" &&
      callee.name === "defineModel" &&
      !reference?.resolved
    ) {
      if (
        pattern.type === "Identifier" ||
        (pattern.type === "ArrayPattern" && isDirectBinding(pattern.elements[0], definition.name))
      )
        return "ref";
      continue;
    }
    const initKind = factoryKind(callee, references, kinds);
    if (initKind === "model-factory") {
      if (
        pattern.type === "Identifier" ||
        (pattern.type === "ArrayPattern" && isDirectBinding(pattern.elements[0], definition.name))
      )
        return "ref";
      continue;
    }
    if (initKind === "refs-factory") {
      if (
        (pattern.type === "ObjectPattern" &&
          pattern.properties.some(
            (property: AnyNode) =>
              property.type === "Property" && isDirectBinding(property.value, definition.name),
          )) ||
        (pattern.type === "ArrayPattern" &&
          pattern.elements.some((element: AnyNode) => isDirectBinding(element, definition.name)))
      )
        return "ref";
      continue;
    }
    if (pattern.type !== "Identifier") continue;
    if (initKind?.endsWith("-factory")) {
      return reactiveKind(initKind.slice(0, -"-factory".length) as BindingKind);
    }
  }
  return undefined;
}

function isDirectBinding(node: AnyNode, name: AnyNode) {
  return node === name || (node?.type === "AssignmentPattern" && node.left === name);
}

function factoryKind(node: any, references: Map<string, any>, kinds: Map<object, BindingKind>) {
  if (node?.type === "Identifier") {
    const reference = references.get(rangeKey(node.range?.[0], node.range?.[1]));
    const kind = referenceKind(reference, kinds);
    if (kind?.endsWith("-factory")) return kind;
    if (!reference?.resolved) return factoryBindingKind(node.name);
    return undefined;
  }
  if (isMemberExpression(node) && node.object?.type === "Identifier") {
    const reference = references.get(rangeKey(node.object.range?.[0], node.object.range?.[1]));
    if (referenceKind(reference, kinds) === "namespace-vue") {
      const member = memberName(node);
      if (member) return factoryBindingKind(member);
    }
  }
  return undefined;
}

function referenceKind(reference: any, kinds: Map<object, BindingKind>): BindingKind | undefined {
  if (reference?.resolved) return kinds.get(reference.resolved);
  return factoryBindingKind(reference?.identifier?.name);
}

function rangeKey(start: number | undefined, end: number | undefined) {
  return `${start ?? -1}:${end ?? -1}`;
}

function hasReactiveMutation(callback: AnyNode, bindings: ReactiveBindings) {
  let found = false;
  walkCallbackScope(callback.body ?? callback, (node) => {
    if (found) return;
    if (node.type === "AssignmentExpression") {
      found = isReactiveExpression(node.left, bindings);
      return;
    }
    if (node.type === "UpdateExpression") {
      found = isReactiveExpression(node.argument, bindings);
      return;
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (!isMemberExpression(callee)) return;
      const method = memberName(callee);
      found =
        !!method && MUTATING_METHODS.has(method) && isReactiveCollection(callee.object, bindings);
    }
  });
  return found;
}

function isReactiveExpression(node: AnyNode, bindings: ReactiveBindings): boolean {
  if (!isMemberExpression(node)) return false;
  const root = rootIdentifier(node);
  if (!root?.start && root?.start !== 0) return false;
  const kind = bindings.byReference.get(rangeKey(root.start, root.end));
  if (kind === "reactive") return true;
  if (kind === "shallow-reactive") return node.object?.type === "Identifier";
  if (kind !== "ref" && kind !== "shallow-ref") return false;
  if (kind === "shallow-ref" && node.object?.type !== "Identifier") return false;
  let current = node;
  while (isMemberExpression(current.object)) current = current.object;
  return memberName(current) === "value";
}

function isReactiveCollection(node: AnyNode, bindings: ReactiveBindings): boolean {
  const root = rootIdentifier(node);
  if (!root) return false;
  const kind = bindings.byReference.get(rangeKey(root.start, root.end));
  if (node.type === "Identifier") return kind === "reactive" || kind === "shallow-reactive";
  if (kind === "shallow-ref" || kind === "shallow-reactive") return false;
  return isReactiveExpression(node, bindings);
}

function unwrapExpression(node: AnyNode): AnyNode {
  while (
    ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(
      node?.type,
    )
  ) {
    node = node.expression;
  }
  return node;
}

function rootIdentifier(node: AnyNode): AnyNode {
  let current = node;
  while (isMemberExpression(current)) current = current.object;
  return current?.type === "Identifier" ? current : null;
}

function memberName(node: AnyNode): string | null {
  const property = node?.property;
  if (!node.computed && property?.type === "Identifier") return property.name;
  if (property?.type === "Literal" || property?.type === "StringLiteral")
    return String(property.value);
  return null;
}

function isMemberExpression(node: AnyNode) {
  return node?.type === "MemberExpression" || node?.type === "StaticMemberExpression";
}

function walkCallbackScope(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkCallbackScope(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  if (isFunctionLike(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkCallbackScope(child, visit);
    } else if (value && typeof value === "object") {
      walkCallbackScope(value, visit);
    }
  }
}

function isFunctionLike(node: AnyNode) {
  return ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(
    node?.type,
  );
}
