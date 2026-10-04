import { AnyNode, createRule, report } from "./shared.js";

export const noSecretInPublicConfig = createRule({
  meta: {
    id: "nuxt/runtime/no-secret-in-public-config",
    title: "Do not expose secrets in runtimeConfig.public",
    category: "runtime-config",
    severity: "error",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/going-further/runtime-config#exposing",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Property") return;
        const key = staticKey(node);
        if (typeof key === "string" && /(secret|token|password|private|key)$/i.test(key)) {
          if (isInPublicRuntimeConfig(node)) {
            report(
              ctx,
              node,
              "nuxt/runtime/no-secret-in-public-config",
              "error",
              "runtime-config",
              `runtimeConfig.public.${key} looks sensitive and will be exposed to the client. Move it to private runtimeConfig.`,
              `Move runtimeConfig.public.${key} to private runtimeConfig or remove the secret.`,
            );
          }
        }
      },
    };
  },
});

function isInPublicRuntimeConfig(node: AnyNode): boolean {
  let current = node;
  while (current) {
    if (current.type === "Property" && staticKey(current) === "public") {
      let owner = current.__doctorParent?.__doctorParent;
      while (isTypeWrapper(owner)) owner = owner.__doctorParent;
      if (owner?.type === "Property" && staticKey(owner) === "runtimeConfig") return true;
    }
    const parent = current.__doctorParent;
    if (
      parent &&
      !["Property", "ObjectExpression", "ArrayExpression", "SpreadElement"].includes(parent.type) &&
      !isTypeWrapper(parent)
    )
      return false;
    current = parent;
  }
  return false;
}

function staticKey(property: AnyNode): string | undefined {
  const key = property.key;
  if (!property.computed && key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  if (key?.type === "TemplateLiteral" && key.expressions.length === 0)
    return key.quasis[0]?.value.cooked ?? undefined;
}

function isTypeWrapper(node: AnyNode): boolean {
  return [
    "TSAsExpression",
    "TSSatisfiesExpression",
    "TSNonNullExpression",
    "ParenthesizedExpression",
  ].includes(node?.type);
}
