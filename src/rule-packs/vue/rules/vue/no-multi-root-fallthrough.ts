import type { ComponentFacts, ComponentUsageFact, SourceRange } from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { camelize, displayName } from "./component-usage.js";
import { createRule } from "./shared.js";

const RULE_ID = "vue/attrs/no-multi-root-fallthrough";

const RESERVED = new Set([
  "",
  "key",
  "ref",
  "ref_for",
  "ref_key",
  "onVnodeBeforeMount",
  "onVnodeMounted",
  "onVnodeBeforeUpdate",
  "onVnodeUpdated",
  "onVnodeBeforeUnmount",
  "onVnodeUnmounted",
]);

export const noMultiRootFallthrough = createRule({
  meta: {
    id: RULE_ID,
    title: "Give fallthrough attributes a root on multi-root components",
    category: "attrs",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: false,
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph"],
    cost: "small",
    docsUrl:
      "https://vuejs.org/guide/components/attrs.html#attribute-inheritance-on-multiple-root-nodes",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        for (const node of graph.components.values()) {
          const facts = node.facts;
          if (facts.rootNodes < 2 || facts.inheritAttrs !== true || facts.readsAttrs) continue;
          for (const edge of node.callers) {
            const dropped = fallthroughAttributes(facts, edge.usage);
            if (!dropped.length) continue;
            const name = displayName(node);
            const names = dropped.map((attribute) => attribute.name).join(", ");
            const hasListeners = dropped.some((attribute) => attribute.listener);
            ctx.report(
              diagnostics.VUE0051({
                why: `<${edge.usage.tag}> passes ${names} to ${name}, which declares none of them as props or emits. ${name} renders ${facts.rootNodes} root nodes without reading $attrs or disabling inheritance, so Vue does not automatically attach them to a root and warns in development.${hasListeners ? " A component emit can still invoke its caller's listener even if Vue cannot attach that listener to a DOM root." : ""}`,
                fix: `Bind $attrs on the root of ${name} that should receive them, or wrap its template in one root element. Declare inputs the component consumes as props.${hasListeners ? " If a listener handles an event the component emits, declare the event in emits and keep the caller's handler." : ""}`,
              }),
              {
                file: edge.from,
                range: dropped[0]!.range,
                confidence: "heuristic-high",
                evidence: [
                  {
                    kind: "graph",
                    file: node.file,
                    range: facts.roots[1]?.branches[0]?.range,
                    summary: `${name} has ${facts.rootNodes} template root nodes, does not read $attrs, and keeps inheritAttrs on.`,
                  },
                ],
                related: [
                  {
                    file: node.file,
                    range: facts.roots[0]?.branches[0]?.range,
                    message: `${name} renders ${facts.rootNodes} root nodes`,
                  },
                ],
              },
            );
          }
        }
      },
    };
  },
});

/**
 * Attributes and listeners a usage passes that Vue puts in the component's `attrs`, as written.
 * Spreads are skipped because their keys are unknown; listeners are skipped when the emits are.
 */
function fallthroughAttributes(
  facts: ComponentFacts,
  usage: ComponentUsageFact,
): Array<{ name: string; range: SourceRange; listener: boolean }> {
  if (!facts.props) return [];
  const props = new Set(facts.props.map((prop) => prop.name));
  for (const model of facts.models) {
    props.add(camelize(model.name));
    props.add(model.name === "modelValue" ? "modelModifiers" : camelize(`${model.name}Modifiers`));
  }
  const emits = facts.emits && new Set(facts.emits);
  const candidates = [
    ...usage.attributes.map(({ name, range }) => ({ name, vnodeKey: name, range })),
    ...usage.bindings,
    ...usage.listeners.map(({ event, modifiers, vnodeKey, range }) => ({
      name: `@${[event, ...modifiers].join(".")}`,
      vnodeKey,
      range,
    })),
  ];
  const dropped: Array<{ name: string; range: SourceRange; listener: boolean }> = [];
  for (const { name, vnodeKey, range } of candidates) {
    if (RESERVED.has(vnodeKey) || props.has(camelize(vnodeKey))) continue;
    const listener = /^on[^a-z]/.test(vnodeKey);
    if (listener && (!emits || isEmitListener(emits, vnodeKey) || vnodeKey.startsWith("onUpdate:")))
      continue;
    dropped.push({ name, range, listener });
  }
  return dropped.sort((a, b) => a.range.start - b.range.start);
}

function isEmitListener(emits: Set<string>, key: string): boolean {
  const handler = key.slice(2);
  const name = handler === "Once" ? handler : handler.replace(/Once$/, "");
  return (
    emits.has(name.charAt(0).toLowerCase() + name.slice(1)) ||
    emits.has(name.replace(/\B([A-Z])/g, "-$1").toLowerCase()) ||
    emits.has(name)
  );
}
