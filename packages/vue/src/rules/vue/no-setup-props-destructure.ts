import { AnyNode, createRule, report } from "./shared.js";

export const noSetupPropsDestructure = createRule({
  meta: {
    id: "vue/reactivity/no-setup-props-destructure",
    title: "Do not destructure setup props",
    description: "Classic setup(props) props lose reactivity when destructured directly.",
    why: "The props proxy is reactive, but local destructured bindings are snapshots.",
    recommendedReplacement:
      "Use props.foo, toRefs(props), or <script setup> reactive props destructuring.",
    category: "reactivity",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/api/sfc-script-setup.html#reactive-props-destructure",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "VariableDeclarator" || node.id?.type !== "ObjectPattern") return;
        if (node.init?.name !== "props") return;
        if (!/setup\s*\(\s*props\b/.test(ctx.file.text.slice(0, node.start))) return;
        report(
          ctx,
          node,
          "vue/reactivity/no-setup-props-destructure",
          "error",
          "reactivity",
          "Destructuring setup(props) creates non-reactive local values.",
          "Use props.foo, toRefs(props), or migrate to <script setup> reactive props destructuring.",
        );
      },
    };
  },
});
