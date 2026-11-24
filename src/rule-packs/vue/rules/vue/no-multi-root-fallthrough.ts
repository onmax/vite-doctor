import type { ComponentFacts, ComponentUsageFact, SourceRange } from "../../../../core/index.js";
import { diagnostics } from "../../diagnostics.js";
import { camelize, displayName } from "./component-usage.js";
import { createRule } from "./shared.js";

const RULE_ID = "vue/attrs/no-multi-root-fallthrough";

// Vue keeps these off `attrs`: runtime-core `isReservedProp`, plus `vue:` vnode hooks.
const RESERVED = new Set(["key", "ref", "ref_for", "ref_key"]);

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
            ctx.report(
              diagnostics.VUE0051({
                why: `<${edge.usage.tag}> passes ${names} to ${name}, which declares none of them as props or emits. ${name} renders ${facts.rootNodes} root nodes and neither binds $attrs nor sets inheritAttrs: false, so Vue cannot tell which root should receive them: it drops them and warns "Extraneous non-props attributes were passed to component but could not be automatically inherited because component renders fragment or text or teleport root nodes".`,
                fix: `Bind the attributes on the root of ${name} that should receive them with v-bind="$attrs", wrap its template in one root element, or declare them as props or emits. If ${name} should not receive them, remove them from this usage.`,
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
): Array<{ name: string; range: SourceRange }> {
  if (!facts.props) return [];
  const props = new Set(facts.props.map((prop) => prop.name));
  for (const model of facts.models) {
    props.add(model.name);
    props.add(model.name === "modelValue" ? "modelModifiers" : `${model.name}Modifiers`);
  }
  const dropped: Array<{ name: string; range: SourceRange }> = [];
  for (const { name, range } of [...usage.attributes, ...usage.bindings]) {
    if (!RESERVED.has(name) && !props.has(camelize(name))) dropped.push({ name, range });
  }
  if (facts.emits) {
    const emits = new Set(facts.emits.map(camelize));
    for (const { event, range } of usage.listeners) {
      // Vue never warns about `update:*` model listeners; `vue:` and `vnode-` are vnode hooks.
      if (/^(?:update:|vue:|vnode-?[A-Za-z])/.test(event)) continue;
      const key = camelize(event);
      const handlerProp = `on${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      if (!emits.has(key) && !props.has(handlerProp)) dropped.push({ name: `@${event}`, range });
    }
  }
  return dropped.sort((a, b) => a.range.start - b.range.start);
}
