import { parseForESLint } from "@typescript-eslint/parser";
import type { RuleContext } from "../../../../core/index.js";
import { createVueScriptForParsing } from "../../../../core/internal/sfc.js";
import { AnyNode, createRule, report } from "./shared.js";

export const requirePostFlushForDomWatch = createRule({
  meta: {
    id: "vue/watch/require-post-flush-for-dom-read",
    title: "Use post-flush watchers for DOM reads",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/watchers.html#post-watchers",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.project.framework === "nuxt" && !isNuxtVueRuntimePath(ctx.file.relativePath)) return;
    let unsafeWatchers: Set<number> | undefined;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "CallExpression") return;
        if (!(unsafeWatchers ??= watchersWithEarlyDomReads(ctx)).has(node.start)) return;
        report(
          ctx,
          node,
          "vue/watch/require-post-flush-for-dom-read",
          "warn",
          "watchers",
          "This watcher reads DOM state before Vue has flushed owner DOM updates.",
          "Pass { flush: 'post' }, use watchPostEffect(), or await nextTick() before reading DOM state.",
        );
      },
    };
  },
});

function isNuxtVueRuntimePath(path: string) {
  if (
    path.includes(".client.") ||
    /\.(md|mdc|markdown)$/.test(path) ||
    /^(content|server|app\/server|shared\/types|generated|app\/generated)\//.test(path)
  )
    return false;
  return /^(app\/)?(components|composables|layouts|middleware|pages|plugins|utils)\//.test(path);
}

function watchersWithEarlyDomReads(ctx: RuleContext): Set<number> {
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
    type FlushState = { ready: boolean; found: boolean; continues: boolean };
    const scan = (node: AnyNode, ready = false, parent?: AnyNode): FlushState => {
      const state = { ready, found: false, continues: true };
      if (
        !node?.type ||
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
      )
        return state;
      if (node.type === "AwaitExpression") {
        const argument = scan(node.argument, ready, node);
        return {
          ...argument,
          ready:
            argument.ready ||
            (node.argument.type === "CallExpression" &&
              vueFunction(node.argument.callee, ["nextTick"])),
        };
      }
      if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
        const condition = scan(node.test, ready, node);
        if (node.test.type === "Literal" && typeof node.test.value === "boolean") {
          const branch = scan(
            node.test.value ? node.consequent : node.alternate,
            condition.ready,
            node,
          );
          return { ...branch, found: condition.found || branch.found };
        }
        const consequent = scan(node.consequent, condition.ready, node);
        const alternate = scan(node.alternate, condition.ready, node);
        return {
          ready:
            (!consequent.continues || consequent.ready) &&
            (!alternate.continues || alternate.ready),
          found: condition.found || consequent.found || alternate.found,
          continues: consequent.continues || alternate.continues,
        };
      }
      if (node.type === "LogicalExpression") {
        const left = scan(node.left, ready, node);
        if (node.left.type === "Literal") {
          const value = node.left.value;
          const entersRight =
            node.operator === "&&"
              ? Boolean(value)
              : node.operator === "||"
                ? !value
                : value == null;
          if (!entersRight) return left;
          const right = scan(node.right, left.ready, node);
          return { ...right, found: left.found || right.found };
        }
        const right = scan(node.right, left.ready, node);
        return { ...left, found: left.found || right.found };
      }
      if (node.type === "ForStatement" || node.type === "WhileStatement") {
        const initializer = scan(node.init, ready, node);
        const condition = scan(node.test, initializer.ready, node);
        const body = scan(node.body, condition.ready, node);
        const update = body.continues ? scan(node.update, body.ready, node) : body;
        return {
          ready: condition.ready,
          found: initializer.found || condition.found || body.found || update.found,
          continues: true,
        };
      }
      if (node.type === "DoWhileStatement") {
        const body = scan(node.body, ready, node);
        const condition = body.continues ? scan(node.test, body.ready, node) : body;
        return { ready, found: body.found || condition.found, continues: true };
      }
      if (node.type === "SwitchStatement") {
        const discriminant = scan(node.discriminant, ready, node);
        return {
          ...discriminant,
          found:
            discriminant.found ||
            node.cases.some((branch: AnyNode) => scan(branch, discriminant.ready, node).found),
        };
      }
      if (node.type === "TryStatement") {
        const block = scan(node.block, ready, node);
        const handler = node.handler ? scan(node.handler, ready, node) : block;
        const finalizer = scan(node.finalizer, block.ready && handler.ready, node);
        return {
          ready: finalizer.ready,
          found: block.found || handler.found || finalizer.found,
          continues: finalizer.continues && (block.continues || handler.continues),
        };
      }
      for (const key of visitorKeys[node.type] ?? []) {
        const children = Array.isArray(node[key]) ? node[key] : [node[key]];
        for (const child of children) {
          if (!state.continues) break;
          const next = scan(child, state.ready, node);
          state.ready = next.ready;
          state.found ||= next.found;
          state.continues = next.continues;
        }
      }
      if (!state.ready && isDomRead(node, parent)) state.found = true;
      if (
        ["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(
          node.type,
        )
      )
        state.continues = false;
      if (
        ["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement"].includes(node.type)
      )
        return { ...state, ready, continues: true };
      return state;
    };
    const result = new Set<number>();
    const visit = (node: AnyNode) => {
      if (!node?.type) return;
      if (node.type === "CallExpression" && vueFunction(node.callee, ["watch"])) {
        const callback = node.arguments[1];
        if (callback?.body && !hasPostFlush(node.arguments[2]) && scan(callback.body).found)
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

function hasPostFlush(options: AnyNode): boolean {
  if (options?.type !== "ObjectExpression") return false;
  let post = false;
  for (const property of options.properties) {
    if (property.type === "SpreadElement") post = false;
    else if (
      (property.computed ? property.key.value : (property.key.name ?? property.key.value)) ===
      "flush"
    )
      post = property.value.type === "Literal" && property.value.value === "post";
    else if (property.computed && property.key.type !== "Literal") post = false;
  }
  return post;
}

function isDomRead(node: AnyNode, parent: AnyNode): boolean {
  if (node.type !== "MemberExpression") return false;
  if (
    (parent?.type === "AssignmentExpression" && parent.left === node && parent.operator === "=") ||
    (parent?.type === "UnaryExpression" && parent.operator === "delete")
  )
    return false;
  const property = node.computed ? node.property.value : node.property.name;
  return (
    typeof property === "string" &&
    (/^(getBoundingClientRect|offset(?:Width|Height|Left|Top)|client(?:Width|Height|Left|Top)|scroll(?:Width|Height|Left|Top))$/.test(
      property,
    ) ||
      (node.object.name === "window" &&
        /^(innerWidth|innerHeight|outerWidth|outerHeight|getComputedStyle|matchMedia)$/.test(
          property,
        )) ||
      (node.object.name === "document" &&
        /^(querySelector|querySelectorAll|getElementById|getElementsBy.*|documentElement|body)$/.test(
          property,
        )))
  );
}
