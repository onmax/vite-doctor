import { join, relative, resolve } from "pathe";
import { createRule, type NuxtProjectInfo, type RuleContext } from "../../../core/index.js";
import { ownPropertyName } from "../../../core/internal/shared-state-writes.js";
import { parseScriptResult } from "../../../core/internal/script.js";
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
        const execution = nuxtExecution(ctx);
        for (const call of await findStoreCalls(ctx, collection)) {
          if (call.context !== "module") continue;
          const argument = call.call.arguments[0];
          if (argument && !isMissingInstance(call, argument)) continue;
          const nuxt = nuxtForFile(ctx, call.file);
          const active = hasPriorActivation(ctx, call);
          const server =
            nuxt && nuxt.ssr !== false && (await execution(nuxt, call.file)) === "server";
          if (active && !server) continue;
          const consequences = [];
          if (!active)
            consequences.push(
              'If the module is imported before app.use(pinia), Pinia throws "getActivePinia()" was called but there was no active Pinia.',
            );
          if (server)
            consequences.push(
              "If this module runs during server-side rendering, every request shares the store it got.",
            );
          const id = call.store.located.store.id;
          const callee = unwrap(call.call.callee);
          const name = call.text.slice(callee.range[0], callee.range[1]);
          const byName = call.byName
            ? ` Doctor found no import of the store here, so it matched the call to the only store exported under that name, as an auto-import from @pinia/nuxt or unplugin-auto-import would resolve it.`
            : "";
          const range = storeRange(ctx, call.file, call.text, call.call);
          ctx.report(
            diagnostics.PINIA0006({
              why: `${name}() for store "${id}" runs at module scope, when this module is first imported, outside any component setup or app context. ${consequences.join(" ")}${byName}`,
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

const CLIENT_SUFFIX = /\.client(?:\.\w+)*$/;
const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/;
type Execution = "client" | "server" | "unknown";

function nuxtExecution(ctx: RuleContext) {
  const entryPoints = new Map<NuxtProjectInfo, ReturnType<typeof nuxtEntryPoints>>();
  return async (nuxt: NuxtProjectInfo, file: string): Promise<Execution> => {
    let entryPoint = entryPoints.get(nuxt);
    if (!entryPoint) {
      entryPoint = nuxtEntryPoints(ctx, nuxt);
      entryPoints.set(nuxt, entryPoint);
    }
    const graph = await ctx.inventory.importGraph();
    const pending = [file];
    const visited = new Set(pending);
    let client = false;
    let unknown = false;
    for (const path of pending) {
      const mode = entryPoint(path);
      if (mode === "server") return "server";
      if (mode === "client") client = true;
      let hasImporter = false;
      for (const edge of graph.importersOf(path)) {
        if (edge.typeOnly || edge.kind === "dynamic-import") continue;
        hasImporter = true;
        if (visited.has(edge.from)) continue;
        visited.add(edge.from);
        pending.push(edge.from);
      }
      if (mode === "unknown" || (!mode && !hasImporter)) unknown = true;
    }
    return client && !unknown ? "client" : "unknown";
  };
}

function nuxtEntryPoints(ctx: RuleContext, nuxt: NuxtProjectInfo) {
  const registered = readPluginRegistrations(ctx, nuxt);
  const appDirs = [nuxt.appDir, ...nuxt.layers.map((layer) => layer.srcDir ?? layer.root)];
  const serverEntries = new Set(Object.values(nuxt.serverDirs).flat());
  return (path: string): Execution | undefined => {
    if (serverEntries.has(path)) return "server";
    const registration =
      registered?.get(path) ?? registered?.get(path.replace(SCRIPT_EXTENSION, ""));
    if (registration) return registration;
    for (const dir of appDirs) {
      const local = relative(dir, path);
      if (local === "app.vue" || local === "error.vue") return "server";
      if (local.startsWith("pages/") && local.endsWith(".vue"))
        return CLIENT_SUFFIX.test(local) ? "client" : "server";
      if (SCRIPT_EXTENSION.test(local) && /^plugins\/(?:[^/]+|[^/]+\/index\.[^/]+)$/.test(local))
        return registered ? (CLIENT_SUFFIX.test(local) ? "client" : "server") : "unknown";
    }
  };
}

function readPluginRegistrations(ctx: RuleContext, nuxt: NuxtProjectInfo) {
  const roots = new Map(nuxt.layers.map((layer) => [layer.root, layer.srcDir]));
  const appRoot = nuxt.appRoots
    .filter((root) => nuxt.appDir === root || nuxt.appDir.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (appRoot) roots.set(appRoot, nuxt.appDir);
  const registrations = new Map<string, Execution>();
  for (const [root, srcDir = root] of roots) {
    for (const extension of ["ts", "js", "mjs", "mts", "cjs", "cts"]) {
      const file = join(root, `nuxt.config.${extension}`);
      const text = ctx.fs.readText(file);
      if (text === undefined) continue;
      const { ast, errors } = parseScriptResult(file, text);
      if (!ast || errors.length) return null;
      const body = ast.body as AnyNode[];
      let config = unwrap(
        body.find((node) => node.type === "ExportDefaultDeclaration")?.declaration,
      );
      if (config?.type === "CallExpression" && config.callee.name === "defineNuxtConfig")
        config = unwrap(config.arguments[0]);
      const fields = staticFields(config);
      if (!fields || [...fields.keys()].some((key) => key.startsWith("$"))) return null;
      const plugins = fields.get("plugins");
      if (!plugins) continue;
      if (plugins.type !== "ArrayExpression") return null;
      for (const entry of plugins.elements.map(unwrap)) {
        const options = staticFields(entry);
        const source = options ? options.get("src") : entry;
        if (typeof source?.value !== "string") return null;
        const specifier: string = source.value;
        const execution = pluginExecution(specifier, options);
        const register = (path: string) => {
          const existing = registrations.get(path);
          registrations.set(path, existing && existing !== execution ? "unknown" : execution);
        };
        const alias = /^(~~|@@|~|@)\//.exec(specifier)?.[0];
        if (alias) {
          register(resolve(alias.length === 2 ? srcDir : root, specifier.slice(alias.length)));
        } else {
          register(resolve(root, specifier));
          register(resolve(srcDir, specifier));
          for (const [name, path] of Object.entries(nuxt.manifest?.aliases ?? {})) {
            if (specifier.startsWith(`${name}/`))
              register(resolve(root, path, specifier.slice(name.length + 1)));
          }
        }
      }
    }
  }
  return registrations;
}

function pluginExecution(specifier: string, options: Map<string, AnyNode> | null): Execution {
  const ssr = options?.get("ssr");
  if (ssr?.value === true) return "server";
  if (ssr && ssr.value !== false) return "unknown";
  const mode = options?.get("mode");
  if (!mode) return CLIENT_SUFFIX.test(specifier) ? "client" : "server";
  if (mode.value === "client") return "client";
  if (mode.value === "server" || mode.value === "all") return "server";
  return "unknown";
}

function staticFields(node: AnyNode): Map<string, AnyNode> | null {
  if (node?.type !== "ObjectExpression") return null;
  const fields = new Map<string, AnyNode>();
  for (const property of node.properties) {
    const key = ownPropertyName(property);
    if (key === null || property.kind !== "init") return null;
    fields.set(key, unwrap(property.value));
  }
  return fields;
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
