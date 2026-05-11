import { AnyNode, createRule } from "./shared.js";

interface Options {
  allowDefaultModelValue?: boolean;
}

export const preferDefineModel = createRule({
  meta: {
    id: "vue/style/prefer-define-model",
    title: "Prefer defineModel for component v-model",
    category: "style",
    severity: "warn",
    fixable: "suggestion",
    requires: { sfc: true, script: true, vue: true },
    frameworkVersions: { vue: ">=3.4" },
  },
  create(ctx) {
    const options = (ctx.options ?? {}) as Options;
    if (!ctx.file.text.includes("<script setup")) return;

    const props = new Map<string, AnyNode>();
    const emits = new Set<string>();
    let hasDefineModel = false;
    const reported = new Set<string>();

    function reportMatches() {
      if (hasDefineModel) return;
      for (const [prop, node] of props) {
        if (!emits.has(`update:${prop}`) || reported.has(prop)) continue;
        if (!options.allowDefaultModelValue && prop === "modelValue" && hasDefaultOption(node))
          continue;
        reported.add(prop);
        ctx.report({
          ruleId: "vue/style/prefer-define-model",
          severity: ctx.severity,
          category: "style",
          file: ctx.file.path,
          range: ctx.range(node),
          message: `${prop} and update:${prop} can be declared with defineModel().`,
          suggestion: prop === "modelValue" ? "Use defineModel()." : `Use defineModel('${prop}').`,
        });
      }
    }

    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "defineModel")) hasDefineModel = true;
        if (ctx.helpers.isCall(node, "defineProps")) {
          for (const item of propNamesFromDefineProps(node)) props.set(item.name, item.node);
          reportMatches();
        }
        if (ctx.helpers.isCall(node, "defineEmits")) {
          for (const event of emitNamesFromDefineEmits(node)) emits.add(event);
          reportMatches();
        }
      },
    };
  },
});

function propNamesFromDefineProps(node: AnyNode): Array<{ name: string; node: AnyNode }> {
  const arg = node.arguments?.[0];
  if (!arg) return [];
  if (arg.type === "ArrayExpression")
    return (arg.elements ?? [])
      .filter((element: AnyNode) => typeof element?.value === "string")
      .map((element: AnyNode) => ({ name: element.value, node: element }));
  if (arg.type !== "ObjectExpression") return [];
  return (arg.properties ?? [])
    .map((property: AnyNode) => ({
      name: property.key?.name ?? property.key?.value,
      node: property,
    }))
    .filter((item: { name?: string }) => typeof item.name === "string");
}

function emitNamesFromDefineEmits(node: AnyNode): string[] {
  const arg = node.arguments?.[0];
  if (!arg || arg.type !== "ArrayExpression") return [];
  return (arg.elements ?? [])
    .map((element: AnyNode) => element?.value)
    .filter((value: unknown): value is string => typeof value === "string");
}

function hasDefaultOption(node: AnyNode): boolean {
  const value = node.value;
  if (value?.type !== "ObjectExpression") return false;
  return (value.properties ?? []).some(
    (property: AnyNode) => (property.key?.name ?? property.key?.value) === "default",
  );
}
