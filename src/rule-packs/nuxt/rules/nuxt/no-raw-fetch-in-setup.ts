import { AnyNode, createRule, nearestFunctionOrProgram, report } from "./shared.js";

export const noRawFetchInSetup = createRule({
  meta: {
    id: "nuxt/fetch/no-raw-fetch-in-setup",
    title: "Use Nuxt data fetching primitives for SSR render data",
    category: "fetching",
    severity: "warn",
    fixable: false,
    docsUrl:
      "https://nuxt.com/docs/4.x/getting-started/data-fetching#the-need-for-usefetch-and-useasyncdata",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const appSurface =
      ctx.file.isVueSfc &&
      (ctx.file.inAppDir("pages") ||
        ctx.file.inAppDir("components") ||
        ctx.file.inAppDir("layouts"));
    if (!appSurface) return;
    return {
      AwaitExpression(node: AnyNode) {
        const call = node.argument;
        const name = ctx.helpers.getCalleeName(call);
        if (name !== "$fetch" && name !== "fetch" && name !== "axios.get") return;
        if (!isSetupScope(nearestFunctionOrProgram(node), node, ctx.file.sfc, ctx.file.scriptAst))
          return;
        report(
          ctx,
          call,
          "nuxt/fetch/no-raw-fetch-in-setup",
          "warn",
          "fetching",
          "This fetch runs in setup for SSR-rendered data. Use useFetch() or useAsyncData() to avoid duplicate fetching and hydration issues.",
          "Replace with await useFetch(...) or await useAsyncData(key, () => $fetch(...)).",
        );
      },
    };
  },
});

function isSetupScope(scope: AnyNode, node: AnyNode, sfc: AnyNode, scriptAst: AnyNode): boolean {
  if (!scope) return false;
  if (scope.type === "Program") {
    const setup = sfc?.descriptor?.scriptSetup;
    const start = node?.start;
    const end = node?.end ?? start;
    return (
      typeof start === "number" &&
      typeof end === "number" &&
      typeof setup?.loc?.start?.offset === "number" &&
      typeof setup?.loc?.end?.offset === "number" &&
      start >= setup.loc.start.offset &&
      end <= setup.loc.end.offset
    );
  }
  const owner = scope.__doctorParent;
  if (owner?.type !== "Property" && owner?.type !== "MethodDefinition") return false;
  if (owner.value !== scope || owner.computed) return false;
  const key = owner.key;
  if ((key?.type === "Identifier" ? key.name : key?.value) !== "setup") return false;
  return isComponentOptions(owner.__doctorParent, scriptAst);
}

const COMPONENT_DEFINERS = new Set(["defineComponent", "defineNuxtComponent"]);

function isComponentOptions(object: AnyNode, scriptAst: AnyNode): boolean {
  if (object?.type !== "ObjectExpression") return false;
  const parent = object.__doctorParent;
  if (parent?.type === "ExportDefaultDeclaration") return true;
  if (parent?.type !== "CallExpression" || parent.arguments?.[0] !== object) return false;
  return isComponentDefiner(parent.callee, scriptAst);
}

function isComponentDefiner(callee: AnyNode, scriptAst: AnyNode): boolean {
  if (callee?.type === "Identifier") {
    if (COMPONENT_DEFINERS.has(callee.name)) return true;
    return importedComponentAliases(scriptAst).has(callee.name);
  }
  if (callee?.type !== "MemberExpression" && callee?.type !== "StaticMemberExpression")
    return false;
  if (callee.computed || callee.property?.type !== "Identifier") return false;
  if (!COMPONENT_DEFINERS.has(callee.property.name)) return false;
  return importedComponentNamespaces(scriptAst).has(callee.object?.name);
}

function importedComponentAliases(scriptAst: AnyNode): Set<string> {
  const aliases = new Set<string>();
  for (const statement of scriptAst?.body ?? []) {
    if (statement?.type !== "ImportDeclaration" || !isComponentModule(statement.source?.value))
      continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type === "ImportSpecifier" && COMPONENT_DEFINERS.has(specifier.imported?.name))
        aliases.add(specifier.local?.name);
    }
  }
  return aliases;
}

function importedComponentNamespaces(scriptAst: AnyNode): Set<string> {
  const namespaces = new Set<string>();
  for (const statement of scriptAst?.body ?? []) {
    if (statement?.type !== "ImportDeclaration" || !isComponentModule(statement.source?.value))
      continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local?.name);
    }
  }
  return namespaces;
}

function isComponentModule(source: unknown): boolean {
  return (
    typeof source === "string" &&
    (source === "vue" || source === "#app" || source.startsWith("nuxt/"))
  );
}
