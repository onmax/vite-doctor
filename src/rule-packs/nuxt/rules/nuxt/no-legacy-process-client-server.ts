import type { SFCBlock, SFCDescriptor } from "@vue/compiler-sfc";
import type { RuleContext } from "../../../../core/index.js";
import { scriptScope, type ScriptScope } from "../../../../core/internal/script-scope.js";
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
      MemberExpression(node: AnyNode) {
        if (
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
    const descriptor = ctx.file.sfc?.descriptor as SFCDescriptor | undefined;
    if (!descriptor) {
      return new Set(
        collectGlobalProcessReferences(
          parse(ctx, ctx.file.text, /\.[jt]sx$/.test(ctx.file.relativePath)),
        ),
      );
    }
    const normal = descriptor.script ? parseVueBlock(ctx, descriptor.script) : undefined;
    const setup = descriptor.scriptSetup ? parseVueBlock(ctx, descriptor.scriptSetup) : undefined;
    const normalHasProcessBinding = normal?.scopeManager.scopes
      .find((scope) => scope.type === "module")
      ?.variables.some((variable) => variable.name === "process");
    const refs = new Set([
      ...collectGlobalProcessReferences(normal, descriptor.script),
      ...(normalHasProcessBinding
        ? []
        : collectGlobalProcessReferences(setup, descriptor.scriptSetup)),
    ]);
    return refs;
  } catch {
    return new Set();
  }
}

function parse(ctx: RuleContext, text: string, jsx: boolean): ScriptScope {
  const parsed = scriptScope(ctx, text, jsx ? "tsx" : "ts");
  if (!parsed) throw new SyntaxError("Cannot parse the script.");
  return parsed;
}

function parseVueBlock(ctx: RuleContext, block: SFCBlock) {
  return parse(ctx, block.content, ["jsx", "tsx"].includes(block.lang ?? ""));
}

function collectGlobalProcessReferences(parsed: ScriptScope | undefined, block?: SFCBlock | null) {
  if (!parsed) return [];
  const offset = block?.loc.start.offset ?? 0;
  const references =
    parsed.scopeManager?.globalScope?.through
      .filter((reference) => reference.identifier.name === "process")
      .flatMap((reference) => {
        const range = reference.identifier.range;
        return range ? [range[0] + offset] : [];
      }) ?? [];
  if (
    references.length ||
    parsed.scopeManager.scopes.some((scope) =>
      scope.variables.some((variable) => variable.name === "process"),
    )
  )
    return references;
  const source = block?.content ?? "";
  return [...source.matchAll(/\bprocess\.(?:client|server)\b/g)].map(
    (match) => match.index! + offset,
  );
}
