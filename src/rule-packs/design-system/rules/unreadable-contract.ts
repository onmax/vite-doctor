import { createRule } from "../../../core/index.js";
import { componentNames, contractKeys, projectContracts } from "../contracts.js";
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
          const keys = contractKeys()
            .map((key) => `\`${key}\``)
            .join(", ");
          const fix =
            entry.cause === "overridden"
              ? `Move the spread or computed key before \`doctor\` in the options object, or remove it, so the literal \`doctor\` value is the one Vue keeps.`
              : entry.cause === "overridden-by-setup"
                ? "Put the literal `doctor` option last in `defineOptions`, after the shared options. If the argument is a reference, spread it into the options object first: `defineOptions({ ...shared, doctor: { /* your contract */ } })`."
                : entry.cause === "invalid"
                  ? entry.remedy
                  : `Write the \`doctor\` option as an object literal whose keys (${keys}) hold literal values only: no variables, function calls, spreads, or computed keys.`;
          ctx.report(
            diagnostics.DS0009({
              why: `Doctor cannot read the Component Contract of ${entry.component} because ${entry.reason}. Doctor ignores the whole contract, so the design-system Rules that read Component Contracts check nothing ${entry.component} declares, and raw elements elsewhere in the app keep drifting from it.`,
              fix,
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
