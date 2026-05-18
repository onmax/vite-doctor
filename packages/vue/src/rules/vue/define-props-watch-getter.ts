import { AnyNode, bindingNames, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const definePropsWatchGetter = createRule({
  meta: {
    id: "vue/reactivity/defineprops-watch-getter",
    title: "Watch destructured props with a getter",
    category: "reactivity",
    severity: "error",
    fixable: "safe",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    const destructured = new Set<string>();
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type === "VariableDeclarator" &&
          node.id?.type === "ObjectPattern" &&
          ctx.helpers.isCall(node.init, "defineProps")
        ) {
          for (const property of node.id.properties ?? []) {
            for (const local of bindingNames(property.value ?? property.argument ?? property.key)) {
              destructured.add(local);
            }
          }
        }
        if (
          ctx.helpers.isCall(node, "watch") &&
          node.arguments?.[0]?.type === "Identifier" &&
          destructured.has(node.arguments[0].name)
        ) {
          const id = node.arguments[0];
          ctx.report(
            diagnostics.VUE0005.report({
              why: `watch(${id.name}, ...) passes the current prop value. Use a getter so Vue tracks the destructured prop.`,
              fix: `Use watch(() => ${id.name}, ...).`,
            }),
            {
              ruleId: "vue/reactivity/defineprops-watch-getter",
              severity: "error",
              category: "reactivity",
              file: ctx.file.path,
              range: ctx.range(id),
              fix: {
                kind: "safe",
                edits: [{ range: { start: id.start, end: id.end }, text: `() => ${id.name}` }],
              },
            },
          );
        }
      },
    };
  },
});
