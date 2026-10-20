import type { ComponentNode, ComponentUsageEdge } from "../../../../core/index.js";
import {
  displayName,
  isPackageComponent,
  isPropsObject,
  propReference,
  reemittedEvent,
} from "./component-usage.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/component/no-prop-relay";
const PASSTHROUGH_SPREADS = new Set(["$attrs", "attrs"]);

interface Relay {
  child: ComponentUsageEdge;
  childName: string;
  props: string[];
  declared: number;
  events: string[];
}

export const noPropRelay = createRule({
  meta: {
    id: RULE_ID,
    title: "Avoid components that only relay props",
    category: "architecture",
    severity: "info",
    fixable: false,
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts"],
    cost: "small",
    docsUrl:
      "https://github.com/vuejs-ai/skills/blob/main/skills/vue-best-practices/references/component-data-flow.md#diagnose-forwarding-before-choosing-a-transport",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        for (const node of graph.components.values()) {
          if (node.sourceKind === "module") continue;
          const relay = findRelay(node, graph.components);
          if (!relay || isPackageComponent(ctx, node.file)) continue;
          const name = displayName(node);
          const forwarded = relay.events.length
            ? ` and re-emits ${relay.events.map((event) => `"${event}"`).join(", ")} from it unchanged`
            : "";
          ctx.report(
            diagnostics.VUE0038({
              why: `${name} declares ${relay.declared} props, passes ${relay.props.length} of them (${relay.props.join(", ")}) straight to <${relay.childName}>${forwarded}, and adds no markup, logic, or defaults of its own. Each render creates an extra component instance, and ${name} repeats ${relay.childName}'s props and events, so every change to that contract has to be made twice.`,
              fix: `Render <${relay.childName}> directly where ${name} is used and delete the wrapper, or merge ${name} into ${relay.childName} if it is the only caller. Pass content through slots instead of props where callers own it. If the props only travel through to reach a deeper descendant, move that state to the component that owns the interaction, and use provide/inject only for state several descendants share.`,
            }),
            {
              file: node.file,
              range: relay.child.usage.range,
              confidence: "heuristic-high",
              evidence: [
                {
                  kind: "facts",
                  file: node.file,
                  range: relay.child.usage.range,
                  summary: `The template renders only <${relay.childName}>, bound to ${relay.props.length} of ${relay.declared} declared props.`,
                },
              ],
              related: relay.child.target
                ? [
                    {
                      file: relay.child.target,
                      message: `${relay.childName} receives the relayed props`,
                    },
                  ]
                : undefined,
            },
          );
        }
      },
    };
  },
});

function findRelay(
  node: ComponentNode,
  components: ReadonlyMap<string, ComponentNode>,
): Relay | undefined {
  const facts = node.facts;
  if (!facts.props || facts.ownLogic || facts.ownMarkup) return undefined;
  if (facts.rootNodes !== 1 || node.renders.length !== 1) return undefined;
  const child = node.renders[0]!;
  const target = child.target ? components.get(child.target) : undefined;
  if (!target || target === node) return undefined;
  const usage = child.usage;
  if (usage.attributes.length || usage.directives.some((directive) => directive !== "slot"))
    return undefined;
  if (facts.props.some((prop) => prop.default) || facts.models.some((model) => model.default))
    return undefined;
  const declared = [
    ...facts.props.map((prop) => prop.name),
    ...facts.models.map((model) => model.name),
  ];
  const relayed = new Set<string>();
  for (const spread of usage.spreads) {
    if (spread.directive === "bind" && isPropsObject(facts, spread.expression)) {
      for (const prop of facts.props) relayed.add(prop.name);
      continue;
    }
    if (!PASSTHROUGH_SPREADS.has(spread.expression)) return undefined;
  }
  for (const binding of usage.bindings) {
    const model = binding.model
      ? facts.models.find((item) => item.binding === binding.expression)
      : undefined;
    const prop =
      model?.name ?? (binding.model ? undefined : propReference(facts, binding.expression));
    if (!prop) return undefined;
    relayed.add(prop);
  }
  const events: string[] = [];
  for (const listener of usage.listeners) {
    const event = reemittedEvent(facts, listener.expression);
    if (!event) return undefined;
    events.push(event);
  }
  if (relayed.size < 2 || relayed.size * 2 <= declared.length) return undefined;
  return {
    child,
    childName: displayName(target),
    props: [...relayed],
    declared: declared.length,
    events,
  };
}
