import { relative, resolve } from "pathe";
import type {
  ComponentNode,
  ComponentRootFact,
  ComponentUsageEdge,
  RuleContext,
} from "../../../../core/index.js";
import { projectNuxtInventories } from "../../../../core/internal/workspace-nuxt.js";
import { diagnostics } from "../../diagnostics.js";
import { displayName } from "./component-usage.js";
import { parserMovesChild } from "./html-nesting.js";
import { createRule } from "./shared.js";
import { hydrationEvidence } from "./ssr-evidence.js";

const RULE_ID = "vue/ssr/no-invalid-root-nesting";

// Nuxt's <ClientOnly> and the vue-client-only component render their slot after mount, never on the server.
const CLIENT_ONLY = new Set(["ClientOnly", "client-only"]);
// Nuxt renders `.client` components after mount and `.server` components as islands it does not hydrate.
const NOT_HYDRATED = /\.(?:client|server)\.vue$/;

export const noInvalidRootNesting = createRule({
  meta: {
    id: RULE_ID,
    title: "Render component roots where the HTML parser keeps them",
    category: "ssr",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: false,
    execution: "workspace",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph"],
    cost: "small",
    docsUrl: "https://vuejs.org/guide/scaling-up/ssr.html#hydration-mismatch",
  },
  create(ctx) {
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        for (const node of graph.components.values()) {
          if (NOT_HYDRATED.test(node.file) || nuxtRendersWithoutHydration(ctx, node.file)) continue;
          for (const edge of node.callers) {
            const parent = edge.usage.parent;
            if (!parent?.element || NOT_HYDRATED.test(edge.from)) continue;
            if (edge.usage.wrappers.some((tag) => CLIENT_ONLY.has(tag))) continue;
            const root = node.facts.roots.find((item) => movedRoot(parent.tag, item));
            if (!root) continue;
            const evidence = hydrationEvidence(ctx, relative(ctx.project.root, edge.from));
            if (!evidence) continue;
            report(ctx, node, edge, parent.tag, root, evidence);
          }
        }
      },
    };
  },
});

/** Whether every branch of the root is an element the parser moves out of `parent`. */
function movedRoot(parent: string, root: ComponentRootFact): boolean {
  return root.branches.every(
    (branch) => branch.kind === "element" && parserMovesChild(parent, branch.tag!),
  );
}

function report(
  ctx: RuleContext,
  node: ComponentNode,
  edge: ComponentUsageEdge,
  parent: string,
  root: ComponentRootFact,
  evidence: string,
): void {
  const name = displayName(node);
  const tags = [...new Set(root.branches.map((branch) => `<${branch.tag}>`))].join(" or ");
  ctx.report(
    diagnostics.VUE0052({
      why: `<${edge.usage.tag}> sits directly inside <${parent}>, and ${name} renders ${tags} at its root. The server sends that nesting as HTML, but the browser's HTML parser cannot keep ${tags} inside <${parent}>, so it closes, drops, or moves elements before Vue hydrates. Vue then finds different DOM than it rendered and logs "Hydration node mismatch" or "Hydration children mismatch". Doctor treats the file as server-rendered because ${evidence}.`,
      fix: `Change the <${parent}> around <${edge.usage.tag}> to an element that can contain ${tags}, such as a <div>, or change the root of ${name} to an element that is valid inside <${parent}>.`,
    }),
    {
      file: edge.from,
      range: edge.usage.range,
      confidence: "heuristic-high",
      evidence: [
        {
          kind: "graph",
          file: node.file,
          range: root.branches[0]?.range,
          summary: `${name} renders ${tags} at its root, which Vue's HTML nesting check rejects inside <${parent}>.`,
        },
      ],
      related: [
        {
          file: node.file,
          range: root.branches[0]?.range,
          message: `${name} renders ${tags} here`,
        },
      ],
    },
  );
}

/** Whether a Nuxt app registers the component as client-only or server-only. */
function nuxtRendersWithoutHydration(ctx: RuleContext, file: string): boolean {
  return projectNuxtInventories(ctx.project).some((nuxt) =>
    [...(nuxt.components?.values() ?? [])].some(
      (entry) =>
        (entry.mode === "client" || entry.mode === "server") &&
        resolve(ctx.project.root, entry.file) === file,
    ),
  );
}
