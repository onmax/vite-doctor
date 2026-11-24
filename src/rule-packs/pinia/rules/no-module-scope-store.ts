import { join, relative } from "pathe";
import { createRule, type NuxtProjectInfo, type RuleContext } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { isPiniaSource, nuxtForFile } from "./shared.js";
import {
  calleeBinding,
  collectStores,
  findStoreCalls,
  implicitImportsEnabled,
  storeRange,
  unwrap,
  type AnyNode,
  type StoreCall,
} from "./store-inventory.js";

const RULE_ID = "pinia/stores/no-module-scope-store";

export const noModuleScopeStore = createRule({
  meta: {
    id: RULE_ID,
    title: "Call stores inside setup or functions, not at module scope",
    description:
      "Report useXStore() calls that run when a module is first imported instead of inside setup, a composable, an action, or a callback.",
    why: 'useXStore() finds its Pinia instance through the current app\'s injection context, falling back to the active Pinia. At module scope there is no app context: before app.use(pinia) runs, Pinia throws "getActivePinia()" was called but there was no active Pinia, and with server-side rendering the module runs once per server process, so every request shares the store it got.',
    recommendedReplacement:
      "Move the useXStore() call into the function that needs the store: <script setup>, setup(), a composable, a store action, a router guard, or a Nuxt plugin or middleware callback.",
    examples: [
      {
        title: "Call the store inside the guard that uses it",
        language: "ts",
        invalid:
          "const user = useUserStore()\n\nrouter.beforeEach((to) => {\n  if (to.meta.requiresAuth && !user.isLoggedIn) return '/login'\n})",
        valid:
          "router.beforeEach((to) => {\n  const user = useUserStore()\n  if (to.meta.requiresAuth && !user.isLoggedIn) return '/login'\n})",
      },
    ],
    category: "stores",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: false,
    diagnosticCodes: ["PINIA0006"],
    docsUrl: "https://pinia.vuejs.org/core-concepts/outside-component-usage.html",
    execution: "workspace",
    cacheScope: "none",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast", "graph"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const collection = await collectStores(ctx);
        if (!collection.stores.length) return;
        for (const call of await findStoreCalls(ctx, collection)) {
          if (call.context !== "module") continue;
          const argument = call.call.arguments[0];
          if (argument && !isMissingInstance(call, argument)) continue;
          const nuxt = nuxtForFile(ctx, call.file);
          const ssr = nuxt && nuxt.ssr !== false && !isClientOnlyPlugin(nuxt, call.file);
          if (!ssr && hasPriorActivation(ctx, call)) continue;
          const id = call.store.located.store.id;
          const callee = unwrap(call.call.callee);
          const name = call.text.slice(callee.range[0], callee.range[1]);
          const byName = call.byName
            ? ` Doctor found no import of the store here, so it matched the call to the only store exported under that name, as an auto-import from @pinia/nuxt or unplugin-auto-import would resolve it.`
            : "";
          const range = storeRange(ctx, call.file, call.text, call.call);
          ctx.report(
            diagnostics.PINIA0006({
              why: `${name}() for store "${id}" runs at module scope, when this module is first imported, outside any component setup or app context. ${ssr ? "With server-side rendering the module runs once per server process, so every request shares the store it got, or Pinia throws because no Pinia is active yet." : 'If the module is imported before app.use(pinia), Pinia throws "getActivePinia()" was called but there was no active Pinia.'}${byName}`,
              fix: `Move ${name}() into the function that uses the store, such as <script setup>, a composable, an action, a router guard, or a plugin or middleware callback.`,
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "stores",
              file: call.file,
              range,
              confidence: call.byName ? "heuristic-medium" : "heuristic-high",
              evidence: [
                {
                  kind: "ast",
                  file: call.file,
                  range,
                  summary: `Module-scope call to store "${id}" defined in ${relative(ctx.project.root, call.store.located.module.file)}.`,
                },
              ],
            },
          );
        }
      },
    };
  },
});

function isClientOnlyPlugin(nuxt: NuxtProjectInfo, file: string): boolean {
  return [nuxt.appDir, ...nuxt.layers.map((layer) => layer.srcDir)].some((dir) =>
    Boolean(dir && /^[^/]+\.client\.[cm]?[jt]sx?$/.test(relative(join(dir, "plugins"), file))),
  );
}

function isMissingInstance(call: StoreCall, argument: AnyNode): boolean {
  const node = unwrap(argument);
  return (
    (node.type === "Literal" && !node.value) ||
    (node.type === "UnaryExpression" && node.operator === "void") ||
    (node.type === "Identifier" &&
      node.name === "undefined" &&
      !call.source.scope.references.get(node)?.resolved?.defs.length)
  );
}

function hasPriorActivation(ctx: RuleContext, call: StoreCall): boolean {
  const { scope } = call.source;
  const nuxt = nuxtForFile(ctx, call.file);
  const implicit = implicitImportsEnabled(ctx, call.file);
  function api(node: AnyNode) {
    return node?.type === "CallExpression"
      ? calleeBinding(unwrap(node.callee), scope, nuxt, implicit)
      : undefined;
  }
  function initializer(value: AnyNode, before: number) {
    const node = unwrap(value);
    if (node?.type !== "Identifier") return node;
    const definitions = scope.references.get(node)?.resolved?.defs;
    const definition = definitions?.length === 1 ? definitions[0] : undefined;
    return definition?.type === "Variable" &&
      definition.parent.kind === "const" &&
      definition.node.id === definition.name &&
      definition.node.range[1] < before
      ? unwrap(definition.node.init)
      : undefined;
  }
  function testingPinia(node: AnyNode) {
    const binding = api(node);
    return binding?.from === "@pinia/testing" && binding.name === "createTestingPinia";
  }
  function piniaInstance(value: AnyNode, before: number) {
    const init = initializer(value, before);
    const binding = api(init);
    return (binding?.name === "createPinia" && isPiniaSource(binding.from)) || testingPinia(init);
  }
  let active = false;
  for (const statement of scope.ast.body as AnyNode[]) {
    if (statement.range[1] > call.call.range[0]) break;
    if (call.contextOf(statement) !== "module") continue;
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      if (declaration.declarations.some((item: AnyNode) => testingPinia(unwrap(item.init))))
        active = true;
      continue;
    }
    if (statement.type !== "ExpressionStatement") continue;
    const expression = unwrap(statement.expression);
    if (expression?.type !== "CallExpression" || expression.optional) continue;
    const binding = api(expression);
    if (testingPinia(expression)) active = true;
    else if (binding?.name === "setActivePinia" && isPiniaSource(binding.from))
      active = piniaInstance(expression.arguments[0], expression.range[0]);
    else {
      const callee = unwrap(expression.callee);
      if (
        callee?.type !== "MemberExpression" ||
        callee.optional ||
        callee.computed ||
        callee.property.name !== "use"
      )
        continue;
      const receiver = api(initializer(callee.object, expression.range[0]));
      if (
        receiver?.from === "vue" &&
        ["createApp", "createSSRApp"].includes(receiver.name) &&
        piniaInstance(expression.arguments[0], expression.range[0])
      )
        active = true;
    }
  }
  return active;
}
