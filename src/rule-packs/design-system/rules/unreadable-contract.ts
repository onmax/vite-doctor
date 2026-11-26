import { createRule } from "../../../core/index.js";
import { componentNames, projectContracts } from "../contracts.js";
import { diagnostics } from "../diagnostics.js";

export const unreadableContract = createRule({
  meta: {
    id: "design-system/unreadable-contract",
    title: "Write Component Contracts as literals",
    description:
      "Finds `defineOptions({ doctor })` values Doctor cannot read as a Component Contract.",
    category: "ui",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://vite-doctor.onmax.me/design-system#component-contracts",
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph"],
    cost: "small",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        const { unreadable } = projectContracts(graph, componentNames(ctx.project, graph));
        for (const entry of unreadable) {
          const node = graph.components.get(entry.file);
          if (node?.sourceKind === "module") continue;
          ctx.report(
            diagnostics.DS0009({
              why: `Doctor cannot read the Component Contract of ${entry.component} because ${entry.reason}. Without it, design-system/prefer-project-component cannot point raw elements elsewhere in the app to ${entry.component}, so they keep drifting from it.`,
              fix: `Write the \`doctor\` option as a literal object, such as \`defineOptions({ doctor: { replaces: "button" } })\`, with \`replaces\` set to the HTML tag or tags ${entry.component} stands in for.`,
            }),
            {
              file: entry.file,
              range: entry.range,
              evidence: [
                {
                  kind: "facts",
                  file: entry.file,
                  range: entry.range,
                  summary: `${entry.component} sets a \`doctor\` option Doctor cannot evaluate statically.`,
                },
              ],
            },
          );
        }
      },
    };
  },
});
