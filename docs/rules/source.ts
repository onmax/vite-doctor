import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "pathe";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ruleDocumentationMetadata } from "./metadata.js";

export type RuleSeverity = "error" | "warn" | "info";
export type RuleFix = "safe" | "suggestion" | "no";
export type RuleFramework = "vue" | "vite" | "nuxt" | "nitro" | "typescript";

export interface RuleExample {
  title: string;
  language: string;
  invalid: string;
  valid: string;
}

export interface RuleDocument {
  id: string;
  title: string;
  description: string;
  pack: string;
  source: string;
  path: string;
  key: string;
  framework: RuleFramework;
  why: string;
  recommendedReplacement: string;
  examples: RuleExample[];
  category: string;
  severity: RuleSeverity;
  fixable: RuleFix;
  docsUrl: string;
  sourceUrl: string;
}

export interface DiagnosticDocument {
  code: string;
  title: string;
  description: string;
  why: string;
  fix: string;
  docsUrl: string;
  ruleId: string;
  pack: string;
  severity: RuleSeverity;
  category: string;
  framework: RuleFramework;
  source: string;
  sourceUrl: string;
  path: string;
  key: string;
}

export interface RuleCatalogEntry {
  id: string;
  title: string;
  description: string;
  pack: string;
  severity: RuleSeverity;
  category: string;
  fixable: RuleFix;
  docsUrl: string;
  docsPath: string;
  path: string;
  framework: RuleFramework;
  source: string;
  sourceUrl: string;
}

export interface RulesReport {
  catalogVersion: 1;
  rules: RuleCatalogEntry[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

let cachedRules: RuleDocument[] | null = null;
let cachedDiagnostics: DiagnosticDocument[] | null = null;
let parser: typeof import("oxc-parser") | null = null;

export function getRuleDocuments() {
  if (!cachedRules) cachedRules = collectRuleDocuments();
  return cachedRules;
}

export function getRuleReports() {
  const rules = getRuleDocuments();
  const byFramework = {
    vue: rules.filter((rule) => rule.framework === "vue"),
    vite: rules.filter((rule) => rule.framework === "vite"),
    nitro: rules.filter((rule) => rule.framework === "nitro"),
    nuxt: rules.filter((rule) => ["vue", "nitro", "nuxt"].includes(rule.framework)),
    typescript: rules.filter((rule) => rule.framework === "typescript"),
    all: rules,
  };

  return Object.fromEntries(
    Object.entries(byFramework).map(([key, items]) => [
      key,
      {
        catalogVersion: 1,
        rules: items.map(toCatalogRule),
      },
    ]),
  ) as unknown as Record<"vue" | "vite" | "nitro" | "nuxt" | "typescript" | "all", RulesReport>;
}

export function getDiagnosticDocuments() {
  if (!cachedDiagnostics) cachedDiagnostics = collectDiagnosticDocuments();
  return cachedDiagnostics;
}

export const rulesCollectionSource = {
  async getKeys() {
    return getRuleDocuments().map((rule) => rule.key);
  },
  async getItem(key: string) {
    const rule = getRuleDocuments().find((item) => item.key === key);
    if (!rule) throw new Error(`Unknown rule content key: ${key}`);
    return renderRulePage(rule);
  },
};

export const diagnosticsCollectionSource = {
  async getKeys() {
    return getDiagnosticDocuments().map((diagnostic) => diagnostic.key);
  },
  async getItem(key: string) {
    const diagnostic = getDiagnosticDocuments().find((item) => item.key === key);
    if (!diagnostic) throw new Error(`Unknown diagnostic content key: ${key}`);
    return renderDiagnosticPage(diagnostic);
  },
};

function collectDiagnosticDocuments(): DiagnosticDocument[] {
  const maps = readDiagnosticCodeMaps();
  const ruleDiagnostics = getRuleDocuments().flatMap((rule) => {
    const code = maps.get(rule.id);
    if (!code) return [];
    const path = `/diagnostics/${code}`;
    return [
      {
        code,
        title: `${code}: ${rule.title}`,
        description: rule.description,
        why: rule.why,
        fix: rule.recommendedReplacement,
        docsUrl: rule.docsUrl,
        ruleId: rule.id,
        pack: rule.pack,
        severity: rule.severity,
        category: rule.category,
        framework: rule.framework,
        source: rule.source,
        sourceUrl: rule.sourceUrl,
        path,
        key: `${path.slice(1)}.md`,
      },
    ];
  });
  const source = "src/core/internal/diagnostics.ts";
  return [
    ...ruleDiagnostics,
    {
      code: "DOC0022",
      title: "DOC0022: Resolve the runtime graph",
      description:
        "Doctor could not identify an exact Nuxt, Nitro, H3, or Vue runtime package that governs this project.",
      why: "Version-specific advice is safe only when Doctor can prove which runtime instance the framework owns. Doctor suppresses those diagnostics when package identity, version, or ownership is unresolved.",
      fix: "Install the project dependencies and run Doctor through the project package manager. For computed Nuxt config, make future.compatibilityVersion statically provable or run pnpm nuxt doctor so the Nuxt integration can record the resolved value.",
      docsUrl: "https://vite-doctor.onmax.me/cli",
      ruleId: "doctor/inventory/unresolved-runtime",
      pack: "vite-doctor/core",
      severity: "warn",
      category: "inventory",
      framework: "nuxt",
      source,
      sourceUrl: githubSourceUrl(source),
      path: "/diagnostics/DOC0022",
      key: "diagnostics/DOC0022.md",
    },
  ];
}

function readDiagnosticCodeMaps() {
  const files = [
    "src/core/diagnostic-registry.ts",
    "src/rule-packs/vue/diagnostics.ts",
    "src/diagnostics.ts",
    "src/rule-packs/nitro/diagnostics.ts",
    "src/rule-packs/nuxt/diagnostics.ts",
    "src/rule-packs/typescript/diagnostics.ts",
  ];
  const map = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(
      /\{\s*code:\s*"([^"]+)"\s*,\s*ruleId:\s*"([^"]+)"\s*,?\s*\}/g,
    )) {
      map.set(match[2]!, match[1]!);
    }
  }
  return map;
}

function renderDiagnosticPage(diagnostic: DiagnosticDocument) {
  return [
    "---",
    `title: ${yamlString(diagnostic.title)}`,
    `description: ${yamlString(diagnostic.description)}`,
    `code: ${yamlString(diagnostic.code)}`,
    `why: ${yamlString(diagnostic.why)}`,
    `fix: ${yamlString(diagnostic.fix)}`,
    `docsUrl: ${yamlString(diagnostic.docsUrl || "")}`,
    `ruleId: ${yamlString(diagnostic.ruleId)}`,
    `pack: ${yamlString(diagnostic.pack)}`,
    `severity: ${yamlString(diagnostic.severity)}`,
    `category: ${yamlString(diagnostic.category)}`,
    `framework: ${yamlString(diagnostic.framework)}`,
    `source: ${yamlString(diagnostic.source)}`,
    `sourceUrl: ${yamlString(diagnostic.sourceUrl)}`,
    "---",
    "",
    `\`${diagnostic.code}\``,
    "",
    diagnostic.description,
    "",
    "## Why it happens",
    "",
    diagnostic.why,
    "",
    "## Fix",
    "",
    diagnostic.fix,
    "",
    ...(diagnostic.docsUrl
      ? ["## Useful links", "", `- [Upstream docs](${diagnostic.docsUrl})`, ""]
      : []),
    "## Related rule",
    "",
    `- \`${diagnostic.ruleId}\``,
    "",
  ].join("\n");
}

function collectRuleDocuments() {
  const vueSources = ruleSourcesFromIndex(join(root, "src/rule-packs/vue/rules/vue/index.ts"));
  const viteRulesDir = join(root, "src/rule-packs/vite/rules");
  const viteSources = readdirSync(viteRulesDir)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts" && file !== "shared.ts")
    .sort()
    .map((file) => join(viteRulesDir, file));
  const typescriptRulesDir = join(root, "src/rule-packs/typescript/rules");
  const typescriptSources = readdirSync(typescriptRulesDir)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts" && file !== "shared.ts")
    .sort()
    .map((file) => join(typescriptRulesDir, file));
  const nuxtRulesDir = join(root, "src/rule-packs/nuxt/rules");
  const nitroRulesDir = join(root, "src/rule-packs/nitro/rules");
  const nitroSources = readdirSync(nitroRulesDir)
    .filter((file) => file.endsWith(".ts") && !["ast.ts", "index.ts", "shared.ts"].includes(file))
    .sort()
    .map((file) => join(nitroRulesDir, file));
  const nuxtSources = [
    ...ruleSourcesFromIndex(join(nuxtRulesDir, "nuxt/index.ts")),
    ...readdirSync(nuxtRulesDir)
      .filter((file) => file.endsWith(".ts") && file !== "index.ts" && file !== "nuxt.ts")
      .sort()
      .map((file) => join(nuxtRulesDir, file)),
  ];

  return [
    ...withRulePath(collectRules(vueSources, "vite-doctor/vue", "vue"), "/vue/rules"),
    ...withRulePath(collectRules(viteSources, "vite-doctor/vite", "vite"), "/vite/rules"),
    ...withRulePath(
      collectRules(typescriptSources, "vite-doctor/typescript", "typescript"),
      "/typescript/rules",
    ),
    ...withRulePath(collectRules(nitroSources, "vite-doctor/nitro", "nitro"), "/nitro/rules"),
    ...withRulePath(collectRules(nuxtSources, "vite-doctor/nuxt", "nuxt"), "/nuxt/rules"),
  ];
}

function collectRules(files: string[], defaultPack: string, framework: RuleFramework) {
  const { parseSync, visitorKeys } = loadParser();
  return files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const ast = parseSync(file, text, { sourceType: "module", lang: "ts" }).program;
    const pack = readPackName(ast) ?? defaultPack;
    const source = relative(root, file);
    const metaRules = findMetaObjects(ast, visitorKeys)
      .map((meta) => {
        const rule = {
          pack,
          source,
          framework,
          id: readString(meta, "id"),
          title: readString(meta, "title"),
          description: readString(meta, "description"),
          why: readString(meta, "why"),
          recommendedReplacement: readString(meta, "recommendedReplacement"),
          examples: readExamples(meta),
          category: readString(meta, "category"),
          severity: (readString(meta, "severity") || "warn") as RuleSeverity,
          fixable: readFixable(meta),
          docsUrl: readString(meta, "docsUrl"),
          sourceUrl: githubSourceUrl(source),
        };
        return applyDocumentationMetadata(rule);
      })
      .filter((rule) => rule.id);
    const helperRules = findValidatedInputRuleOptions(ast, visitorKeys).map((opts) => ({
      pack,
      source,
      framework,
      id: readString(opts, "id"),
      title: readString(opts, "title"),
      description: readString(opts, "description"),
      why: "Raw request input and validation can drift apart when they are separate operations. Nitro and h3 provide validated helpers that keep parsing and validation coupled at the request boundary.",
      recommendedReplacement: validatedInputReplacement(opts),
      examples: validatedInputExamples(opts),
      category: "request",
      severity: "warn" as const,
      fixable: "suggestion" as const,
      docsUrl: readString(opts, "docsUrl"),
      sourceUrl: githubSourceUrl(source),
    }));
    return [...metaRules, ...helperRules].filter((rule) => rule.id);
  });
}

function loadParser() {
  parser ??= require("oxc-parser") as typeof import("oxc-parser");
  return parser;
}

function applyDocumentationMetadata<T extends Omit<RuleDocument, "path" | "key">>(rule: T): T {
  const metadata = ruleDocumentationMetadata[rule.id as keyof typeof ruleDocumentationMetadata];
  const documented = {
    ...rule,
    description: rule.description || metadata?.description || "",
    why: rule.why || metadata?.why || "",
    recommendedReplacement: rule.recommendedReplacement || metadata?.recommendedReplacement || "",
    examples: rule.examples.length ? rule.examples : (metadata?.examples ?? []),
  };
  assertCompleteRuleDocumentation(documented);
  return documented;
}

function assertCompleteRuleDocumentation(rule: Omit<RuleDocument, "path" | "key">) {
  const missing: string[] = [];
  if (!rule.description) missing.push("description");
  if (!rule.why) missing.push("why");
  if (!rule.recommendedReplacement) missing.push("recommendedReplacement");
  if (!rule.examples.length) missing.push("examples");

  for (const [index, example] of rule.examples.entries()) {
    if (!example.title) missing.push(`examples[${index}].title`);
    if (!example.language) missing.push(`examples[${index}].language`);
    if (!example.invalid) missing.push(`examples[${index}].invalid`);
    if (!example.valid) missing.push(`examples[${index}].valid`);
  }

  if (missing.length) {
    throw new Error(`Rule ${rule.id} is missing documentation metadata: ${missing.join(", ")}`);
  }
}

function ruleSourcesFromIndex(indexFile: string) {
  const dir = dirname(indexFile);
  return readFileSync(indexFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^export \{ \w+ \} from "\.\/(.+)\.js";$/)?.[1])
    .filter(Boolean)
    .map((file) => join(dir, `${file}.ts`));
}

function withRulePath(
  rules: Array<Omit<RuleDocument, "path" | "key">>,
  basePath: string,
): RuleDocument[] {
  return rules.map((rule) => {
    const path = `${basePath}/${rulePath(rule)}`;
    return {
      ...rule,
      path,
      key: `${path.slice(1)}.md`,
    };
  });
}

function renderRulePage(rule: RuleDocument) {
  const title = rule.title || rule.id;
  const description = rule.description || `${rule.id} in ${rule.pack}.`;
  const lines = [
    "---",
    `title: ${yamlString(title)}`,
    `description: ${yamlString(description)}`,
    `why: ${yamlString(rule.why)}`,
    `recommendedReplacement: ${yamlString(rule.recommendedReplacement)}`,
    `ruleId: ${yamlString(rule.id)}`,
    `pack: ${yamlString(rule.pack)}`,
    `severity: ${yamlString(rule.severity)}`,
    `category: ${yamlString(rule.category)}`,
    `fix: ${yamlString(rule.fixable || "no")}`,
    `framework: ${yamlString(rule.framework)}`,
    `source: ${yamlString(rule.source)}`,
    `sourceUrl: ${yamlString(rule.sourceUrl)}`,
    `docsUrl: ${yamlString(rule.docsUrl || "")}`,
    "---",
    "",
    `\`${rule.id}\``,
    "",
  ];

  if (rule.description) lines.push(escapeMarkdownText(rule.description), "");
  lines.push(renderBadgeRow(rule), "");
  lines.push("## Run this rule", "", "```bash", renderRuleCommand(rule), "```", "");
  if (rule.why) lines.push("## Why it matters", "", escapeMarkdownText(rule.why), "");
  if (rule.recommendedReplacement) {
    lines.push("## Recommended fix", "", escapeMarkdownText(rule.recommendedReplacement), "");
  }
  const usefulLinks = ruleUsefulLinks(rule);
  if (usefulLinks.length)
    lines.push("## Useful links", "", ...usefulLinks.map(renderUsefulLink), "");
  if (rule.examples?.length) lines.push("## Example", "", ...rule.examples.flatMap(renderExample));

  return lines.join("\n");
}

function renderBadgeRow(rule: RuleDocument) {
  return renderMdcComponent("rule-metadata", {
    pack: rule.pack,
    category: rule.category,
    severity: rule.severity,
    fix: rule.fixable || "",
    source: rule.source,
    sourceUrl: rule.sourceUrl,
    docsUrl: rule.docsUrl || "",
  });
}

function renderMdcComponent(name: string, props: Record<string, string>) {
  return [
    `::${name}`,
    "---",
    ...Object.entries(props).map(([key, value]) => `${key}: ${yamlString(value)}`),
    "---",
    "::",
  ].join("\n");
}

function renderExample(example: RuleExample, index: number) {
  const language = example.language || "ts";
  const lines = [];
  lines.push(`### ${example.title || `Alternative ${index + 1}`}`, "");
  if (example.invalid) {
    lines.push("Before", "");
    lines.push(`\`\`\`${language}`, trimCode(example.invalid), "```", "");
  }
  if (example.valid) {
    lines.push("After", "");
    lines.push(`\`\`\`${language}`, trimCode(example.valid), "```", "");
  }
  return lines;
}

function renderUsefulLink(link: RuleUsefulLink) {
  return `- [${escapeMarkdownText(link.title)}](${link.url})`;
}

interface RuleUsefulLink {
  title: string;
  url: string;
}

function ruleUsefulLinks(rule: RuleDocument): RuleUsefulLink[] {
  const links = new Map<string, RuleUsefulLink>();
  const add = (title: string, url: string) => links.set(url, { title, url });

  if (rule.docsUrl) add("Rule reference", rule.docsUrl);

  if (rule.id === "vue/template/prefer-same-name-prop-shorthand") {
    add(
      "Vue same-name shorthand",
      "https://vuejs.org/guide/essentials/template-syntax.html#same-name-shorthand",
    );
    add("eslint-plugin-vue v-bind-style", "https://eslint.vuejs.org/rules/v-bind-style.html");
  }

  if (rule.id === "vue/template/html-button-has-type") {
    add(
      "HTML button type",
      "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#type",
    );
  }

  if (rule.id === "vue/template/prefer-true-attribute-shorthand") {
    add(
      "eslint-plugin-vue prefer-true-attribute-shorthand",
      "https://eslint.vuejs.org/rules/prefer-true-attribute-shorthand.html",
    );
    add(
      "Vue boolean attributes",
      "https://vuejs.org/guide/essentials/template-syntax.html#boolean-attributes",
    );
  }

  if (rule.id.includes("usefetch") || rule.id.includes("use-fetch")) {
    add("Nuxt useFetch", "https://nuxt.com/docs/4.x/api/composables/use-fetch");
  }

  if (rule.id === "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly") {
    add("NuxtTime", "https://nuxt.com/docs/4.x/api/components/nuxt-time");
    add("ClientOnly", "https://nuxt.com/docs/4.x/api/components/client-only");
  }

  if (rule.id.includes("asyncdata") || rule.id.includes("async-data")) {
    add("Nuxt useAsyncData", "https://nuxt.com/docs/4.x/api/composables/use-async-data");
  }

  if (rule.category === "fetch") {
    add("Nuxt data fetching", "https://nuxt.com/docs/4.x/getting-started/data-fetching");
  }

  if (rule.category === "routing" || rule.category === "middleware") {
    add("Nuxt routing", "https://nuxt.com/docs/4.x/getting-started/routing");
  }

  if (rule.category === "runtime") {
    add("Nuxt runtime config", "https://nuxt.com/docs/4.x/guide/going-further/runtime-config");
  }

  if (rule.category === "images") {
    add("Nuxt Image", "https://image.nuxt.com/");
  }

  if (rule.framework === "nitro") {
    add("Nitro handlers", "https://nitro.build/guide/routing");
  }

  if (rule.framework === "vite" && rule.category === "env") {
    add("Vite env variables and modes", "https://vite.dev/guide/env-and-mode/");
  }

  if (rule.framework === "vite" && rule.category === "plugins") {
    add("Vite plugin API", "https://vite.dev/guide/api-plugin");
  }

  if (rule.id.includes("prefer-use-storage")) {
    add("VueUse useStorage", "https://vueuse.org/core/useStorage/");
  }

  if (
    rule.id.includes("prefer-useevent-listener") ||
    rule.id.includes("prefer-use-event-listener")
  ) {
    add("VueUse useEventListener", "https://vueuse.org/core/useeventlistener/");
  }

  if (rule.id.includes("prefer-usewindow-size")) {
    add("VueUse useWindowSize", "https://vueuse.org/core/usewindowsize/");
  }

  if (rule.id.includes("prefer-usebreakpoints")) {
    add("VueUse useBreakpoints", "https://vueuse.org/core/usebreakpoints/");
  }

  return [...links.values()];
}

function findMetaObjects(ast: any, visitorKeys: typeof import("oxc-parser").visitorKeys) {
  const metas: any[] = [];
  walk(ast, visitorKeys, (node) => {
    if (node.type !== "Property" || propertyName(node) !== "meta") return;
    if (node.value?.type !== "ObjectExpression") return;
    if (!readString(node.value, "id")) return;
    metas.push(node.value);
  });
  return metas;
}

function findValidatedInputRuleOptions(
  ast: any,
  visitorKeys: typeof import("oxc-parser").visitorKeys,
) {
  const options: any[] = [];
  walk(ast, visitorKeys, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier" || node.callee.name !== "createValidatedInputRule")
      return;
    const [opts] = node.arguments ?? [];
    if (opts?.type === "ObjectExpression") options.push(opts);
  });
  return options;
}

function readPackName(ast: any) {
  let packName: string | null = null;
  walk(ast, loadParser().visitorKeys, (node) => {
    if (packName || node.type !== "ObjectExpression") return;
    if (!findProperty(node, "rules")) return;
    packName = readString(node, "name") || null;
  });
  return packName;
}

function readString(object: any, key: string) {
  const value = findProperty(object, key)?.value;
  return typeof value?.value === "string" ? value.value.replace(/\s+/g, " ").trim() : "";
}

function readText(object: any, key: string) {
  const value = findProperty(object, key)?.value;
  if (typeof value?.value === "string") return value.value;
  if (value?.type !== "TemplateLiteral") return "";
  return (
    value.quasis?.map((quasi: any) => quasi.value?.cooked ?? quasi.value?.raw ?? "").join("") ?? ""
  );
}

function readExamples(object: any): RuleExample[] {
  const value = findProperty(object, "examples")?.value;
  if (value?.type !== "ArrayExpression") return [];
  return value.elements
    .filter((element: any) => element?.type === "ObjectExpression")
    .map((element: any) => ({
      title: readString(element, "title"),
      language: readString(element, "language") || "ts",
      invalid: readText(element, "invalid"),
      valid: readText(element, "valid"),
    }))
    .filter((example: RuleExample) => example.invalid || example.valid);
}

function readFixable(object: any): RuleFix {
  const value = findProperty(object, "fixable")?.value?.value;
  return typeof value === "string" ? (value as RuleFix) : "no";
}

function readStringArray(object: any, key: string) {
  const value = findProperty(object, key)?.value;
  if (value?.type !== "ArrayExpression") return [];
  return value.elements
    .map((element: any) => (typeof element?.value === "string" ? element.value : ""))
    .filter(Boolean);
}

function validatedInputReplacement(opts: any) {
  const validatedUtility = readString(opts, "validatedUtility");
  const [rawUtility] = readStringArray(opts, "rawUtilities");
  if (!validatedUtility || !rawUtility) return readString(opts, "suggestion");
  return `Use ${validatedUtility}(event, validator) instead of ${rawUtility}(event) followed by separate validation.`;
}

function validatedInputExamples(opts: any): RuleExample[] {
  const validatedUtility = readString(opts, "validatedUtility");
  const [rawUtility] = readStringArray(opts, "rawUtilities");
  if (!validatedUtility || !rawUtility) return [];
  return [
    {
      title: "Keep reading and validation together",
      language: "ts",
      invalid: `export default defineEventHandler(async (event) => {
  const input = await ${rawUtility}(event)
  const value = validator.parse(input)

  return value
})`,
      valid: `export default defineEventHandler(async (event) => {
  const value = await ${validatedUtility}(event, validator)

  return value
})`,
    },
  ];
}

function findProperty(object: any, name: string) {
  return object.properties?.find((property: any) => propertyName(property) === name) ?? null;
}

function propertyName(property: any) {
  if (property?.type !== "Property" || property.computed) return null;
  if (property.key?.type === "Identifier") return property.key.name;
  if (typeof property.key?.value === "string") return property.key.value;
  return null;
}

function walk(
  node: any,
  visitorKeys: typeof import("oxc-parser").visitorKeys,
  visit: (node: any) => void,
) {
  if (!node || typeof node !== "object") return;
  visit(node);
  const keys = visitorKeys[node.type as keyof typeof visitorKeys] ?? [];
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visitorKeys, visit);
    } else {
      walk(value, visitorKeys, visit);
    }
  }
}

function rulePath(rule: Pick<RuleDocument, "id" | "category" | "pack">) {
  const parts = rule.id.split("/");
  const pathParts =
    parts.length > 2
      ? parts.slice(1)
      : [rule.category || rule.pack.split("/").at(-1) || "rules", parts.at(-1) || rule.id];
  return pathParts.map(slugSegment).join("/");
}

function renderRuleCommand(rule: Pick<RuleDocument, "id" | "framework">) {
  if (rule.framework === "nuxt") return `pnpm nuxt doctor --rules ${rule.id}`;
  if (rule.framework === "typescript") return `pnpm vite-doctor . --rules ${rule.id}`;
  return `pnpm vite-doctor . --framework ${rule.framework} --rules ${rule.id}`;
}

function slugSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stringifyValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function yamlString(value: unknown) {
  return JSON.stringify(stringifyValue(value));
}

function escapeMarkdownText(value: unknown) {
  return stringifyValue(value).replace(
    /\b[A-Za-z_$][\w$]*(?:<[^>\n]+>)?\([^)\n]*\)|<[^>\n]+>/g,
    (match) => `\`${match.replace(/`/g, "\\`")}\``,
  );
}

function trimCode(value: unknown) {
  return stringifyValue(value).replace(/^\n+|\s+$/g, "");
}

function githubSourceUrl(source: string) {
  return `https://github.com/onmax/vite-doctor/blob/main/${source}`;
}

function toCatalogRule(rule: RuleDocument) {
  return {
    id: rule.id,
    title: rule.title,
    description: rule.description,
    pack: rule.pack,
    severity: rule.severity,
    category: rule.category,
    fixable: rule.fixable,
    docsUrl: rule.docsUrl,
    docsPath: rule.path,
    path: rule.path,
    framework: rule.framework,
    source: rule.source,
    sourceUrl: rule.sourceUrl,
  };
}
