import { projectFor, relativePath, reportDoctor } from "./shared.mjs";

const CODE = "VITE0001";
const WHY = "Vite cannot reliably include assets from a dynamic new URL() path.";
const ASSET_NAME = /(asset|image|img|icon|logo|sprite|src|source|media|font)/i;
const aliasCache = new WeakMap();

/**
 * Port of `vite/assets/no-dynamic-new-url`. Vite aliases can be RegExps, which JSON settings
 * cannot carry, so the inventory capture serializes them as `{ regexp: { source, flags } }`.
 */
export const noDynamicNewUrl = {
  meta: { type: "problem", docs: { url: "https://vite-doctor.onmax.me/diagnostics/VITE0001" } },
  create(context) {
    const project = projectFor(context);
    if (!project) return {};
    const path = relativePath(context, project);
    if (isToolingOrServerPath(path) || isFixturePath(path)) return {};
    const source = context.sourceCode.text;
    return {
      NewExpression(node) {
        if (node.callee?.name !== "URL") return;
        const [first, second] = node.arguments ?? [];
        if (!second || !source.slice(second.start, second.end).endsWith("import.meta.url")) return;
        if (
          staticString(first) !== null ||
          isAssetUrlTemplate(first) ||
          isConfiguredAliasTemplate(first, project)
        )
          return;
        if (!isAssetUrlContext(node)) return;
        reportDoctor(context, node, CODE, WHY);
      },
    };
  },
};

function staticString(node) {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(node.type)
  )
    node = node.expression;
  if (!node) return null;
  if (typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0)
    return String(node.quasis?.[0]?.value?.cooked ?? node.quasis?.[0]?.value?.raw ?? "");
  return null;
}

function isAssetUrlTemplate(node) {
  return (
    node?.type === "TemplateLiteral" && /^(?:\.{1,2}\/|\/)/.test(node.quasis?.[0]?.value?.raw ?? "")
  );
}

function projectAliases(project) {
  let aliases = aliasCache.get(project);
  if (!aliases) {
    aliases = (project.vite?.aliases ?? []).map((alias) =>
      alias.regexp ? new RegExp(alias.regexp.source, alias.regexp.flags) : alias.find,
    );
    aliasCache.set(project, aliases);
  }
  return aliases;
}

function isConfiguredAliasTemplate(node, project) {
  if (node?.type !== "TemplateLiteral") return false;
  const prefix = node.quasis?.[0]?.value?.raw ?? "";
  if (!prefix || /^(?:\.{1,2}\/|\/)/.test(prefix)) return false;
  return projectAliases(project).some((find) => {
    if (typeof find === "string") return prefix === find || prefix.startsWith(`${find}/`);
    if (find instanceof RegExp) return !find.global && !find.sticky && find.test(prefix);
    return false;
  });
}

function isAssetUrlContext(node) {
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator") return ASSET_NAME.test(parent.id?.name ?? "");
  if (parent?.type === "AssignmentExpression")
    return ASSET_NAME.test(parent.left?.name ?? parent.left?.property?.name ?? "");
  if (parent?.type === "CallExpression") {
    const callee = parent.callee?.name ?? parent.callee?.property?.name ?? "";
    return !["fetch", "$fetch", "open", "URL", "fileURLToPath"].includes(callee);
  }
  if (parent?.type === "MemberExpression")
    return /^(src|href|poster)$/.test(parent.property?.name ?? "");
  return false;
}

function isToolingOrServerPath(path) {
  return /(?:^|\/)(?:src\/node|server|node|packages\/vite\/src\/node)\//.test(path);
}

function isFixturePath(path) {
  return /(?:^|\/)(?:playground|fixtures?|test|tests|__tests__)\//.test(path);
}
