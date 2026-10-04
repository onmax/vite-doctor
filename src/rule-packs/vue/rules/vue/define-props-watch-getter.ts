import type { SFCDescriptor } from "@vue/compiler-sfc";
import { parseForESLint } from "@typescript-eslint/parser";
import { type RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const definePropsWatchGetter = createRule({
  meta: {
    id: "vue/reactivity/defineprops-watch-getter",
    title: "Watch destructured props with a getter",
    category: "reactivity",
    severity: "error",
    fixable: "safe",
    docsUrl: "https://vuejs.org/api/sfc-script-setup.html#reactive-props-destructure",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
    if (!descriptor?.scriptSetup) return;
    let propArguments: Set<number> | undefined;
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type === "CallExpression" &&
          node.arguments?.[0]?.type === "Identifier" &&
          (propArguments ??= propWatchArguments(ctx, descriptor)).has(node.arguments[0].start)
        ) {
          const id = node.arguments[0];
          ctx.report(
            diagnostics.VUE0005({
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

function propWatchArguments(ctx: RuleContext, descriptor: SFCDescriptor): Set<number> {
  const setup = descriptor.scriptSetup!;
  try {
    const { ast, scopeManager, visitorKeys } = parseForESLint(setup.content, {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx: ["jsx", "tsx"].includes(setup.lang ?? "") },
    });
    const references = new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference] as const),
      ),
    );
    const moduleVariables = descriptor.script
      ? parseForESLint(descriptor.script.content, {
          sourceType: "module",
        }).scopeManager.scopes.find((scope) => scope.type === "module")?.variables
      : [];
    const variableFor = (node: AnyNode) =>
      references.get(node)?.resolved ??
      moduleVariables?.find((variable) => variable.name === node.name);
    const isVueImport = (node: AnyNode, name: string, namespace = false) =>
      variableFor(node)?.defs.some((definition) => {
        if (definition.type !== "ImportBinding") return false;
        const declaration = definition.parent;
        if (
          declaration.type !== "ImportDeclaration" ||
          declaration.importKind === "type" ||
          (declaration.source.value !== "vue" &&
            !(ctx.project.framework === "nuxt" && declaration.source.value === "#imports"))
        )
          return false;
        return namespace
          ? definition.node.type === "ImportNamespaceSpecifier"
          : definition.node.type === "ImportSpecifier" &&
              definition.node.importKind !== "type" &&
              (definition.node.imported.type === "Identifier"
                ? definition.node.imported.name
                : definition.node.imported.value) === name;
      });
    const isVueFunction = (node: AnyNode, name: string): boolean =>
      node?.type === "Identifier" &&
      (isVueImport(node, name) || (node.name === name && !variableFor(node)));
    const props = new Set<AnyNode>();
    for (const statement of ast.body) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "ObjectPattern" ||
          declaration.init?.type !== "CallExpression" ||
          declaration.init.callee.type !== "Identifier" ||
          declaration.init.callee.name !== "defineProps" ||
          !isVueFunction(declaration.init.callee, "defineProps")
        )
          continue;
        for (const property of declaration.id.properties) {
          if (property.type !== "Property") continue;
          const binding =
            property.value.type === "AssignmentPattern" ? property.value.left : property.value;
          const variable = binding.type === "Identifier" ? variableFor(binding) : undefined;
          if (variable) props.add(variable);
        }
      }
    }
    const result = new Set<number>();
    const visit = (node: AnyNode) => {
      if (!node?.type) return;
      const argument = node.arguments?.[0];
      if (
        node.type === "CallExpression" &&
        argument?.type === "Identifier" &&
        props.has(variableFor(argument))
      ) {
        const callee = node.callee;
        const namespaceWatch =
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          (callee.computed ? callee.property.value : callee.property.name) === "watch" &&
          isVueImport(callee.object, "watch", true);
        if (isVueFunction(callee, "watch") || namespaceWatch)
          result.add(setup.loc.start.offset + argument.range[0]);
      }
      for (const key of visitorKeys[node.type] ?? []) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
    };
    visit(ast);
    return result;
  } catch {
    return new Set();
  }
}
