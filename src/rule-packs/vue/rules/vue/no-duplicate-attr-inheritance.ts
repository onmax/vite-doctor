import { createEslintVueRule, offsetFromLineColumn } from "./shared.js";

export const noDuplicateAttrInheritance = createEslintVueRule({
  doctorId: "vue/attrs/no-duplicate-attr-inheritance",
  eslintId: "vue/no-duplicate-attr-inheritance",
  // eslint-plugin-vue skips multi-root templates by default (`checkMultiRootNodes: false`); they do
  // not inherit attrs, so binding `$attrs` there is required. Vue merges fallthrough attrs into a
  // root that already binds `$attrs` without doubling handlers, so only inner elements are defects.
  keepMessage: (message, ctx) => {
    const offset = offsetFromLineColumn(ctx.file.text, message.line, message.column);
    const roots = ctx.file.templateAst?.children ?? [];
    return !roots.some(
      (root) =>
        root.type === 1 &&
        root.props.some((prop) => prop.loc.start.offset <= offset && offset < prop.loc.end.offset),
    );
  },
  meta: {
    id: "vue/attrs/no-duplicate-attr-inheritance",
    title: "Disable inheritAttrs when binding $attrs",
    category: "attrs",
    severity: "warn",
    docsUrl: "https://vuejs.org/guide/components/attrs.html#disabling-attribute-inheritance",
    requires: { template: true, vue: true },
  },
});
