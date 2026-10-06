import type { RuleContext } from "../../../../core/index.js";
import { fileScriptScope, scriptMayName } from "./script-scope.js";
import { AnyNode, createRule, namePattern, report } from "./shared.js";

const SETUP_NAMES = namePattern(["setup", "defineComponent"]);

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
    docsUrl: "https://vuejs.org/api/composition-api-setup.html#accessing-props",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, SETUP_NAMES)) return;
    let snapshots: Set<string> | undefined;
    const visit = (node: AnyNode) => {
      if (!(snapshots ??= setupPropSnapshots(ctx)).has(`${node.type}:${node.start}`)) return;
      report(
        ctx,
        node,
        "vue/reactivity/no-setup-props-destructure",
        "error",
        "reactivity",
        "Destructuring a setup() props parameter creates non-reactive local values.",
        "Use props.foo, toRefs(props), or migrate to <script setup> reactive props destructuring.",
      );
    };
    return { VariableDeclarator: visit, ObjectPattern: visit, ArrayPattern: visit };
  },
});

function setupPropSnapshots(ctx: RuleContext): Set<string> {
  const scope = fileScriptScope(ctx);
  if (!scope) return new Set();
  try {
    const { ast, scopeManager, visitorKeys, references } = scope;
    const parents = new Map<AnyNode, AnyNode>();
    const owners = new Map<AnyNode, AnyNode>();
    const functions: AnyNode[] = [];
    const declarations: AnyNode[] = [];
    const collect = (node: AnyNode, parent?: AnyNode, owner?: AnyNode) => {
      if (!node?.type) return;
      parents.set(node, parent);
      if (
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
      ) {
        functions.push(node);
        owner = node;
      }
      owners.set(node, owner);
      if (node.type === "VariableDeclarator") declarations.push(node);
      for (const key of visitorKeys[node.type] ?? []) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach((child) => collect(child, node, owner));
        else collect(value, node, owner);
      }
    };
    collect(ast);
    const isTypeScriptWrapper = (node: AnyNode | undefined): boolean =>
      ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node?.type);
    const unwrapParent = (node: AnyNode): AnyNode | undefined => {
      let parent = parents.get(node);
      while (isTypeScriptWrapper(parent)) parent = parents.get(parent!);
      return parent;
    };
    const isDefineComponent = (node: AnyNode): boolean => {
      const namespace =
        node?.type === "MemberExpression" &&
        (node.computed ? node.property.value : node.property.name) === "defineComponent";
      const target = namespace ? node.object : node;
      if (target?.type !== "Identifier") return false;
      const variable = references.get(target)?.resolved;
      if (!variable) return target.name === (namespace ? "Vue" : "defineComponent");
      return variable.defs.some((definition) => {
        if (
          definition.type !== "ImportBinding" ||
          definition.parent.type !== "ImportDeclaration" ||
          definition.parent.importKind === "type" ||
          (definition.parent.source.value !== "vue" &&
            !(ctx.project.framework === "nuxt" && definition.parent.source.value === "#imports"))
        )
          return false;
        return namespace
          ? definition.node.type === "ImportNamespaceSpecifier"
          : definition.node.type === "ImportSpecifier" &&
              definition.node.importKind !== "type" &&
              (definition.node.imported.type === "Identifier"
                ? definition.node.imported.name
                : definition.node.imported.value) === "defineComponent";
      });
    };
    const isComponentObject = (object: AnyNode): boolean => {
      if (object?.type !== "ObjectExpression") return false;
      const container = unwrapParent(object);
      if (container?.type === "ExportDefaultDeclaration") return true;
      if (container?.type === "CallExpression") {
        let argument = container.arguments[0];
        while (isTypeScriptWrapper(argument)) argument = argument.expression;
        if (argument === object) return isDefineComponent(container.callee);
        return false;
      }
      if (
        container?.type !== "VariableDeclarator" ||
        container.id.type !== "Identifier" ||
        parents.get(container)?.kind !== "const"
      )
        return false;
      return Boolean(
        references
          .get(container.id)
          ?.resolved?.references.some(
            (reference) =>
              reference.isRead() &&
              parents.get(reference.identifier)?.type === "ExportDefaultDeclaration",
          ),
      );
    };
    const isComponentSetup = (node: AnyNode): boolean => {
      const parent = unwrapParent(node);
      if (parent?.type === "CallExpression") {
        let argument = parent.arguments[0];
        while (isTypeScriptWrapper(argument)) argument = argument.expression;
        if (argument === node) return isDefineComponent(parent.callee);
        return false;
      }
      if (parent?.type !== "Property") return false;
      let value = parent.value;
      while (isTypeScriptWrapper(value)) value = value.expression;
      if (value !== node) return false;
      const key = parent.computed ? parent.key.value : (parent.key.name ?? parent.key.value);
      if (key !== "setup") return false;
      return isComponentObject(parents.get(parent));
    };
    const result = new Set<string>();
    for (const fn of functions) {
      if (!isComponentSetup(fn)) continue;
      const first = fn.params[0];
      const parameter = first?.type === "AssignmentPattern" ? first.left : first;
      if (!parameter) continue;
      if (["ObjectPattern", "ArrayPattern"].includes(parameter.type)) {
        result.add(`${parameter.type}:${parameter.range[0]}`);
        continue;
      }
      if (parameter.type !== "Identifier") continue;
      const variable = scopeManager
        .acquire(fn, true)
        ?.variables.find((entry) => entry.identifiers.includes(parameter));
      if (!variable) continue;
      for (const declaration of declarations) {
        if (
          owners.get(declaration) === fn &&
          ["ObjectPattern", "ArrayPattern"].includes(declaration.id.type) &&
          declaration.init?.type === "Identifier" &&
          references.get(declaration.init)?.resolved === variable
        )
          result.add(`VariableDeclarator:${declaration.range[0]}`);
      }
    }
    return result;
  } catch {
    return new Set();
  }
}
