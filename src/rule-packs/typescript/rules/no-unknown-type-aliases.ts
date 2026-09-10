import { createRule } from "../../../core/index.js";
import { report, type AnyNode } from "./shared.js";

import { createTypeAliasResolver } from "./type-aliases.js";

const ruleId = "typescript/evidence/no-unknown-type-aliases";

export const noUnknownTypeAliases = createRule({
  meta: {
    id: "typescript/evidence/no-unknown-type-aliases",
    title: "Keep unknown visible at its boundary",
    description: "Reject type aliases that only conceal TypeScript's unknown type.",
    why: "Renaming unknown makes an unparsed value look like a domain contract without adding evidence. Callers still cannot use the value safely, but the alias hides where parsing belongs.",
    recommendedReplacement:
      "Keep unknown explicit at the input boundary, then return a parsed owner type.",
    examples: [
      {
        title: "Parse an external value",
        language: "ts",
        invalid: "type ExternalUser = unknown",
        valid: "type User = z.infer<typeof UserSchema>",
      },
    ],
    category: "evidence",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://github.com/dmmulroy/anti-slop#no-unknown-type-aliases",
    requires: { script: true },
    aiGeneratedCodeRisk: "high",
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const resolver = createTypeAliasResolver(node);
        for (const declaration of resolver.aliases) {
          if (!resolver.resolvesToKeyword(declaration.typeAnnotation, "TSUnknownKeyword")) continue;
          report(
            ctx,
            declaration.id,
            ruleId,
            `Type alias "${declaration.id.name}" hides an unknown value without parsing it.`,
            "Keep unknown explicit at the boundary or replace the alias with the parsed owner type.",
          );
        }
      },
    };
  },
});
