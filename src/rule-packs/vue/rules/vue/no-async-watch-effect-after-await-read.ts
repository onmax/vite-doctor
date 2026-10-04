import { parseForESLint } from "@typescript-eslint/parser";
import type { RuleContext } from "../../../../core/index.js";
import { createVueScriptForParsing } from "../../../../core/internal/sfc.js";
import { AnyNode, createRule, report } from "./shared.js";

export const noAsyncWatchEffectAfterAwaitRead = createRule({
  meta: {
    id: "vue/watch/no-async-watcheffect-after-await-read",
    title: "Do not read watchEffect dependencies after await",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/watchers.html#watcheffect",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    let effects: Set<number> | undefined;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "CallExpression") return;
        if (!(effects ??= effectsWithUntrackedReads(ctx)).has(node.start)) return;
        report(
          ctx,
          node,
          "vue/watch/no-async-watcheffect-after-await-read",
          "warn",
          "watchers",
          "watchEffect only tracks dependencies read before the first await.",
          "Read dependencies before awaiting or use watch() with an explicit source.",
        );
      },
    };
  },
});

function effectsWithUntrackedReads(ctx: RuleContext): Set<number> {
  const script = ctx.file.sfc
    ? createVueScriptForParsing(ctx.file.sfc.descriptor, ctx.file.text)
    : { text: ctx.file.text, lang: /\.[jt]sx$/.test(ctx.file.relativePath) ? "tsx" : "ts" };
  try {
    const { ast, scopeManager, visitorKeys } = parseForESLint(script.text, {
      range: true,
      sourceType: "module",
      ecmaFeatures: { jsx: ["jsx", "tsx"].includes(script.lang) },
    });
    const references = new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference] as const),
      ),
    );
    const vueFunction = (node: AnyNode, names: string[]): boolean => {
      const namespace = node?.type === "MemberExpression";
      const name = namespace
        ? node.computed
          ? node.property.value
          : node.property.name
        : node?.name;
      const target = namespace ? node.object : node;
      if (target?.type !== "Identifier") return false;
      const variable = references.get(target)?.resolved;
      if (!variable) return !namespace && names.includes(name);
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
          ? definition.node.type === "ImportNamespaceSpecifier" && names.includes(name)
          : definition.node.type === "ImportSpecifier" &&
              definition.node.importKind !== "type" &&
              names.includes(
                definition.node.imported.type === "Identifier"
                  ? definition.node.imported.name
                  : String(definition.node.imported.value),
              );
      });
    };
    const reactiveRead = (node: AnyNode, parent: AnyNode): boolean => {
      if (node.type !== "MemberExpression" || node.object.type !== "Identifier") return false;
      if (
        (parent?.type === "AssignmentExpression" &&
          parent.left === node &&
          parent.operator === "=") ||
        (parent?.type === "UnaryExpression" && parent.operator === "delete")
      )
        return false;
      const property = node.computed ? node.property.value : node.property.name;
      const variable = references.get(node.object)?.resolved;
      if (!variable) return property === "value";
      if (variable.references.some((reference) => reference.isWrite() && !reference.init))
        return false;
      let plainValue = false;
      for (const definition of variable.defs) {
        if (definition.type !== "Variable" || definition.node.id.type !== "Identifier") continue;
        const initializer = definition.node.init;
        if (
          [
            "ObjectExpression",
            "ArrayExpression",
            "Literal",
            "FunctionExpression",
            "ArrowFunctionExpression",
          ].includes(initializer?.type ?? "")
        )
          plainValue = true;
        if (initializer?.type !== "CallExpression") continue;
        if (
          vueFunction(initializer.callee, ["reactive", "shallowReactive", "defineProps"]) ||
          (property === "value" &&
            vueFunction(initializer.callee, [
              "ref",
              "shallowRef",
              "computed",
              "customRef",
              "useTemplateRef",
            ]))
        )
          return true;
      }
      return property === "value" && !plainValue;
    };
    type ReadState = { after: boolean; found: boolean; continues: boolean; breakAfter?: boolean };
    const scan = (node: AnyNode, after = false, parent?: AnyNode): ReadState => {
      const state: ReadState = { after, found: false, continues: true };
      if (
        !node?.type ||
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
      )
        return state;
      if (node.type === "AwaitExpression") {
        const argument = scan(node.argument, after, node);
        return { ...argument, after: true };
      }
      if (node.type === "ForStatement" || node.type === "WhileStatement") {
        const initializer = scan(node.init, after, node);
        const condition = scan(node.test, initializer.after, node);
        const body = scan(node.body, condition.after, node);
        const update = body.continues ? scan(node.update, body.after, node) : body;
        return {
          after: condition.after || body.after || update.after,
          found: initializer.found || condition.found || body.found || update.found,
          continues: true,
        };
      }
      if (node.type === "DoWhileStatement") {
        const body = scan(node.body, after, node);
        const condition = body.continues ? scan(node.test, body.after, node) : body;
        return { after: condition.after, found: body.found || condition.found, continues: true };
      }
      if (node.type === "SwitchStatement") {
        const discriminant = scan(node.discriminant, after, node);
        let fallthrough = false;
        let afterSwitch = discriminant.after;
        let found = discriminant.found;
        for (const branch of node.cases) {
          const selected = scan(branch, discriminant.after || fallthrough, node);
          found ||= selected.found;
          afterSwitch ||= selected.breakAfter ?? false;
          fallthrough = selected.continues && selected.after;
        }
        return { after: afterSwitch || fallthrough, found, continues: true };
      }
      if (node.type === "LogicalExpression") {
        const left = scan(node.left, after, node);
        if (node.left.type === "Literal") {
          const value = node.left.value;
          const entersRight =
            node.operator === "&&"
              ? Boolean(value)
              : node.operator === "||"
                ? !value
                : value == null;
          if (!entersRight) return left;
        }
        const right = scan(node.right, left.after, node);
        return { ...right, after: left.after || right.after, found: left.found || right.found };
      }
      if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
        const condition = scan(node.test, after, node);
        if (node.test.type === "Literal" && typeof node.test.value === "boolean") {
          const branch = scan(
            node.test.value ? node.consequent : node.alternate,
            condition.after,
            node,
          );
          return { ...branch, found: condition.found || branch.found };
        }
        const consequent = scan(node.consequent, condition.after, node);
        const alternate = scan(node.alternate, condition.after, node);
        return {
          after:
            (consequent.continues && consequent.after) || (alternate.continues && alternate.after),
          found: condition.found || consequent.found || alternate.found,
          continues: consequent.continues || alternate.continues,
          breakAfter: consequent.breakAfter || alternate.breakAfter,
        };
      }
      for (const key of visitorKeys[node.type] ?? []) {
        const children = Array.isArray(node[key]) ? node[key] : [node[key]];
        for (const child of children) {
          if (!state.continues) break;
          const next = scan(child, state.after, node);
          state.after = next.after;
          state.found ||= next.found;
          state.continues = next.continues;
          state.breakAfter ||= next.breakAfter;
        }
      }
      if (state.after && reactiveRead(node, parent)) state.found = true;
      if (
        ["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(
          node.type,
        )
      )
        state.continues = false;
      if (node.type === "BreakStatement") state.breakAfter = state.after;
      return state;
    };
    const result = new Set<number>();
    const visit = (node: AnyNode) => {
      if (!node?.type) return;
      if (node.type === "CallExpression" && vueFunction(node.callee, ["watchEffect"])) {
        const callback = node.arguments[0];
        if (callback?.async && callback.body && scan(callback.body).found)
          result.add(node.range[0]);
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
