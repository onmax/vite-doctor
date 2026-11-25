import type { RuleContext } from "../../../core/index.js";
import { propertyKey, resolveVariable, staticValue, unwrapExpression } from "./_errors-helpers.js";
import { type AnyNode, createRule, h3ExportName, isH3HandlerFile, report } from "./shared.js";

const ruleId = "h3/security/session-password-too-short";
// iron-webcrypto's default `minPasswordlength` for both encryption and integrity keys.
const minPasswordLength = 32;
// Each takes the session config as its second argument; clearSession() never reads the password.
const sessionUtils = new Set(["useSession", "updateSession", "sealSession"]);

export const sessionPasswordTooShort = createRule({
  meta: {
    id: "h3/security/session-password-too-short",
    title: "Use a session password of at least 32 characters",
    description:
      "Flags a literal password shorter than 32 characters in session calls that can seal a session.",
    why: 'When H3 seals a session, iron-webcrypto rejects short passwords with "Password string too short". Reading an existing session does not necessarily seal it.',
    recommendedReplacement:
      "Read a secret of at least 32 characters from runtime configuration or an environment variable instead of a literal.",
    category: "security",
    severity: "error",
    confidence: "heuristic-high",
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
        let cookie: AnyNode;
        for (const property of config.properties ?? []) {
          const key = propertyKey(property);
          // A spread may carry its own password, and `seal` options can lower the minimum length.
          if (!key || key === "seal") return;
          if (key === "password") password = property.value;
          if (key === "cookie") cookie = property.value;
        }
        const cookieValue = cookie && staticValue(ctx, cookie);
        if (name !== "sealSession" && cookieValue === false) return;
        const value = password && staticValue(ctx, password);
        if (typeof value !== "string" || value.length >= minPasswordLength) return;
        report(
          ctx,
          config === argument ? password : argument,
          ruleId,
          "error",
          "security",
          `This ${name}() password is ${value.length} characters long. If this call seals a session, iron-webcrypto requires at least ${minPasswordLength} characters and rejects this password.`,
          "Read a secret of at least 32 characters from runtime configuration or an environment variable, such as useRuntimeConfig(event).sessionPassword or process.env.SESSION_PASSWORD.",
        );
      },
    };
  },
});

function constObject(ctx: RuleContext, identifier: AnyNode): AnyNode {
  const variable = resolveVariable(ctx, identifier);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type !== "Variable" || definition.parent?.kind !== "const") return null;
  if (definition.node.id?.type !== "Identifier") return null;
  const start = identifier.start ?? identifier.range?.[0];
  if (
    variable?.references.some(
      (reference) => !reference.init && reference.identifier.range[0] !== start,
    )
  )
    return null;
  const init = unwrapExpression(definition.node.init);
  return init?.type === "ObjectExpression" ? init : null;
}
