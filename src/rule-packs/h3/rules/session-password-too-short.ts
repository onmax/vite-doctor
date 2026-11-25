import type { RuleContext } from "../../../core/index.js";
import { propertyKey, resolveVariable, staticValue, unwrapExpression } from "./_errors-helpers.js";
import { type AnyNode, createRule, h3ExportName, isH3HandlerFile, report } from "./shared.js";

const ruleId = "h3/security/session-password-too-short";
// iron-webcrypto's default `minPasswordlength` for both encryption and integrity keys.
const minPasswordLength = 32;
// Each takes the session config as its second argument; clearSession() never reads the password.
const sessionUtils = new Set([
  "useSession",
  "getSession",
  "updateSession",
  "sealSession",
  "unsealSession",
]);

export const sessionPasswordTooShort = createRule({
  meta: {
    id: "h3/security/session-password-too-short",
    title: "Use a session password of at least 32 characters",
    description:
      "Flags a literal session password shorter than 32 characters passed to useSession(), getSession(), updateSession(), sealSession(), or unsealSession().",
    why: 'H3 seals sessions with iron-webcrypto, which rejects passwords under 32 characters. Every session read or write then throws "Password string too short", and a short literal password is a weak, committed secret anyway.',
    recommendedReplacement:
      "Read a secret of at least 32 characters from runtime configuration or an environment variable instead of a literal.",
    category: "security",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/utils/session",
    requires: { script: true },
    prefilter: { names: ["password"] },
  },
  create(ctx) {
    if (!isH3HandlerFile(ctx)) return;
    return {
      CallExpression(node: AnyNode) {
        const name = h3ExportName(ctx, node.callee);
        if (!name || !sessionUtils.has(name)) return;
        const argument = unwrapExpression(node.arguments?.[1]);
        const config = argument?.type === "Identifier" ? constObject(ctx, argument) : argument;
        if (config?.type !== "ObjectExpression") return;
        let password: AnyNode;
        for (const property of config.properties ?? []) {
          const key = propertyKey(property);
          // A spread may carry its own password, and `seal` options can lower the minimum length.
          if (!key || key === "seal") return;
          if (key === "password") password = property.value;
        }
        const value = password && staticValue(ctx, password);
        if (typeof value !== "string" || value.length >= minPasswordLength) return;
        report(
          ctx,
          config === argument ? password : argument,
          ruleId,
          "error",
          "security",
          `This ${name}() password is ${value.length} characters long. iron-webcrypto requires at least ${minPasswordLength}, so sealing the session throws "Password string too short" and existing sessions never unseal.`,
          "Read a secret of at least 32 characters from runtime configuration or an environment variable, such as useRuntimeConfig(event).sessionPassword or process.env.SESSION_PASSWORD.",
        );
      },
    };
  },
});

/** The object literal a never-reassigned `const` in this file is initialized with. */
function constObject(ctx: RuleContext, identifier: AnyNode): AnyNode {
  const variable = resolveVariable(ctx, identifier);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type !== "Variable" || definition.parent?.kind !== "const") return null;
  if (definition.node.id?.type !== "Identifier") return null;
  const init = unwrapExpression(definition.node.init);
  return init?.type === "ObjectExpression" ? init : null;
}
