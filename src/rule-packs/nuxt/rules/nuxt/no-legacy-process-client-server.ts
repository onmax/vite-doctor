import * as typescriptParser from "@typescript-eslint/parser";
import { parseForESLint as parseVueForESLint } from "vue-eslint-parser";
import type { RuleContext } from "../../../../core/index.js";
import { AnyNode, createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const noLegacyProcessClientServer = createRule({
  meta: {
    id: "nuxt/context/no-legacy-process-client-server",
    title: "Use import.meta client/server flags",
    category: "context",
    severity: "warn",
    fixable: "safe",
    docsUrl: "https://nuxt.com/docs/4.x/api/advanced/import-meta#runtime-app-properties",
    requires: { script: true, nuxt: true },
    applicability: { nuxtCompatibility: ">=5" },
  },
  create(ctx) {
    let globalProcessReferences: Set<number> | undefined;
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type !== "MemberExpression" ||
          node.computed ||
          node.optional ||
          node.object?.type !== "Identifier" ||
          node.object.name !== "process" ||
          node.property?.type !== "Identifier" ||
          !["client", "server"].includes(node.property.name)
        )
          return;
        if (!(globalProcessReferences ??= findGlobalProcessReferences(ctx)).has(node.object.start))
          return;
        const name = `process.${node.property.name}`;
        const replacement = `import.meta.${node.property.name}`;
        ctx.report(
          diagnostics.NUXT0021({
            why: `${name} loses its Nuxt type augmentation under Nuxt compatibility 5.`,
            fix: `Use ${replacement}.`,
          }),
          {
            ruleId: "nuxt/context/no-legacy-process-client-server",
            severity: "warn",
            category: "context",
            file: ctx.file.path,
            range: ctx.range(node),
            fix: {
              kind: "safe",
              edits: [{ range: { start: node.start, end: node.end }, text: replacement }],
            },
          },
        );
      },
    };
  },
});

function findGlobalProcessReferences(ctx: RuleContext): Set<number> {
  try {
    const options = {
      range: true,
      sourceType: "module" as const,
      ecmaFeatures: { jsx: true },
    };
    const { scopeManager } = ctx.file.sfc
      ? parseVueForESLint(ctx.file.text, {
          ...options,
          parser: typescriptParser,
          ecmaVersion: "latest",
        })
      : typescriptParser.parseForESLint(ctx.file.text, options);
    return new Set(
      scopeManager?.globalScope?.through
        .filter((reference) => reference.identifier.name === "process")
        .flatMap((reference) => reference.identifier.range?.slice(0, 1) ?? []),
    );
  } catch {
    return new Set();
  }
}
