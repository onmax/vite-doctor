import { readFileSync } from "node:fs";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { parseScript } from "../../../core/internal/script.js";
import { parseSfcFile, parseVueScripts } from "../../../core/internal/sfc.js";
import { selectScanFiles } from "../../../core/internal/source-inventory.js";
import { diagnostics } from "../diagnostics.js";
import { findStoreDefinitions, type StoreDefinition } from "./shared.js";

interface LocatedStoreDefinition extends StoreDefinition {
  file: string;
  displayPath: string;
  range: SourceRange;
}

export const uniqueStoreId = createRule({
  meta: {
    id: "pinia/stores/unique-store-id",
    title: "Give every Pinia store a unique id",
    description: "Report possible collisions between literal store ids across the project.",
    why: "Pinia keys every store instance by its id. The first useStore() call for an id creates the store and caches it in the Pinia instance; every later useStore() call on that Pinia instance with the same id returns that cached instance without running its own setup or options. If both definitions use that instance, the second definition is silently ignored, so callers receive the first store's state, getters, and actions.",
    recommendedReplacement:
      "Give each defineStore() call its own id. If both definitions describe the same store, delete one and import the remaining composable everywhere.",
    examples: [
      {
        title: "Use one id per store",
        language: "ts",
        invalid:
          "// stores/cart.ts\nexport const useCartStore = defineStore('cart', () => { /* ... */ })\n\n// stores/checkout.ts\nexport const useCheckoutStore = defineStore('cart', () => { /* ... */ })",
        valid:
          "// stores/cart.ts\nexport const useCartStore = defineStore('cart', () => { /* ... */ })\n\n// stores/checkout.ts\nexport const useCheckoutStore = defineStore('checkout', () => { /* ... */ })",
      },
    ],
    category: "stores",
    severity: "error",
    fixable: false,
    diagnosticCodes: ["PINIA0001"],
    docsUrl: "https://pinia.vuejs.org/core-concepts/#Defining-a-Store",
    execution: "workspace",
    requires: { crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["ast"],
    cost: "medium",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const groups = new Map<string, LocatedStoreDefinition[]>();
        for (const definition of await collectProjectStoreDefinitions(ctx)) {
          const key = definition.id;
          groups.set(key, [...(groups.get(key) ?? []), definition]);
        }
        for (const group of groups.values()) {
          if (group.length < 2) continue;
          for (const definition of group) {
            const others = group.filter((other) => other !== definition);
            const locations = others.map(
              (other) => `${other.displayPath}:${other.range.line}:${other.range.column}`,
            );
            ctx.report(
              diagnostics.PINIA0001({
                why: `Store id "${definition.id}" is also defined at ${locations.join(", ")}. If these definitions share a Pinia instance, whichever useStore() runs first wins and the other definition never runs. This project-wide comparison does not establish which Pinia instance each definition uses.`,
                fix: `Give this store a unique id, or delete the duplicate definition and import a single composable for store "${definition.id}".`,
                sources: [
                  `${definition.displayPath}:${definition.range.line}:${definition.range.column}`,
                  ...locations,
                ],
              }),
              {
                ruleId: "pinia/stores/unique-store-id",
                severity: ctx.severity,
                category: "stores",
                file: definition.file,
                range: definition.range,
                confidence: "heuristic-medium",
                related: others.map((other) => ({
                  file: other.file,
                  range: other.range,
                  message: `Also defines Pinia store "${other.id}"`,
                })),
                evidence: [
                  {
                    kind: "ast",
                    file: definition.file,
                    range: definition.range,
                    summary: `defineStore() registers literal id "${definition.id}".`,
                  },
                  ...others.map((other) => ({
                    kind: "ast" as const,
                    file: other.file,
                    range: other.range,
                    summary: `defineStore() registers the same literal id "${other.id}".`,
                  })),
                ],
              },
            );
          }
        }
      },
    };
  },
});

async function collectProjectStoreDefinitions(ctx: RuleContext): Promise<LocatedStoreDefinition[]> {
  const root = ctx.project.root;
  const files = await selectScanFiles(root, {}, {}, ctx.project);
  const definitions: LocatedStoreDefinition[] = [];
  for (const entry of files) {
    if (entry.sourceKind === "module" || /\.mdc?$/.test(entry.path)) continue;
    const text = readFileSync(entry.path, "utf8");
    if (!text.includes("defineStore")) continue;
    const program = entry.path.endsWith(".vue")
      ? parseVueScripts(entry.path, (await parseSfcFile(entry.path, text)).descriptor, text)
      : parseScript(entry.path, text);
    for (const definition of findStoreDefinitions(program, text)) {
      definitions.push({
        ...definition,
        file: entry.path,
        displayPath: entry.displayPath,
        range: ctx.helpers.rangeFromOffsets(entry.path, text, definition.idStart, definition.idEnd),
      });
    }
  }
  return definitions;
}
