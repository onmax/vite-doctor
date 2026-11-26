import type { Linter, SourceCode } from "eslint";
import {
  codeForRuleId,
  type Confidence,
  createRule,
  diagnosticForCode,
  type DoctorRule,
  type ProjectInfo,
  type RuleContext,
} from "../../../core/index.js";
import { TemplateNodeType, walkTemplate } from "../../../core/internal/template.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { diagnosticCodesByRuleId, diagnostics } from "../diagnostics.js";
import { designSystemCopy, findingData, fixedColorConsequence } from "./copy.js";
import { ownerUses } from "./inventory.js";
import { isUiKitFile } from "../contracts.js";
import { isNuxtUiColorClass, nuxtUiColors } from "./nuxt-ui.js";
import { styleBlockColors } from "./style-blocks.js";

// Upstream ESLint rule names keep the `shadcn/` plugin key, so `eslint-disable shadcn/...` comments still apply.
const ruleName = (id: string) => `shadcn/${id.slice("design-system/".length)}`;

// Nuxt UI tokens are real classes, so only Rules about unknown or undeclared tokens accept them.
const nuxtUiTokenRules = new Set(["no-raw-colors", "no-unknown-classes"]);

export function createDesignSystemRule(options: {
  id: string;
  title: string;
  description: string;
  rule: string;
  docsUrl: string;
  severity?: "error" | "warn" | "info";
  confidence: Confidence;
  /** Also reports color literals in Vue SFC `<style>` blocks. */
  styleBlocks?: boolean;
}): DoctorRule {
  return createRule({
    meta: {
      id: options.id,
      title: options.title,
      description: options.description,
      category: "ui",
      severity: options.severity ?? "warn",
      confidence: options.confidence,
      fixable: "suggestion",
      docsUrl: options.docsUrl,
      sourceKinds: ["app", "layer"],
      execution: "file",
      cost: "medium",
      determinism: "env-dependent",
    },
    async create(ctx: RuleContext) {
      const sfc = ctx.file.path.endsWith(".vue") ? ctx.file.sfc : undefined;
      if (!sfc && ctx.file.scriptAst?.type !== "Program") return;
      if (isOgImageTemplate(ctx)) return;
      const nuxtUi = nuxtUiColors(ctx);
      const styles =
        options.styleBlocks && sfc && !isUiKitFile(ctx.file.relativePath)
          ? await styleBlockColors(sfc.descriptor)
          : undefined;
      if (styles?.unparsed)
        addEvidenceGap(
          ctx,
          `Design-system Rules could not parse a <style> block in ${ctx.file.relativePath}, so its colors were not checked.`,
        );
      const styleColors = styles?.colors ?? [];
      // Linting in create() instead of node visitors avoids a full Doctor AST walk per file.
      const linted = await lintShadcnRule(ctx, ruleName(options.id));
      if (!linted.length && !styleColors.length) return;
      const code = codeForRuleId(diagnosticCodesByRuleId, options.id);
      const diagnostic = diagnosticForCode(diagnostics, code);
      if (!code || !diagnostic) throw doctorInternalDiagnostics.DOC0013({ ruleId: options.id });
      const templates = (await loadShadcnLint()).templates[options.rule] ?? {};
      const bomOffset = ctx.file.text.startsWith("\uFEFF") ? 1 : 0;
      const defaultArbitraryPolicy =
        options.rule === "no-arbitrary-values" && !hasVocabularyPolicy(ctx.options);
      // A mask's colors set its luminance, which is never painted.
      const masks = options.rule === "no-raw-colors" ? svgMasks(ctx) : [];
      const messages = linted.filter((message) => {
        if (masks.length) {
          const { start } = lintRange(ctx.file.text, message, bomOffset);
          if (masks.some((mask) => start >= mask.start && start < mask.end)) return false;
        }
        const className = (reportedData.get(message) ?? findingData(message, templates)?.data)
          ?.className;
        if (typeof className !== "string" || !className) return true;
        if (defaultArbitraryPolicy && isCustomArbitraryUtility(className)) return false;
        // Nuxt UI generates its color tokens at build time, where @shadcn/lint cannot read them.
        return (
          !nuxtUi || !nuxtUiTokenRules.has(options.rule) || !isNuxtUiColorClass(className, nuxtUi)
        );
      });
      for (const color of styleColors)
        ctx.report(
          diagnostic({
            why: `The <style> block hardcodes the color ${color.text} in "${color.property}". ${fixedColorConsequence}`,
            fix: nuxtUi
              ? `Replace ${color.text} with a Nuxt UI color variable such as var(--ui-primary) or var(--ui-text-muted), or a theme variable declared in the theme stylesheet.`
              : `Replace ${color.text} with a theme color variable such as var(--color-<name>), and declare --color-<name> in the theme stylesheet first if the color is new.`,
          }),
          {
            ruleId: options.id,
            severity: ctx.severity,
            category: "ui",
            file: ctx.file.path,
            range: ctx.helpers.rangeFromOffsets(
              ctx.file.path,
              ctx.file.text,
              color.start,
              color.end,
            ),
            // A theme can also switch through selectors or variants this scan does not know.
            confidence: "heuristic-medium",
            fix: null,
            tags: ["design-system", "vue-style-block"],
          },
        );
      for (const message of messages) {
        const suggested = message.suggestions?.[0];
        const editable =
          suggested &&
          preservesSource(
            ctx,
            suggested.fix.range[0] + bomOffset,
            suggested.fix.range[1] + bomOffset,
          );
        ctx.report(
          diagnostic(designSystemCopy(options.rule, message, templates, options.docsUrl)),
          {
            ruleId: options.id,
            severity: ctx.severity,
            category: "ui",
            file: ctx.file.path,
            range: lintRange(ctx.file.text, message, bomOffset),
            fix: editable
              ? {
                  kind: "suggestion",
                  message: suggested.desc,
                  edits: [
                    {
                      range: {
                        start: suggested.fix.range[0] + bomOffset,
                        end: suggested.fix.range[1] + bomOffset,
                      },
                      text: suggested.fix.text,
                    },
                  ],
                }
              : null,
            tags: ["design-system", "@shadcn/lint"],
          },
        );
      }
    },
  });
}

interface ShadcnLint {
  Linter: typeof Linter;
  parser: Linter.Parser;
  plugin: NonNullable<Linter.Config["plugins"]>[string];
  /** Each upstream Rule's `meta.messages`, keyed by Rule name. */
  templates: Record<string, Record<string, string>>;
}

interface ShadcnRuleConfig {
  key: string;
  name: string;
  entry: Linter.RuleEntry;
  settings: unknown;
  settingsKey: string;
  /** Names of the class helpers the Rule reads calls to, or undefined when every file is linted. */
  helpers?: RegExp;
}

interface FileLint {
  // undefined: not parsed yet; null: ESLint could not parse the file.
  sourceCode?: SourceCode | null;
  messages: Map<string, Linter.LintMessage[]>;
}

interface RunLint {
  linter: Linter;
  rules: Map<string, ShadcnRuleConfig>;
  files: Map<string, FileLint>;
  retainedSource: number;
}

// A retained SourceCode costs roughly 250x its source length in heap, and the file Rule runner
// visits every file for one Rule before the next, so reuse is capped to keep memory bounded.
const retainedSourceBudget = 1_000_000;

let shadcnLint: Promise<ShadcnLint> | undefined;

function loadShadcnLint(): Promise<ShadcnLint> {
  shadcnLint ??= Promise.all([
    import("eslint"),
    import("@typescript-eslint/parser"),
    import("@shadcn/lint"),
  ]).then(([eslint, parser, shadcn]) => ({
    Linter: eslint.Linter,
    parser: (parser.default ?? parser) as Linter.Parser,
    plugin: recordingReportData(shadcn.plugin as ShadcnLint["plugin"]),
    templates: Object.fromEntries(
      Object.entries(shadcn.plugin.rules).map(([name, rule]) => [name, rule.meta?.messages ?? {}]),
    ),
  }));
  return shadcnLint;
}

// The data each finding was reported with, such as its `className`. A custom `message` or settings
// note replaces the text the data could be read back from, so it is recorded at report time.
const reportedData = new WeakMap<Linter.LintMessage, Record<string, unknown>>();
let reports: Map<string, Array<Record<string, unknown>>> | undefined;

const reportKey = (ruleId: string, line: number, column: number) => `${ruleId}\0${line}\0${column}`;

type ReportDescriptor = {
  data?: Record<string, unknown>;
  loc?: { start?: { line: number; column: number }; line?: number; column?: number };
  node?: { loc?: { start: { line: number; column: number } } };
};

function recordingReportData(plugin: ShadcnLint["plugin"]): ShadcnLint["plugin"] {
  const rules = Object.fromEntries(
    Object.entries(plugin.rules ?? {}).map(([name, rule]) => {
      const ruleId = `shadcn/${name}`;
      const create = (rule as { create(context: unknown): unknown }).create;
      return [
        name,
        {
          ...rule,
          create(context: { report(descriptor: unknown): void }) {
            const recording = Object.create(context, {
              report: {
                value(descriptor: ReportDescriptor) {
                  const start =
                    descriptor.loc?.start ??
                    (descriptor.loc?.line === undefined
                      ? descriptor.node?.loc?.start
                      : descriptor.loc);
                  if (reports && start) {
                    const key = reportKey(ruleId, start.line!, start.column! + 1);
                    const data = descriptor.data ?? {};
                    const queue = reports.get(key);
                    if (queue) queue.push(data);
                    else reports.set(key, [data]);
                  }
                  context.report(descriptor);
                },
              },
            });
            return create.call(rule, recording);
          },
        },
      ];
    }),
  );
  return { ...plugin, rules } as ShadcnLint["plugin"];
}

let vueParser: Promise<Linter.Parser> | undefined;

// Loaded on the first SFC, so projects without Vue never pay for it.
function loadVueParser(): Promise<Linter.Parser> {
  vueParser ??= import("vue-eslint-parser").then(
    (parser) => (parser.default ?? parser) as Linter.Parser,
  );
  return vueParser;
}

// Project Inventory lives exactly as long as one Doctor Run, so it scopes the shared lint results.
const runs = new WeakMap<ProjectInfo, RunLint>();

async function lintShadcnRule(ctx: RuleContext, name: string): Promise<Linter.LintMessage[]> {
  const lint = await loadShadcnLint();
  let run = runs.get(ctx.project);
  if (!run) {
    run = {
      linter: new lint.Linter({ configType: "flat", cwd: ctx.project.root }),
      rules: new Map(),
      files: new Map(),
      retainedSource: 0,
    };
    runs.set(ctx.project, run);
  }
  const config = shadcnRuleConfig(name, ctx.options);
  run.rules.set(config.key, config);

  const fileKey = `${ctx.file.path}\0${ctx.file.hash}`;
  let file = run.files.get(fileKey);
  if (!file) run.files.set(fileKey, (file = { messages: new Map() }));
  const cached = file.messages.get(config.key);
  if (cached) return cached;
  if (file.sourceCode === null) return [];
  if (!mayHaveFindings(ctx.file.path, ctx.file.text, config)) {
    file.messages.set(config.key, []);
    return [];
  }

  // Every design-system Rule already seen in this run joins one verify, so a file is linted once per
  // batch of Rules instead of once per Rule. Within the budget, later batches reuse the parse.
  const batch = [config];
  const names = new Set([config.name]);
  for (const other of run.rules.values()) {
    if (other.settingsKey !== config.settingsKey || names.has(other.name)) continue;
    if (file.messages.has(other.key)) continue;
    batch.push(other);
    names.add(other.name);
  }

  const sfcParser = ctx.file.path.endsWith(".vue") ? await loadVueParser() : undefined;
  let messages: Linter.LintMessage[];
  try {
    messages = verify(lint, run.linter, file, ctx, batch, sfcParser);
  } catch (error) {
    // Another Rule's invalid options must not fail this Rule.
    if (batch.length === 1) throw error;
    batch.length = 1;
    messages = verify(lint, run.linter, file, ctx, batch, sfcParser);
  }
  const fatal = messages.find((message) => message.fatal);
  if (fatal)
    addEvidenceGap(
      ctx,
      `Design-system Rules could not parse ${ctx.file.relativePath}: ${fatal.message}`,
    );
  if (file.sourceCode === undefined) {
    const sourceCode = run.linter.getSourceCode();
    if (!sourceCode) file.sourceCode = null;
    else if (run.retainedSource + ctx.file.text.length <= retainedSourceBudget) {
      file.sourceCode = sourceCode;
      run.retainedSource += ctx.file.text.length;
    }
  }
  for (const rule of batch)
    file.messages.set(
      rule.key,
      messages.filter((message) => message.ruleId === rule.name && !message.fatal),
    );
  return file.messages.get(config.key)!;
}

function verify(
  lint: ShadcnLint,
  linter: Linter,
  file: FileLint,
  ctx: RuleContext,
  batch: ShadcnRuleConfig[],
  sfcParser: Linter.Parser | undefined,
): Linter.LintMessage[] {
  const shared = {
    plugins: { shadcn: lint.plugin },
    settings: { shadcn: batch[0]!.settings },
    rules: Object.fromEntries(batch.map((rule) => [rule.name, rule.entry])),
  };
  const languageOptions = { ecmaVersion: "latest", sourceType: "module" } as const;
  const filenames = { filename: ctx.file.relativePath, physicalFilename: ctx.file.path };
  const descriptor = ctx.file.sfc?.descriptor as
    | { script?: { lang?: string } | null; scriptSetup?: { lang?: string } | null }
    | undefined;
  const scriptLang = descriptor?.scriptSetup?.lang ?? descriptor?.script?.lang;
  reports = new Map();
  try {
    const messages = linter.verify(
      file.sourceCode ?? ctx.file.text,
      [
        {
          name: "vite-doctor/design-system",
          files: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
          languageOptions: { ...languageOptions, parser: lint.parser },
          ...shared,
        },
        ...(sfcParser
          ? [
              {
                name: "vite-doctor/design-system/vue",
                files: ["**/*.vue"],
                languageOptions: {
                  ...languageOptions,
                  parser: sfcParser,
                  parserOptions: {
                    parser: lint.parser,
                    ecmaFeatures: { jsx: scriptLang === "jsx" || scriptLang === "tsx" },
                  },
                },
                ...shared,
              },
            ]
          : []),
      ],
      filenames,
    );
    for (const message of messages) {
      const data = reports
        .get(reportKey(message.ruleId ?? "", message.line, message.column))
        ?.shift();
      if (data) reportedData.set(message, data);
    }
    return messages;
  } finally {
    reports = undefined;
  }
}

// One gap per file is enough to mark its evidence partial, including one Doctor's parser added.
function addEvidenceGap(ctx: RuleContext, message: string): void {
  const { path, relativePath } = ctx.file;
  if (
    ctx.project.evidenceGaps?.some(
      ({ files }) => files.includes(path) || files.includes(relativePath),
    )
  )
    return;
  ctx.project.evidenceGaps = [
    ...(ctx.project.evidenceGaps ?? []),
    { source: "vite-doctor/design-system", message, files: [relativePath] },
  ];
}

// vue-eslint-parser decodes template entities, so an edit over `&quot;` would write a raw quote
// into the attribute. Such findings keep their prose fix without an edit.
function preservesSource(ctx: RuleContext, start: number, end: number): boolean {
  return (
    !ctx.file.path.endsWith(".vue") ||
    !/&(?:#\d+|#x[\da-f]+|\w+);/i.test(ctx.file.text.slice(start, end))
  );
}

// Nuxt OG Image templates and Next.js image routes render to a PNG through Satori or Takumi, which
// read inline styles only and never see the theme.
function isOgImageTemplate(ctx: RuleContext): boolean {
  const path = ctx.file.relativePath;
  if (/(?:^|\/)components\/OgImage\//.test(path))
    return ownerUses(ctx, ["nuxt-og-image", "@nuxtjs/seo"]);
  if (/(?:^|\/)app\/(?:.+\/)?(?:opengraph|twitter)-image\.[jt]sx$/.test(path))
    return ownerUses(ctx, ["next"]);
  return false;
}

interface SourceSpan {
  start: number;
  end: number;
}

interface SvgGradient extends SourceSpan {
  /** The id as call sites spell it inside `url(#...)`, such as `fade` or `${id}-fade`. */
  id: string;
}

const gradientTags = new Set(["linearGradient", "radialGradient"]);
const paintAttribute = /^(?:fill|stroke|style|(?:xlink:?)?href)$/i;
const fragmentUrl = /^\s*url\(\s*(['"]?)#(.+?)\1\s*\)\s*$/i;

/**
 * The source spans of `<mask>` elements in the file's Vue template or JSX, and of gradients that
 * only masks reference, since a mask reads luminance and never paints those colors.
 */
function svgMasks(ctx: RuleContext): SourceSpan[] {
  const text = ctx.file.text;
  if (!text.includes("<mask")) return [];
  const masks: SourceSpan[] = [];
  const gradients: SvgGradient[] = [];
  const references: (SourceSpan & { name: string; value: string; id?: string })[] = [];
  let ambiguous = false;
  const attribute = (
    name: string,
    source: string | undefined,
    bound: boolean,
    span: SourceSpan,
  ) => {
    if (name === "id" || !source) return;
    const value = bound ? /^`([^`\\]*)`$/.exec(source.trim())?.[1] : source;
    if (value === undefined) {
      ambiguous ||= paintAttribute.test(name);
      return;
    }
    if (/^(?:xlink:?)?href$/i.test(name) && value.includes("#")) ambiguous = true;
    if (paintAttribute.test(name) && /[\\%]/.test(value) && /url|\\/i.test(value)) ambiguous = true;
    if (value.includes("#"))
      references.push({ name, value, id: fragmentUrl.exec(value)?.[2], ...span });
  };
  const template = ctx.file.sfc?.getTemplateAst();
  if (template) {
    walkTemplate(template, (node) => {
      if (node.type !== TemplateNodeType.ELEMENT) return;
      const span = { start: node.loc.start.offset, end: node.loc.end.offset };
      if (node.ns === 1 && node.tag === "mask") masks.push(span);
      let id: string | undefined;
      for (const prop of node.props) {
        const range = { start: prop.loc.start.offset, end: prop.loc.end.offset };
        if (prop.type === TemplateNodeType.ATTRIBUTE) {
          if (prop.name === "id") id = prop.value?.content;
          attribute(prop.name, prop.value?.content, false, range);
        } else if (prop.type === TemplateNodeType.DIRECTIVE && prop.name === "bind") {
          if (!prop.arg?.isStatic) ambiguous = true;
          else {
            if (prop.arg.content === "id") id = boundId(prop.exp?.content);
            attribute(prop.arg.content, prop.exp?.content, true, range);
          }
        } else if (prop.type === TemplateNodeType.DIRECTIVE && prop.name === "html") {
          ambiguous = true;
        }
      }
      if (id && node.ns === 1 && gradientTags.has(node.tag)) gradients.push({ id, ...span });
    });
  } else {
    type Node = {
      type?: string;
      start?: number;
      end?: number;
      openingElement?: {
        name?: { type?: string; name?: string };
        attributes?: {
          type?: string;
          start: number;
          end: number;
          name?: { name?: string; namespace?: { name: string } };
          value?: { type?: string; value?: unknown; expression?: { start: number; end: number } };
        }[];
      };
    };
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const element = node as Node;
      const name =
        element.type === "JSXElement" && element.openingElement?.name?.type === "JSXIdentifier"
          ? element.openingElement.name.name
          : undefined;
      if (name === "mask") masks.push({ start: element.start!, end: element.end! });
      if (element.type === "JSXElement") {
        let id: string | undefined;
        for (const prop of element.openingElement?.attributes ?? []) {
          const propName = prop.name?.namespace?.name === "xlink" ? "xlink:href" : prop.name?.name;
          if (!propName || propName === "dangerouslySetInnerHTML") {
            ambiguous = true;
            continue;
          }
          const expression = prop.value?.expression;
          const source = expression
            ? text.slice(expression.start, expression.end)
            : typeof prop.value?.value === "string"
              ? prop.value.value
              : undefined;
          if (propName === "id") id = expression ? boundId(source) : source;
          attribute(propName, source, !!expression, { start: prop.start, end: prop.end });
        }
        if (id && name && gradientTags.has(name))
          gradients.push({ id, start: element.start!, end: element.end! });
      }
      for (const [key, value] of Object.entries(node))
        if (key !== "parent" && value && typeof value === "object") visit(value);
    };
    visit(ctx.file.scriptAst);
  }
  if (ambiguous || !masks.length || /<style[\s>]/i.test(text)) return masks;
  const maskGradients: SourceSpan[] = [];
  for (const gradient of gradients) {
    const fragment = `#${gradient.id}`;
    const uses = references.filter((reference) => reference.value.includes(fragment));
    if (
      !uses.length ||
      uses.some(
        (reference) =>
          reference.id !== gradient.id ||
          !/^(?:fill|stroke)$/.test(reference.name) ||
          !masks.some((mask) => reference.start >= mask.start && reference.end <= mask.end),
      )
    )
      continue;
    let unaccounted = false;
    for (let at = text.indexOf(fragment); at !== -1; at = text.indexOf(fragment, at + 1)) {
      if (uses.some((use) => at >= use.start && at + fragment.length <= use.end)) continue;
      unaccounted = true;
      break;
    }
    if (!unaccounted) maskGradients.push(gradient);
  }
  return [...masks, ...maskGradients];
}

/** A bound id as `url(#...)` spells it: the body of a template literal, or `${expression}`. */
function boundId(expression: string | undefined): string | undefined {
  const source = expression?.trim();
  if (!source) return undefined;
  if (/^`[^`]*`$/.test(source)) return source.slice(1, -1);
  return /^[\w$.]+$/.test(source) ? `\${${source}}` : undefined;
}

function isCustomArbitraryUtility(token: string): boolean {
  const match = /(?:^|:)!?(content|grid-cols|grid-rows|transition)-\[(.*)\]!?$/.exec(token);
  if (!match) return false;
  const [, utility, value = ""] = match;
  if (utility === "content") return true;
  if (utility === "transition") {
    const properties = value
      .split(",")
      .map((property) => property.replace(/^_+|_+$/g, ""))
      .map((property) => (property.startsWith("--") ? property : property.toLowerCase()));
    if (
      properties.length < 2 ||
      !properties.every((property) => /^(?:--[\w-]+|-?[a-z][\w-]*)$/i.test(property))
    )
      return false;
    const list = new Set(properties);
    return !namedTransitionLists.some(
      (named) => named.size === list.size && [...list].every((property) => named.has(property)),
    );
  }
  let tracks = value;
  while (/\([^()]*\)/.test(tracks)) tracks = tracks.replace(/\([^()]*\)/g, "");
  return /^.+_.+$/.test(tracks) && !/^(?:subgrid|none)_/i.test(tracks) && !/[()[\]\\]/.test(tracks);
}

const colorTransition =
  "color background-color border-color outline-color text-decoration-color fill stroke " +
  "--tw-gradient-from --tw-gradient-via --tw-gradient-to";
const transformTransition = "transform translate scale rotate";
// The property lists Tailwind's named `transition-*` utilities emit.
const namedTransitionLists = [
  `${colorTransition} opacity box-shadow ${transformTransition} filter -webkit-backdrop-filter ` +
    "backdrop-filter display content-visibility overlay pointer-events",
  colorTransition,
  transformTransition,
].map((list) => new Set(list.split(" ")));

function hasVocabularyPolicy(options: unknown): boolean {
  const { ruleOptions } = unwrapRuleOptions(options);
  return (
    typeof ruleOptions === "object" &&
    ruleOptions !== null &&
    ("allow" in ruleOptions || "deny" in ruleOptions || "contracts" in ruleOptions)
  );
}

function unwrapRuleOptions(options: unknown): { ruleOptions: unknown; settings: unknown } {
  // Doctor config may wrap the upstream options as `{ options, settings }`, or pass them directly.
  const wrapped =
    typeof options === "object" &&
    options !== null &&
    ("options" in options || "settings" in options);
  const settings = wrapped ? (options as any).settings : undefined;
  const ruleOptions = wrapped ? (options as any).options : options;
  return { ruleOptions, settings };
}

function shadcnRuleConfig(name: string, options: unknown): ShadcnRuleConfig {
  const { ruleOptions, settings } = unwrapRuleOptions(options);
  const entry: Linter.RuleEntry = ruleOptions === undefined ? "error" : ["error", ruleOptions];
  const settingsKey = stableKey(settings);
  return {
    key: `${name}\0${stableKey(entry)}\0${settingsKey}`,
    name,
    entry,
    settings,
    settingsKey,
    // Rule options can scan every string or report a policy error on every file.
    helpers: ruleOptions === undefined ? helperPattern(settings) : undefined,
  };
}

// @shadcn/lint's defaults, plus the helpers `settings.shadcn` adds.
const defaultHelpers = ["cn", "cx", "clsx", "cva", "tv", "twMerge", "twJoin", "classNames"];

function helperPattern(settings: unknown): RegExp {
  const configured = (key: string): string[] => {
    const value = (settings as Record<string, unknown> | null | undefined)?.[key];
    const list = Array.isArray(value) ? value : [value];
    return list.every((item) => typeof item === "string") ? list : [];
  };
  const names = [
    ...defaultHelpers,
    ...configured("mergeFunctions"),
    ...configured("variantFunctions"),
  ].map((name) => name.slice(name.lastIndexOf(".") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\w$])(?:${names.join("|")})(?![\\w$])`);
}

// Every @shadcn/lint finding starts at a class, style, or color attribute (fill, stroke, stop-color,
// ...), an object key spread into one, a `<style>` element, or a call to a class helper.
const markupWords = /class|style|fill|stroke|color/i;
// Escapes and character references decode to names the raw text does not spell, such as
// `c\u006e(...)` or Vue's `['st&#121;le']`.
const encodedName = /\\(?:u|x|[0-7])|&(?:#|[a-z][a-z\d]*;)/i;
// TypeScript parses these without JSX, so only helper calls can hold classes.
const plainTypeScript = /\.[cm]?ts$/;

/**
 * False when the file cannot hold anything the Rule reads, so the ESLint parse can be skipped.
 * Inline `eslint` comments can change a Rule's options, so files with them are always linted.
 */
function mayHaveFindings(path: string, text: string, config: ShadcnRuleConfig): boolean {
  if (!config.helpers || text.includes("eslint") || encodedName.test(text)) return true;
  if (config.helpers.test(text)) return true;
  return !plainTypeScript.test(path) && markupWords.test(text);
}

let unserializableKeys = 0;

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return `unserializable:${++unserializableKeys}`;
  }
}

function lintRange(source: string, message: Linter.LintMessage, bomOffset: number) {
  let offset = bomOffset;
  for (let line = 1; line < message.line; line++) offset = source.indexOf("\n", offset) + 1;
  const start = Math.max(0, offset + message.column - 1);
  const end = message.endLine
    ? (() => {
        let endOffset = bomOffset;
        for (let line = 1; line < message.endLine; line++)
          endOffset = source.indexOf("\n", endOffset) + 1;
        return endOffset + message.endColumn! - 1;
      })()
    : start;
  return {
    start,
    end,
    line: message.line,
    column: message.column + (message.line === 1 ? bomOffset : 0),
  };
}
