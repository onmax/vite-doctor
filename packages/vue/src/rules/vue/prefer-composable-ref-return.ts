import { AnyNode, createRule, walkScriptLocal } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

interface Options {
  allowReactiveObjectReturn?: boolean;
}

export const preferComposableRefReturn = createRule({
  meta: {
    id: "vue/reactivity/prefer-composable-ref-return",
    title: "Prefer refs from reusable composables",
    category: "reactivity",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    const options = (ctx.options ?? {}) as Options;
    if (options.allowReactiveObjectReturn) return;

    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "ReturnStatement") return;
        const fn = nearestFunction(node);
        if (!fn || !isExportedUseComposable(fn)) return;
        if (isToRefsReturn(node.argument)) return;
        if (node.argument?.type !== "ObjectExpression") return;

        const reactiveBindings = reactiveStateBindings(fn);
        if (!reactiveBindings.size) return;
        const reactiveMembers = returnedReactiveMembers(node.argument, reactiveBindings);
        if (!reactiveMembers.length) return;

        ctx.report(
          diagnostics.VUE0008.report({
            why: "Reusable composables should return refs or computed refs instead of reactive-derived snapshots.",
            fix: "Return individual ref/computed values or toRefs(state) so callers can destructure safely.",
          }),
          {
            ruleId: "vue/reactivity/prefer-composable-ref-return",
            severity: ctx.severity,
            category: "reactivity",
            file: ctx.file.path,
            range: ctx.range(node.argument),
          },
        );
      },
    };
  },
});

function nearestFunction(node: AnyNode): AnyNode {
  let current = node.__doctorParent;
  while (current) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    )
      return current;
    current = current.__doctorParent;
  }
  return null;
}

function isExportedUseComposable(fn: AnyNode): boolean {
  const name = functionName(fn);
  if (!name || !/^use[A-Z0-9]/.test(name)) return false;
  let current = fn.__doctorParent;
  while (current) {
    if (current.type === "ExportNamedDeclaration" || current.type === "ExportDefaultDeclaration")
      return true;
    if (current.type === "Program") return false;
    current = current.__doctorParent;
  }
  return false;
}

function functionName(fn: AnyNode): string | null {
  if (fn.id?.name) return fn.id.name;
  const parent = fn.__doctorParent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier")
    return parent.id.name;
  return null;
}

function reactiveStateBindings(fn: AnyNode): Set<string> {
  const bindings = new Set<string>();
  walkScriptLocal(fn.body, (node) => {
    if (nearestFunction(node) !== fn) return;
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    if (node.init?.type !== "CallExpression") return;
    const name = node.init.callee?.name ?? node.init.callee?.property?.name;
    if (name === "reactive") bindings.add(node.id.name);
  });
  return bindings;
}

function returnedReactiveMembers(object: AnyNode, reactiveBindings: Set<string>): AnyNode[] {
  return (object.properties ?? [])
    .map((property: AnyNode) => property.value ?? property.argument)
    .filter(
      (value: AnyNode) =>
        value?.type === "MemberExpression" &&
        value.object?.type === "Identifier" &&
        reactiveBindings.has(value.object.name),
    );
}

function isToRefsReturn(node: AnyNode): boolean {
  if (node?.type !== "CallExpression") return false;
  const name = node.callee?.name ?? node.callee?.property?.name;
  return name === "toRefs";
}
