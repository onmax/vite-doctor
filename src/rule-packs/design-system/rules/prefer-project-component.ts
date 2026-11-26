import { relative } from "pathe";
import {
  type ComponentUsageGraph,
  type Confidence,
  createRule,
  type ProjectInfo,
  type RuleContext,
  type TemplateElementNode,
  type TemplateRootNode,
} from "../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { loadVueCompilerSfc } from "../../../core/internal/lazy-parsers.js";
import {
  SFC_TEMPLATE_PARSE_OPTIONS,
  startTagEnd,
  TemplateNodeType,
  walkTemplate,
} from "../../../core/internal/template.js";
import { owningWorkspacePackage } from "../../../core/internal/workspace-packages.js";
import {
  type ComponentContract,
  type ComponentNames,
  componentNames,
  componentTag,
  isUiKitFile,
  parseContractOptions,
  projectContracts,
} from "../contracts.js";
import { diagnostics } from "../diagnostics.js";

const RULE_ID = "design-system/prefer-project-component";
const TEXT_INPUT_TYPES = new Set(["text", "email", "password", "search", "url", "tel", "number"]);
const NUXT_UI: Record<string, string> = {
  button: "UButton",
  input: "UInput",
  textarea: "UTextarea",
  select: "USelect",
};
const INFERRED_NAMES = new Set(["Button", "Input", "Textarea", "Select", "Label"]);

/** A component that replaces a raw element, and how Doctor learned it. */
interface Candidate {
  component: string;
  source: "contract" | "config" | "nuxt-ui" | "inferred";
  confidence: Confidence;
  file?: string;
}

interface Options {
  contracts: Record<string, ComponentContract>;
}

export const preferProjectComponent = createRule({
  meta: {
    id: "design-system/prefer-project-component",
    title: "Use the project's component instead of a raw element",
    description:
      "Finds raw elements such as <button> where the project has a component that replaces them.",
    category: "ui",
    severity: "info",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://vite-doctor.onmax.me/design-system#project-components",
    execution: "workspace",
    requires: { vue: true, crossFile: true },
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
        const names = componentNames(ctx.project, graph);
        const templates = new Map<string, ParsedSfc | null>();
        const parsed = (file: string) => {
          if (!templates.has(file)) templates.set(file, parseSfc(ctx, file));
          return templates.get(file)!;
        };
        const declared = declaredCandidates(graph, names, options.contracts);
        const inferred = inferredCandidates(graph, names, parsed);
        const nuxtUi = nuxtUiCandidates(ctx.project);
        const usesNuxtUi = nuxtUiOwners(ctx.project);
        const tags = new Set([...declared.keys(), ...inferred.keys(), ...Object.keys(NUXT_UI)]);
        const mentions = new RegExp(`<(?:${[...tags].join("|")})[\\s/>]`, "i");

        for (const node of graph.components.values()) {
          if (node.sourceKind === "module" || isUiKitFile(node.relativePath)) continue;
          if (!mentions.test(ctx.fs.readText(node.file) ?? "")) continue;
          const sfc = parsed(node.file);
          if (!sfc) continue;
          const appUsesNuxtUi = usesNuxtUi(node.relativePath);
          // A component whose only root is the element wraps it, like a LikeButton; pages do not.
          const wrapper =
            node.callers.length > 0 || /(?:^|\/)components\//.test(node.relativePath)
              ? sfc.root
              : undefined;
          walkTemplate(sfc.ast, (element) => {
            if (element.type !== TemplateNodeType.ELEMENT || element.tagType !== 0) return;
            const tag = element.tag.toLowerCase();
            if (!tags.has(tag) || element === wrapper || exempt(ctx, element)) return;
            const candidates = [
              declared.get(tag),
              appUsesNuxtUi ? nuxtUi.get(tag) : undefined,
              inferred.get(tag),
            ].find((list) => list?.length);
            const components = new Set(candidates?.map((candidate) => candidate.component));
            if (!candidates || components.size !== 1) return;
            if (candidates.some((candidate) => candidate.file === node.file)) return;
            const candidate = candidates[0]!;
            const start = element.loc.start.offset;
            const range = ctx.helpers.rangeFromOffsets(
              node.file,
              sfc.text,
              start,
              startTagEnd(element, sfc.text),
            );
            const copy = componentCopy(tag, candidate, ctx.project);
            ctx.report(diagnostics.DS0007(copy), {
              file: node.file,
              range,
              confidence: candidate.confidence,
              evidence: [
                {
                  kind:
                    candidate.source === "nuxt-ui" && candidate.confidence === "manifest-backed"
                      ? "manifest"
                      : candidate.source === "inferred"
                        ? "graph"
                        : "facts",
                  summary: evidenceSummary(tag, candidate, ctx.project),
                  ...(candidate.file && { file: candidate.file }),
                },
              ],
            });
          });
        }
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
      'options must be an object such as { contracts: { UButton: { replaces: "button" } } }',
    );
  const { contracts, ...unknown } = options as Record<string, unknown>;
  const extra = Object.keys(unknown);
  if (extra.length) throw invalid(`unknown option ${extra.map((key) => `\`${key}\``).join(", ")}`);
  try {
    return { contracts: parseContractOptions(contracts) };
  } catch (error) {
    throw invalid((error as Error).message);
  }
}

interface ParsedSfc {
  text: string;
  ast: TemplateRootNode;
  /** The template's single unconditional root element, which renders as the component itself. */
  root?: TemplateElementNode;
}

function parseSfc(ctx: RuleContext, file: string): ParsedSfc | null {
  const text = ctx.fs.readText(file);
  if (text === undefined || !text.includes("<template")) return null;
  const ast = loadVueCompilerSfc().parse(text, { templateParseOptions: SFC_TEMPLATE_PARSE_OPTIONS })
    .descriptor.template?.ast as TemplateRootNode | undefined;
  if (!ast) return null;
  const roots = ast.children.filter(
    (child) =>
      child.type !== TemplateNodeType.COMMENT &&
      !(child.type === TemplateNodeType.TEXT && !child.content.trim()),
  );
  const only = roots.length === 1 ? roots[0] : undefined;
  const root =
    only?.type === TemplateNodeType.ELEMENT &&
    only.tagType === 0 &&
    !only.props.some(
      (prop) =>
        prop.type === TemplateNodeType.DIRECTIVE &&
        ["if", "else-if", "else", "for"].includes(prop.name),
    )
      ? only
      : undefined;
  return { text, ast, root };
}

/** Elements Doctor must not rewrite: opted out, or rendering something other than their tag. */
function exempt(ctx: RuleContext, element: TemplateElementNode): boolean {
  if (
    ctx.helpers.hasVueAttribute(element, "data-doctor-ignore") ||
    ctx.helpers.hasVueDirective(element, "bind", "data-doctor-ignore") ||
    ctx.helpers.hasVueDirective(element, "bind", "is") ||
    ctx.helpers.getStaticVueAttributeValue(element, "is")?.startsWith("vue:")
  )
    return true;
  if (element.tag.toLowerCase() !== "input") return false;
  if (ctx.helpers.hasVueDirective(element, "bind", "type") || spreadAfterType(element)) return true;
  const type = ctx.helpers.getStaticVueAttributeValue(element, "type")?.toLowerCase() ?? "text";
  return !TEXT_INPUT_TYPES.has(type);
}

// An object v-bind can set or override type, so the rendered control is unknown statically.
function spreadAfterType(element: TemplateElementNode): boolean {
  let typeIndex = -1;
  element.props.forEach((prop, index) => {
    if (prop.type === TemplateNodeType.ATTRIBUTE && prop.name === "type") typeIndex = index;
  });
  return element.props.some(
    (prop, index) =>
      prop.type === TemplateNodeType.DIRECTIVE &&
      prop.name === "bind" &&
      !prop.arg &&
      index > typeIndex,
  );
}

function declaredCandidates(
  graph: ComponentUsageGraph,
  names: ComponentNames,
  configContracts: Record<string, ComponentContract>,
): Map<string, Candidate[]> {
  const byTag = new Map<string, Candidate[]>();
  for (const declared of projectContracts(graph, names, configContracts).contracts)
    for (const tag of declared.contract.replaces)
      push(byTag, tag, {
        component: declared.component,
        source: declared.declaredIn === "component" ? "contract" : "config",
        confidence: "proven",
        ...(declared.file && { file: declared.file }),
      });
  return byTag;
}

function nuxtUiCandidates(project: ProjectInfo): Map<string, Candidate[]> {
  const byTag = new Map<string, Candidate[]>();
  const resolved = project.nuxt?.manifest?.resolvedComponents;
  for (const [tag, component] of Object.entries(NUXT_UI)) {
    // A current manifest without the component means the app renamed or disabled it.
    if (resolved && !resolved.some((entry) => entry.name === component)) continue;
    push(byTag, tag, {
      component,
      source: "nuxt-ui",
      confidence: resolved ? "manifest-backed" : "heuristic-high",
    });
  }
  return byTag;
}

/** Whether the workspace package that owns a file uses Nuxt UI. */
function nuxtUiOwners(project: ProjectInfo): (relativePath: string) => boolean {
  const packages = projectWorkspacePackages(project);
  const module = !!project.nuxt?.modules?.some((entry) => entry.name === "@nuxt/ui");
  return (relativePath) => {
    const root = owningWorkspacePackage(packages, relativePath);
    const owner = packages.find((item) => item.root === root) ?? packages[0];
    return module || (!!owner && "@nuxt/ui" in owner.packages);
  };
}

/**
 * SFCs named exactly after the element they wrap, such as shadcn-vue's
 * `components/ui/button/Button.vue`, or a `Button.vue` whose only root is a `<button>`.
 */
function inferredCandidates(
  graph: ComponentUsageGraph,
  names: ComponentNames,
  parsed: (file: string) => ParsedSfc | null,
): Map<string, Candidate[]> {
  const byTag = new Map<string, Candidate[]>();
  for (const node of graph.components.values()) {
    if (node.sourceKind === "module") continue;
    const base = node.relativePath
      .split("/")
      .pop()!
      .replace(/\.vue$/, "");
    if (!INFERRED_NAMES.has(base)) continue;
    const tag = base.toLowerCase();
    if (!isUiKitFile(node.relativePath) && parsed(node.file)?.root?.tag.toLowerCase() !== tag)
      continue;
    push(byTag, tag, {
      component: componentTag(node, names),
      source: "inferred",
      confidence: "heuristic-high",
      file: node.file,
    });
  }
  return byTag;
}

function push(byTag: Map<string, Candidate[]>, tag: string, candidate: Candidate) {
  const list = byTag.get(tag) ?? [];
  if (!list.some((entry) => entry.component === candidate.component)) list.push(candidate);
  byTag.set(tag, list);
}

function evidenceSummary(tag: string, candidate: Candidate, project: ProjectInfo): string {
  const { component } = candidate;
  const where = candidate.file ? ` (${relative(project.root, candidate.file)})` : "";
  switch (candidate.source) {
    case "contract":
      return `${component}${where} declares defineOptions({ doctor: { replaces: "${tag}" } }).`;
    case "config":
      return `The Rule's contracts option declares that ${component} replaces <${tag}>.`;
    case "nuxt-ui":
      return candidate.confidence === "manifest-backed"
        ? `The Nuxt manifest registers ${component} from @nuxt/ui.`
        : `The project depends on @nuxt/ui, which provides ${component}.`;
    case "inferred":
      return `${component}${where} is named after <${tag}> and is the only component that wraps it.`;
  }
}

const LOSSES: Record<string, string> = {
  button: "its focus ring, size, and disabled or loading states can differ from every other button",
  input: "its height, focus ring, and invalid state can differ from every other field",
  textarea: "its padding, focus ring, and invalid state can differ from every other field",
  select: "its trigger, focus ring, and option list can differ from every other select",
};

function componentCopy(
  tag: string,
  candidate: Candidate,
  project: ProjectInfo,
): { why: string; fix: string } {
  const { component } = candidate;
  const nuxtUi = candidate.source === "nuxt-ui";
  const source = {
    contract: `${component} declares that it replaces <${tag}>`,
    config: `the project's Doctor config declares that ${component} replaces <${tag}>`,
    "nuxt-ui": `the app uses Nuxt UI, whose ${component} replaces <${tag}>`,
    inferred: `${component}${candidate.file ? ` in ${relative(project.root, candidate.file)}` : ""} is the project's <${tag}> component`,
  }[candidate.source];
  const formField =
    nuxtUi && tag !== "button"
      ? ", and it misses the label, help text, and error wiring UFormField gives Nuxt UI controls"
      : "";
  const why = `This raw <${tag}> bypasses ${component}: ${source}. Users see a control that does not match the rest of the app: ${LOSSES[tag] ?? "its styling and states can differ from the project's other instances"}${formField}.`;
  const props = nuxtUi
    ? {
        button: " Move styling classes to UButton props: color, variant, size, and icon.",
        input: " Wrap it in <UFormField> to get its label and validation error.",
        textarea: " Wrap it in <UFormField> to get its label and validation error.",
        select:
          " Turn the <option> elements into its `items` prop, or use <USelectMenu> for searchable or rich options.",
      }[tag]
    : ` Move styling classes to ${component}'s props, and drop classes it already applies.`;
  const fix = `Replace <${tag}> with <${component}>, keeping its attributes, v-model, listeners, and content.${props ?? ""}`;
  return { why, fix };
}
