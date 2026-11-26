import { relative } from "pathe";
import {
  type ComponentUsageFact,
  type ComponentUsageGraph,
  createRule,
  type DiagnosticEvidence,
  type RuleContext,
} from "../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { camelize } from "../../../core/internal/component-facts.js";
import { parseScript } from "../../../core/internal/script.js";
import { unwrap } from "../../nuxt/rules/nuxt/nuxt-config-ast.js";
import { pascalTag } from "../../nuxt/rules/nuxt/page-structure.js";
import {
  type ComponentContract,
  type ComponentLimit,
  componentNames,
  type DeclaredContract,
  parseContractOptions,
  projectContracts,
} from "../contracts.js";
import { diagnostics } from "../diagnostics.js";
import { projectViews, type RenderedUsage, type View, viewGraph, viewUsages } from "../views.js";

const RULE_ID = "design-system/limit-per-view";

interface Options {
  contracts: Record<string, ComponentContract>;
}

interface Finding {
  declared: DeclaredContract;
  limit: ComponentLimit;
  counted: RenderedUsage[];
  views: View[];
}

export const limitPerView = createRule({
  meta: {
    id: RULE_ID,
    title: "Keep component-declared limits per view",
    description:
      "Finds views that render more usages of a component than its Component Contract allows, such as two primary buttons.",
    category: "ui",
    severity: "warn",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://vite-doctor.onmax.me/design-system#limits-per-view",
    execution: "workspace",
    cacheScope: "none",
    requires: { vue: true, nuxt: true, crossFile: true },
    requiresContext: ["cross-file"],
    consumesEvidence: ["facts", "graph", "manifest"],
    cost: "small",
  },
  validateOptions: readOptions,
  create(ctx) {
    const options = readOptions(ctx.options);
    return {
      async onWorkspaceEnd() {
        const graph = await ctx.inventory.componentUsage();
        const { contracts } = projectContracts(
          graph,
          componentNames(ctx.project, graph),
          options.contracts,
        );
        const limited = contracts.filter(({ contract }) => contract.limits.length);
        if (!limited.length) return;
        const resolved = viewGraph(ctx, graph);
        const views = await projectViews(ctx, resolved);
        const findings = new Map<string, Finding>();
        for (const view of views) {
          const usages = viewUsages(resolved, view);
          for (const declared of limited) {
            const matching = usages.filter(({ target, usage }) =>
              rendersContract(target, usage, declared),
            );
            if (matching.length === 0) continue;
            for (const limit of declared.contract.limits) {
              const counted = matching.filter((rendered) =>
                matchesWhen(graph, rendered, declared, limit),
              );
              if (counted.length <= limit.max) continue;
              const key = JSON.stringify([
                declared.component,
                declared.file,
                declared.contract.limits.indexOf(limit),
                counted.map(usageKey),
              ]);
              const finding = findings.get(key);
              if (finding) finding.views.push(view);
              else findings.set(key, { declared, limit, counted, views: [view] });
            }
          }
        }
        for (const finding of findings.values()) report(ctx, finding);
      },
    };
  },
});

function readOptions(options: unknown): Options {
  if (options === undefined) return { contracts: {} };
  const invalid = (reason: string) =>
    doctorInternalDiagnostics.DOC0020({ ruleId: RULE_ID, reason });
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw invalid(
      "options must be an object such as { contracts: { UButton: { limits: [{ max: 1, why, fix }] } } }",
    );
  const { contracts, ...unknown } = options as Record<string, unknown>;
  const extra = Object.keys(unknown);
  if (extra.length) throw invalid(`unknown option ${extra.map((key) => `\`${key}\``).join(", ")}`);
  try {
    return {
      contracts: Object.fromEntries(
        Object.entries(parseContractOptions(contracts)).map(([name, contract]) => [
          pascalTag(name),
          contract,
        ]),
      ),
    };
  } catch (error) {
    throw invalid((error as Error).message);
  }
}

function rendersContract(
  target: string | null | undefined,
  usage: ComponentUsageFact,
  declared: DeclaredContract,
): boolean {
  if (declared.file) return target === declared.file;
  if (target === null) return false;
  return pascalTag(usage.tag) === declared.component;
}

/**
 * Whether a usage passes the props `limit.when` names with matching values. A value Doctor cannot
 * read, such as `:variant="tone"` or a `v-bind` spread, does not match, so the count stays low.
 */
function matchesWhen(
  graph: ComponentUsageGraph,
  { usage, target: file }: RenderedUsage,
  declared: DeclaredContract,
  limit: ComponentLimit,
): boolean {
  const props = Object.entries(limit.when);
  if (!props.length) return true;
  if (usage.spreads.some((spread) => spread.directive === "bind")) return false;
  const target = graph.components.get(file ?? declared.file ?? "");
  return props.every(([prop, values]) => {
    const passed = passedValue(usage, prop);
    if (passed === null) return false;
    if (passed !== undefined) return values.includes(passed);
    if (values.includes(null)) return true;
    const fallback = target?.facts.props?.find((item) => item.name === prop)?.defaultValue;
    return fallback !== undefined && values.includes(fallback);
  });
}

/** The value a usage passes for `prop`: undefined when it omits it, null when Doctor cannot read it. */
function passedValue(usage: ComponentUsageFact, prop: string): string | null | undefined {
  const bindings = usage.bindings.filter((item) => camelize(item.vnodeKey) === prop);
  const attributes = usage.attributes.filter((item) => camelize(item.name) === prop);
  if (bindings.length + attributes.length > 1) return null;
  const binding = bindings[0];
  if (binding) return binding.model ? null : (stringLiteral(binding.expression) ?? null);
  const attribute = attributes[0];
  if (attribute) return attribute.value ?? "";
  return undefined;
}

function stringLiteral(expression: string): string | undefined {
  const program = parseScript("expression.ts", `(${expression})`) as {
    body?: Array<{ type: string; expression?: unknown }>;
  } | null;
  const statement = program?.body?.length === 1 ? program.body[0] : undefined;
  const node = unwrap(statement?.type === "ExpressionStatement" ? statement.expression : null) as
    | { type?: string; value?: unknown; expressions?: unknown[]; quasis?: any[] }
    | undefined;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && !node.expressions?.length)
    return node.quasis?.[0]?.value?.cooked ?? undefined;
  return undefined;
}

function usageKey(rendered: RenderedUsage): string {
  return [...rendered.via.map((step) => `${step.file}@${step.range.start}`), rendered.file]
    .concat(String(rendered.usage.range.start))
    .join(">");
}

function report(ctx: RuleContext, finding: Finding) {
  const { declared, limit, counted, views } = finding;
  const routes = views.map(({ route }) => route);
  const excess = counted[limit.max]!;
  const component = declared.component;
  const where = (rendered: RenderedUsage) =>
    `${relative(ctx.project.root, rendered.file)}:${rendered.usage.range.line}:${rendered.usage.range.column}`;
  const subject = `${whenSummary(limit)}<${component}>`;
  const scope =
    routes.length === 1
      ? `the ${routes[0]} view`
      : `the ${routes[0]} view and ${routes.length - 1} other view${routes.length === 2 ? "" : "s"} that share these usages`;
  const why = `More than ${limit.max} ${subject} in ${scope}: ${counted.length} render together. ${sentence(limit.why)}`;
  const fix = `${sentence(limit.fix)} Counted usages: ${counted.map(where).join(", ")}.`;
  const contractSource =
    declared.declaredIn === "component" && declared.file
      ? `${component} (${relative(ctx.project.root, declared.file)}) declares`
      : `The Rule's contracts option declares for ${component}`;
  const evidence: DiagnosticEvidence[] = [
    {
      kind: "facts",
      summary: `${contractSource} at most ${limit.max} ${whenDetail(limit)} per view.`,
      ...(declared.file && { file: declared.file }),
      ...(declared.range && { range: declared.range }),
    },
    ...counted.map((rendered): DiagnosticEvidence => ({
      kind: "graph",
      file: rendered.file,
      range: rendered.usage.range,
      summary: `<${rendered.usage.tag}> renders every time ${routes[0]} renders${
        rendered.via.length
          ? `, through ${rendered.via
              .map(
                ({ file, range, tag }) =>
                  `<${tag}> at ${relative(ctx.project.root, file)}:${range.line}:${range.column}`,
              )
              .join(" > ")}`
          : ""
      }${rendered.certainty === "heuristic" ? ", assuming a package component renders its default slot" : ""}.`,
    })),
  ];
  ctx.report(diagnostics.DS0008({ why, fix }), {
    file: excess.file,
    range: excess.usage.range,
    confidence: counted.every((rendered) => rendered.certainty === "proven")
      ? "proven"
      : "heuristic-high",
    evidence,
    data: {
      component,
      max: limit.max,
      when: limit.when,
      routes,
      pages: views.map(({ page }) => relative(ctx.project.root, page)),
      counted: counted.map((rendered) => ({
        file: relative(ctx.project.root, rendered.file),
        line: rendered.usage.range.line,
        column: rendered.usage.range.column,
      })),
    },
  });
}

/** The `when` values as words before the tag, such as `solid primary `. */
function whenSummary(limit: ComponentLimit): string {
  const words = Object.values(limit.when).flatMap((values) => {
    const set = values.filter((value): value is string => value !== null);
    return set.length ? [set.join("/")] : [];
  });
  return words.length ? `${words.join(" ")} ` : "";
}

/** The `when` condition spelled out, such as `<UButton> with variant "solid" or unset`. */
function whenDetail(limit: ComponentLimit): string {
  const props = Object.entries(limit.when);
  if (!props.length) return "usages";
  return `usages with ${props
    .map(
      ([prop, values]) =>
        `${prop} ${values.map((value) => (value === null ? "unset" : `"${value}"`)).join(" or ")}`,
    )
    .join(" and ")}`;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
