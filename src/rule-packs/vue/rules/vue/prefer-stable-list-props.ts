import type { ComponentFacts, ComponentUsageFact } from "../../../../core/index.js";
import { camelize, displayName, propReference } from "./component-usage.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/perf/prefer-stable-list-props";
const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const LITERAL_NAMES = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

export const preferStableListProps = createRule({
  meta: {
    id: RULE_ID,
    title: "Pass list items a computed comparison",
    category: "performance",
    severity: "info",
    fixable: false,
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph"],
    cost: "small",
    docsUrl: "https://vuejs.org/guide/best-practices/performance.html#props-stability",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        for (const parent of graph.components.values()) {
          if (parent.sourceKind === "module") continue;
          for (const edge of parent.renders) {
            const child = edge.target ? graph.components.get(edge.target) : undefined;
            if (!edge.usage.inFor || !child?.facts.props) continue;
            for (const unstable of unstableBindings(edge.usage, child.facts)) {
              const childName = displayName(child);
              const suggested = `:${suggestedPropName(unstable.prop)}="${unstable.itemExpression} === ${unstable.expression}"`;
              ctx.report(
                diagnostics.VUE0040({
                  why: `Every <${childName}> rendered by this v-for receives the same "${unstable.expression}" as prop "${unstable.prop}", and ${childName} compares it with its own "${unstable.itemProp}" prop. Vue re-renders a child when any prop it receives changes, so each change to ${unstable.expression} re-renders every item in the list, although only the items whose comparison result flips have anything new to show.`,
                  fix: `Compare in the parent and pass the result: replace :${unstable.binding}="${unstable.expression}" with a boolean prop such as ${suggested}, and have ${childName} read that prop instead of comparing "${unstable.prop}" with "${unstable.itemProp}".`,
                }),
                {
                  file: parent.file,
                  range: unstable.range,
                  confidence: "heuristic-high",
                  evidence: [
                    {
                      kind: "facts",
                      file: child.file,
                      summary: `${childName} compares props "${unstable.prop}" and "${unstable.itemProp}".`,
                    },
                  ],
                  related: [
                    {
                      file: child.file,
                      message: `${childName} compares "${unstable.prop}" with "${unstable.itemProp}"`,
                    },
                  ],
                },
              );
            }
          }
        }
      },
    };
  },
});

interface UnstableBinding {
  binding: string;
  prop: string;
  expression: string;
  itemProp: string;
  itemExpression: string;
  range: ComponentUsageFact["range"];
}

function unstableBindings(usage: ComponentUsageFact, child: ComponentFacts): UnstableBinding[] {
  const scope = new Set(usage.scope);
  const perItem = new Map<string, string>();
  const shared: Array<{
    binding: string;
    prop: string;
    expression: string;
    range: ComponentUsageFact["range"];
  }> = [];
  for (const binding of usage.bindings) {
    if (binding.model) continue;
    const prop = camelize(binding.name);
    const identifiers = binding.expression.match(IDENTIFIER) ?? [];
    const root = identifiers[0];
    if (root !== undefined && scope.has(root)) {
      perItem.set(prop, binding.expression);
      continue;
    }
    const expression = binding.expression.trim();
    if (!MEMBER_PATH.test(expression) || !root || LITERAL_NAMES.has(root)) continue;
    shared.push({ binding: binding.name, prop, expression, range: binding.range });
  }
  const results: UnstableBinding[] = [];
  for (const candidate of shared) {
    for (const [itemProp, itemExpression] of perItem) {
      if (itemProp === candidate.prop || !comparesProps(child, candidate.prop, itemProp)) continue;
      results.push({ ...candidate, itemProp, itemExpression });
      break;
    }
  }
  return results;
}

function comparesProps(child: ComponentFacts, first: string, second: string): boolean {
  return child.comparisons.some((comparison) => {
    const left = operandProp(child, comparison.left, comparison.in);
    const right = operandProp(child, comparison.right, comparison.in);
    return (left === first && right === second) || (left === second && right === first);
  });
}

function operandProp(
  facts: ComponentFacts,
  operand: string,
  where: "script" | "template",
): string | undefined {
  if (where === "template") return propReference(facts, operand);
  if (!operand.includes(".")) {
    const aliased = facts.propAliases?.[operand];
    return aliased && facts.props?.some((prop) => prop.name === aliased) ? aliased : undefined;
  }
  return facts.propsBinding && operand.startsWith(`${facts.propsBinding}.`)
    ? propReference(facts, operand)
    : undefined;
}

function suggestedPropName(prop: string): string {
  const base = prop.replace(/Id$/, "");
  const name = base && base !== prop ? base : `is-${prop}`;
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
