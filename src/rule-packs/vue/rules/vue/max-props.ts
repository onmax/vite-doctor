import type { RuleContext } from "../../../../core/index.js";
import { loadTypeScript, loadVueCompilerSfc } from "../../../../core/internal/lazy-parsers.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/component/max-props";
const DEFAULT_MAX_PROPS = 12;

const COMPONENT_WRAPPERS = new Set(["defineComponent", "defineNuxtComponent"]);

interface Options {
  maxProps?: number;
}

interface PropSurface {
  count: number;
  start: number;
  end: number;
}

let typeScriptRegistered = false;

export const maxProps = createRule({
  meta: {
    id: RULE_ID,
    title: "Review components with a large prop surface",
    category: "component",
    severity: "info",
    fixable: false,
    docsUrl: "https://github.com/vuejs-ai/skills/pull/54",
    requires: { sfc: true, script: true, vue: true },
  },
  create(ctx) {
    if (!ctx.file.isVueSfc) return;
    const descriptor = ctx.file.sfc?.descriptor as AnyNode;
    const block = descriptor?.scriptSetup ?? descriptor?.script;
    if (!block || block.src) return;
    // A /* @vue-ignore */ type is left out of the props compileScript resolves, so the count would be low.
    if (block.content.includes("@vue-ignore")) return;

    const limit = maxPropsOption(ctx.options);
    const surface = descriptor.scriptSetup
      ? scriptSetupPropSurface(ctx, descriptor)
      : optionsPropSurface(descriptor.script);
    if (!surface || surface.count <= limit) return;

    ctx.report(
      diagnostics.VUE0036({
        why: `This component declares ${surface.count} props, above the review threshold of ${limit}. A prop surface this large is a review signal, not a defect: it often means the component relays most props to one child, or owns more than one responsibility.`,
        fix: "Check whether most props are forwarded to a single child; if so, let parents use that child directly, or pass it through a slot. Otherwise split the component by responsibility, or move content-shaped props such as labels, icons and render variants into slots. Do not just group unrelated props into one object prop; that hides the same contract. Raise maxProps for this rule if the surface is intentional, such as a design-system primitive.",
      }),
      {
        ruleId: RULE_ID,
        severity: ctx.severity,
        category: "component",
        file: ctx.file.path,
        range: ctx.range(surface.start, surface.end),
      },
    );
  },
});

function maxPropsOption(options: unknown): number {
  const value = (options as Options | undefined)?.maxProps;
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_PROPS;
}

/**
 * compileScript resolves defineProps types the way Vue builds them, including extended
 * interfaces and imported types, and throws when a type cannot be resolved.
 */
function scriptSetupPropSurface(ctx: RuleContext, descriptor: AnyNode): PropSurface | null {
  const sfc = loadVueCompilerSfc();
  if (!typeScriptRegistered) {
    sfc.registerTS(() => loadTypeScript());
    typeScriptRegistered = true;
  }
  let compiled: ReturnType<typeof sfc.compileScript>;
  try {
    compiled = sfc.compileScript(descriptor, {
      id: ctx.file.hash,
      isProd: false,
      fs: {
        fileExists: (file) => ctx.fs.stat(file)?.isFile() ?? false,
        readFile: (file) => ctx.fs.readText(file),
        realpath: (file) => ctx.fs.realpath(file) ?? file,
      },
    });
  } catch {
    return null;
  } finally {
    // compileScript caches type scopes by file name across runs; drop them so edits are seen.
    sfc.invalidateTypeCache(descriptor.filename);
  }
  for (const dep of compiled.deps ?? []) sfc.invalidateTypeCache(dep);

  const count =
    Object.values(compiled.bindings ?? {}).filter((type) => type === "props").length +
    countDefineModelModifiers(compiled.scriptSetupAst);
  const macro = findMacroCall(compiled.scriptSetupAst);
  if (!macro || runtimeDeclarationIsPartial(macro)) return null;
  const offset = descriptor.scriptSetup.loc.start.offset;
  return { count, start: offset + macro.start, end: offset + macro.end };
}

function countDefineModelModifiers(body: AnyNode[] | undefined): number {
  let count = 0;
  walkBabel(body, (node) => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "defineModel")
      count++;
  });
  return count;
}

function findMacroCall(body: AnyNode[] | undefined): AnyNode {
  let defineProps: AnyNode = null;
  let defineModel: AnyNode = null;
  walkBabel(body, (node) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return;
    if (node.callee.name === "defineProps") defineProps ??= node;
    if (node.callee.name === "defineModel") defineModel ??= node;
  });
  return defineProps ?? defineModel;
}

// compileScript links resolved type nodes back to their scopes through `_` keys, which form cycles.
function walkBabel(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkBabel(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("_") || key === "loc" || key.endsWith("Comments")) continue;
    if (value && typeof value === "object") walkBabel(value, visit);
  }
}

// compileScript counts only literal keys, so a spread or a shared runtime object would undercount.
function runtimeDeclarationIsPartial(call: AnyNode): boolean {
  if (call.callee.name !== "defineProps") return false;
  const [declaration] = call.arguments ?? [];
  if (!declaration) return false;
  return !isCompleteDeclaration(declaration);
}

function optionsPropSurface(script: AnyNode): PropSurface | null {
  const program = parseOptionsScript(script);
  const exported = program?.body?.find(
    (node: AnyNode) => node.type === "ExportDefaultDeclaration",
  )?.declaration;
  const options =
    exported?.type === "CallExpression" &&
    exported.callee?.type === "Identifier" &&
    COMPONENT_WRAPPERS.has(exported.callee.name)
      ? exported.arguments?.[0]
      : exported;
  if (options?.type !== "ObjectExpression") return null;
  const props = options.properties.find(
    (property: AnyNode) =>
      property.type === "ObjectProperty" &&
      !property.computed &&
      (property.key?.name ?? property.key?.value) === "props",
  );
  if (!props || !isCompleteDeclaration(props.value)) return null;
  const count =
    props.value.type === "ArrayExpression"
      ? props.value.elements.length
      : props.value.properties.length;
  const offset = script.loc.start.offset;
  return { count, start: offset + props.start, end: offset + props.end };
}

function isCompleteDeclaration(node: AnyNode): boolean {
  if (node?.type === "ArrayExpression")
    return node.elements.every((element: AnyNode) => element?.type === "StringLiteral");
  if (node?.type === "ObjectExpression")
    return node.properties.every(
      (property: AnyNode) => property.type !== "SpreadElement" && !property.computed,
    );
  return false;
}

function parseOptionsScript(script: AnyNode): AnyNode {
  const { babelParse } = loadVueCompilerSfc();
  const lang = script.lang ?? "js";
  try {
    return babelParse(script.content, {
      sourceType: "module",
      plugins: [
        ...(lang === "ts" || lang === "tsx" ? (["typescript"] as const) : []),
        ...(lang === "jsx" || lang === "tsx" ? (["jsx"] as const) : []),
      ],
    }).program;
  } catch {
    return null;
  }
}
