import {
  displayName,
  isPackageComponent,
  mayRenderUnresolved,
  passedProps,
  unresolvedTagNames,
} from "./component-usage.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/props/no-unpassed-props";

export const noUnpassedProps = createRule({
  meta: {
    id: RULE_ID,
    title: "Remove props no caller passes",
    category: "architecture",
    severity: "info",
    fixable: false,
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph"],
    cost: "small",
    docsUrl: "https://vuejs.org/guide/components/props.html",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        const unresolved = unresolvedTagNames(graph);
        for (const node of graph.components.values()) {
          const props = node.facts.props;
          if (!props?.length || !node.callers.length || node.sourceKind === "module") continue;
          if (node.indirectImporters.length || mayRenderUnresolved(node, unresolved)) continue;
          if (
            node.callers.some((edge) =>
              edge.usage.spreads.some((spread) => spread.directive === "bind"),
            )
          )
            continue;
          if (isPackageComponent(ctx, node.file)) continue;
          const passed = new Set<string>();
          for (const edge of node.callers)
            for (const name of passedProps(edge.usage)) passed.add(name);
          const name = displayName(node);
          const callerFiles = [...new Set(node.callers.map((edge) => edge.from))];
          for (const prop of props) {
            if (passed.has(prop.name)) continue;
            const value = prop.default ? "its default value" : "undefined";
            ctx.report(
              diagnostics.VUE0039({
                why: `No caller passes prop "${prop.name}" to ${name}: Doctor resolved ${node.callers.length} ${node.callers.length === 1 ? "usage" : "usages"} in ${callerFiles.length} ${callerFiles.length === 1 ? "file" : "files"}, none of which binds it or spreads props into ${name}. Every instance renders with ${value}, so the prop is contract surface and branching that no caller exercises.`,
                fix: `Remove "${prop.name}" from ${name}'s defineProps and use ${prop.default ? "the default value directly" : "the value it always has"} in the component, or pass it from the caller that needs it. Keep it if ${name} is rendered from code Doctor cannot see, such as another package or a render function.`,
              }),
              {
                file: node.file,
                range: prop.range,
                confidence: "heuristic-medium",
                evidence: [
                  {
                    kind: "graph",
                    file: node.file,
                    range: prop.range,
                    summary: `${name} has ${node.callers.length} resolved template usages and no indirect importers; none passes "${prop.name}".`,
                  },
                ],
                related: node.callers.slice(0, 5).map((edge) => ({
                  file: edge.from,
                  range: edge.usage.range,
                  message: `Renders ${name} without "${prop.name}"`,
                })),
              },
            );
          }
        }
      },
    };
  },
});
