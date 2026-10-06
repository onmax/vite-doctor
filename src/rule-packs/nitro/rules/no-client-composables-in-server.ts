import { parseForESLint } from "../../../core/internal/lazy-parsers.js";
import { AnyNode, createRule, isNitroServerFile, report } from "./shared.js";

const clientComposables = new Set([
  "useRoute",
  "useRouter",
  "useState",
  "useFetch",
  "useAsyncData",
  "useHead",
  "useSeoMeta",
]);

export const noClientComposablesInServer = createRule({
  meta: {
    id: "nitro/server/no-client-composables",
    title: "Do not use app composables in Nitro server files",
    description: "Nuxt app composables are not available from Nitro server files.",
    why: "Server handlers run with Nitro request context, not Vue setup context. App composables like useRoute(), useFetch(), and useHead() depend on the Nuxt app runtime.",
    recommendedReplacement: "Use event-aware Nitro utilities in server handlers.",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/guide/routing#request-handler",
    requires: { script: true, nitro: true },
    prefilter: { names: [...clientComposables] },
  },
  create(ctx) {
    if (!isNitroServerFile(ctx)) return;
    const calls = appComposableCalls(ctx.file.text, ctx.file.relativePath);
    return {
      CallExpression(node: AnyNode) {
        const name = calls
          ? calls.get(node.start)
          : node.callee?.type === "Identifier" && clientComposables.has(node.callee.name)
            ? node.callee.name
            : undefined;
        if (!name) return;
        report(
          ctx,
          node,
          "nitro/server/no-client-composables",
          "error",
          "server",
          `${name}() is a Nuxt app composable and is not available in Nitro server files.`,
          "Use event-aware Nitro utilities in server handlers.",
        );
      },
    };
  },
});

function appComposableCalls(source: string, path: string): Map<number, string> | undefined {
  const names = clientComposables;
  const result = new Map<number, string>();
  try {
    const { ast, scopeManager, visitorKeys } = parseBindingSource(source, path);
    const references = new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference] as const),
      ),
    );
    const appName = (callee: AnyNode): string | undefined => {
      const namespace = callee?.type === "MemberExpression";
      const target = namespace ? callee.object : callee;
      if (target?.type !== "Identifier") return;
      const name = namespace
        ? callee.computed
          ? callee.property.value
          : callee.property.name
        : target.name;
      const variable = references.get(target)?.resolved;
      if (!variable) return !namespace && names.has(name) ? name : undefined;
      for (const definition of variable.defs) {
        if (
          definition.type !== "ImportBinding" ||
          definition.parent.type !== "ImportDeclaration" ||
          definition.parent.importKind === "type" ||
          !["#app", "nuxt/app"].includes(String(definition.parent.source.value))
        )
          continue;
        const binding = definition.node;
        if (namespace && binding.type === "ImportNamespaceSpecifier" && names.has(name))
          return name;
        if (!namespace && binding.type === "ImportSpecifier" && binding.importKind !== "type") {
          const imported =
            binding.imported.type === "Identifier"
              ? binding.imported.name
              : String(binding.imported.value);
          if (names.has(imported)) return imported;
        }
      }
    };
    const visit = (node: AnyNode) => {
      if (!node?.type) return;
      if (node.type === "CallExpression") {
        const name = appName(node.callee);
        if (name) result.set(node.range[0], name);
      }
      for (const key of visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit);
        else visit(child);
      }
    };
    visit(ast);
  } catch {
    return undefined;
  }
  return result;
}

function parseBindingSource(source: string, path: string) {
  const options = {
    range: true,
    sourceType: "module",
    ecmaFeatures: { jsx: /\.[jt]sx$/.test(path) },
  } as const;
  try {
    return parseForESLint(source, options);
  } catch {
    return parseForESLint(source.replaceAll("import.source", "import_source"), options);
  }
}
