import { diagnostics } from "../../diagnostics.js";
import { AnyNode, createRule, report } from "./shared.js";

const SECRET_NAME = /(?:secret|password|passwd|token|private)$/i;
const SECRET_KEY_NAME =
  /(?:secret|private|service|servicerole|admin|master|signing|encryption|access|write|webhook)_?key$/i;
// Public-by-design credentials: publishable, site, widget, anon, and search-only keys.
const PUBLIC_KEY_QUALIFIER = /publishable|public|site|widget|project|anon|client|browser|search/i;

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
      Property(node: AnyNode) {
        const key = staticKey(node);
        if (typeof key !== "string") return;
        const kind = secretKind(key);
        if (!kind || !isInPublicRuntimeConfig(node)) return;
        if (kind === "secret") {
          report(
            ctx,
            node,
            "nuxt/runtime/no-secret-in-public-config",
            "error",
            "runtime-config",
            `runtimeConfig.public.${key} looks sensitive and will be exposed to the client. Move it to private runtimeConfig.`,
            `Move runtimeConfig.public.${key} to private runtimeConfig or remove the secret.`,
          );
          return;
        }
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0054({
            why: `runtimeConfig.public.${key} is exposed to the client. That is fine for browser keys such as Firebase or Algolia search keys, but server API keys must stay private.`,
            fix: `If runtimeConfig.public.${key} is a server API key, move it to private runtimeConfig and call the API from a server route.`,
          }),
          {
            ruleId: "nuxt/runtime/no-secret-in-public-config",
            severity: "warn",
            category: "runtime-config",
            confidence: "heuristic-low",
          },
        );
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

function secretKind(key: string): "secret" | "api-key" | undefined {
  if (SECRET_NAME.test(key) || SECRET_KEY_NAME.test(key)) return "secret";
  if (/api_?key$/i.test(key) && !PUBLIC_KEY_QUALIFIER.test(key)) return "api-key";
}
