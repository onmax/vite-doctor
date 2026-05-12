import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "pathe";
import { parseSync, visitorKeys } from "oxc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const vueSources = ruleSourcesFromIndex(join(root, "packages/core/src/rules/vue/index.ts"));
const nuxtRulesDir = join(root, "packages/nuxt/src/rules");
const nitroRulesDir = join(nuxtRulesDir, "nitro");
const nitroSources = readdirSync(nitroRulesDir)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .sort()
  .map((file) => join(nitroRulesDir, file));
const nuxtSources = [
  ...ruleSourcesFromIndex(join(nuxtRulesDir, "nuxt/index.ts")),
  ...readdirSync(nuxtRulesDir)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts" && file !== "nuxt.ts")
    .sort()
    .map((file) => join(nuxtRulesDir, file)),
];

const vueRules = collectRules(vueSources, "vue-doctor/vue");
const nuxtRules = collectRules(nuxtSources, "nuxt-doctor/nuxt");
const nitroRules = collectRules(nitroSources, "nuxt-doctor/nitro");
const publicRulesDir = join(root, "docs/public/rules");

mkdirSync(publicRulesDir, { recursive: true });
writeJson(join(publicRulesDir, "vue.json"), { rules: vueRules });
writeJson(join(publicRulesDir, "nitro.json"), { rules: nitroRules });
writeJson(join(publicRulesDir, "nuxt.json"), { rules: [...vueRules, ...nitroRules, ...nuxtRules] });
writeJson(join(publicRulesDir, "all.json"), { rules: [...vueRules, ...nitroRules, ...nuxtRules] });

writeRuleDocs({
  dir: join(root, "docs/content/1.vue/3.rules"),
  index: {
    basePath: "/vue/rules",
    title: "Rules",
    description: "Vue 3.5 diagnostics in the core rule pack.",
    intro: [
      "Vue rules cover reactivity, computed values, watchers, lifecycle cleanup, template correctness, SSR safety, and template security.",
      "These pages are generated from rule metadata in `packages/core/src/rules/vue.ts`.",
    ],
    command: "vp exec vue-doctor rules --format json",
  },
  rules: vueRules,
});

writeRuleDocs({
  dir: join(root, "docs/content/2.nuxt/4.rules"),
  index: {
    basePath: "/nuxt/rules",
    title: "Rules",
    description: "Nuxt 4 diagnostics in the Nuxt and ecosystem rule packs.",
    intro: [
      "Nuxt Doctor consumes Vue, Nitro, Nuxt, and ecosystem rule packs for full-stack application diagnostics.",
      "Nuxt-specific rules cover auto-imports, fetching, routing, Nuxt context, runtime config, hydration, middleware security, state serialization, content, Docus, and optional module overlays.",
      "These pages are generated from rule metadata in `packages/nuxt/src/rules`.",
    ],
    command: "vp exec nuxt-doctor rules --format json",
  },
  rules: nuxtRules,
});

writeRuleDocs({
  dir: join(root, "docs/content/3.nitro/2.rules"),
  index: {
    basePath: "/nitro/rules",
    title: "Rules",
    description: "Nitro request-runtime diagnostics in the Nuxt Doctor rule pack.",
    intro: [
      "Nitro rules cover server and request-runtime boundaries, event-aware helpers, validation, HTTP method assertions, and request metadata.",
      "Nuxt Doctor consumes this independent Nitro rule pack for `server/` and `app/server/` diagnostics.",
      "These pages are generated from rule metadata in `packages/nuxt/src/rules/nitro`.",
    ],
    command: "vp exec nuxt-doctor rules --format json",
  },
  rules: nitroRules,
});

function collectRules(files, defaultPack) {
  return files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const ast = parseSync(file, text, { sourceType: "module", lang: "ts" }).program;
    const pack = readPackName(ast) ?? defaultPack ?? fallbackPackName(file);
    const metaRules = findMetaObjects(ast)
      .map((meta) => ({
        pack,
        source: relative(root, file),
        id: readString(meta, "id"),
        title: readString(meta, "title"),
        description: readString(meta, "description"),
        why: readString(meta, "why"),
        recommendedReplacement: readString(meta, "recommendedReplacement"),
        examples: readExamples(meta),
        category: readString(meta, "category"),
        severity: readString(meta, "severity"),
        fixable: readFixable(meta),
        docsUrl: readString(meta, "docsUrl"),
      }))
      .filter((rule) => rule.id);
    const helperRules = findValidatedInputRuleOptions(ast).map((opts) => ({
      pack,
      source: relative(root, file),
      id: readString(opts, "id"),
      title: readString(opts, "title"),
      description: readString(opts, "description"),
      why: "Raw request input and validation can drift apart when they are separate operations. Nitro and h3 provide validated helpers that keep parsing and validation coupled at the request boundary.",
      recommendedReplacement: validatedInputReplacement(opts),
      examples: validatedInputExamples(opts),
      category: "request",
      severity: "warn",
      fixable: "suggestion",
      docsUrl: "",
    }));
    return [...metaRules, ...helperRules].filter((rule) => rule.id);
  });
}

function ruleSourcesFromIndex(indexFile) {
  const dir = dirname(indexFile);
  return readFileSync(indexFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^export \{ \w+ \} from "\.\/(.+)\.js";$/)?.[1])
    .filter(Boolean)
    .map((file) => join(dir, `${file}.ts`));
}

function writeRuleDocs({ dir, index, rules }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, ".navigation.yml"), renderRulesNavigation(rules));
  writeFileSync(join(dir, "index.md"), renderRulesIndex({ ...index, rules }));

  const categories = new Map();
  for (const rule of rules) {
    const path = rulePath(rule);
    const [category] = path.split("/");
    categories.set(category, categoryTitle(rule.category || category));

    const file = join(dir, `${path}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderRulePage(rule));
  }

  for (const [category, title] of [...categories].sort(([a], [b]) => a.localeCompare(b))) {
    writeFileSync(join(dir, category, ".navigation.yml"), `title: ${yamlString(title)}\n`);
  }
}

function renderRulesIndex({ basePath, title, description, intro, command, rules }) {
  const lines = [
    "---",
    `title: ${yamlString("Rule reference")}`,
    `description: ${yamlString(description)}`,
    "---",
    "",
    `# ${title}`,
    "",
    ...intro.flatMap((line) => [line, ""]),
    "The same metadata is exported as JSON under `/rules/` in the docs site.",
    "",
    "## Rules",
    "",
  ];

  lines.push(
    ...renderMarkdownTable(
      ["Rule", "Title", "Pack", "Severity", "Category", "Fix"],
      rules.map((rule) => [
        `[\`${rule.id}\`](${basePath}/${rulePath(rule)})`,
        cell(rule.title),
        `\`${rule.pack}\``,
        `\`${rule.severity}\``,
        `\`${rule.category}\``,
        cell(rule.fixable),
      ]),
    ),
  );

  lines.push(
    "",
    "## JSON export",
    "",
    "The docs build also writes static JSON files:",
    "",
    "- `/rules/vue.json`",
    "- `/rules/nitro.json`",
    "- `/rules/nuxt.json`",
    "- `/rules/all.json`",
    "",
    "Run:",
    "",
    "```bash",
    command,
    "```",
    "",
  );
  return `${lines.join("\n")}`;
}

function renderRulesNavigation(rules) {
  const categories = [...new Set(rules.map((rule) => rulePath(rule).split("/")[0]).filter(Boolean))]
    .map(String)
    .sort((a, b) => a.localeCompare(b));

  return [
    "title: Rules",
    "navigation:",
    "  - index.md",
    ...categories.map((category) => `  - ${category}`),
    "",
  ].join("\n");
}

function renderRulePage(rule) {
  const title = rule.title || rule.id;
  const description = rule.description || `${rule.id} in ${rule.pack}.`;
  const lines = [
    "---",
    `title: ${yamlString(title)}`,
    `description: ${yamlString(description)}`,
    `ruleId: ${yamlString(rule.id)}`,
    `pack: ${yamlString(rule.pack)}`,
    `severity: ${yamlString(rule.severity)}`,
    `category: ${yamlString(rule.category)}`,
    `fix: ${yamlString(rule.fixable || "no")}`,
    "---",
    "",
    `\`${rule.id}\``,
    "",
  ];

  if (rule.description) lines.push(escapeMarkdownText(rule.description), "");
  lines.push(renderBadgeRow(rule), "");
  if (rule.examples?.length) lines.push("## Examples", "", ...rule.examples.flatMap(renderExample));
  if (rule.why) lines.push("## Why", "", escapeMarkdownText(rule.why), "");
  if (rule.recommendedReplacement) {
    lines.push("## Prefer", "", escapeMarkdownText(rule.recommendedReplacement), "");
  }

  lines.push("## Metadata", "", renderMetadata(rule));

  lines.push("");
  return lines.join("\n");
}

function renderBadgeRow(rule) {
  const props = {
    pack: rule.pack,
    category: rule.category,
    severity: rule.severity,
    fix: rule.fixable || "",
  };

  return [
    "::rule-badges",
    "---",
    ...Object.entries(props).map(([key, value]) => `${key}: ${yamlString(value)}`),
    "---",
    "::",
  ].join("\n");
}

function renderMetadata(rule) {
  const props = {
    pack: rule.pack,
    category: rule.category,
    severity: rule.severity,
    fix: rule.fixable || "",
    source: rule.source,
    sourceUrl: githubSourceUrl(rule.source),
    docsUrl: rule.docsUrl || "",
  };

  return [
    "::rule-metadata",
    "---",
    ...Object.entries(props).map(([key, value]) => `${key}: ${yamlString(value)}`),
    "---",
    "::",
  ].join("\n");
}

function renderExample(example, index) {
  const language = example.language || "ts";
  const lines = [];
  if (example.title) lines.push(`### ${escapeMarkdownText(example.title)}`, "");
  if (example.invalid) {
    lines.push(index === 0 ? "Reported pattern:" : "Another reported pattern:", "");
    lines.push("```" + language, trimCode(example.invalid), "```", "");
  }
  if (example.valid) {
    lines.push("Possible fix:", "");
    lines.push("```" + language, trimCode(example.valid), "```", "");
  }
  return lines;
}

function findMetaObjects(ast) {
  const metas = [];
  walk(ast, (node) => {
    if (node.type !== "Property" || propertyName(node) !== "meta") return;
    if (node.value?.type !== "ObjectExpression") return;
    if (!readString(node.value, "id")) return;
    metas.push(node.value);
  });
  return metas;
}

function findValidatedInputRuleOptions(ast) {
  const options = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier" || node.callee.name !== "createValidatedInputRule")
      return;
    const [opts] = node.arguments ?? [];
    if (opts?.type === "ObjectExpression") options.push(opts);
  });
  return options;
}

function readPackName(ast) {
  let packName = null;
  walk(ast, (node) => {
    if (packName || node.type !== "ObjectExpression") return;
    if (!findProperty(node, "rules")) return;
    packName = readString(node, "name") || null;
  });
  return packName;
}

function readString(object, key) {
  const value = findProperty(object, key)?.value;
  return typeof value?.value === "string" ? value.value.replace(/\s+/g, " ").trim() : "";
}

function readText(object, key) {
  const value = findProperty(object, key)?.value;
  if (typeof value?.value === "string") return value.value;
  if (value?.type !== "TemplateLiteral") return "";
  return value.quasis?.map((quasi) => quasi.value?.cooked ?? quasi.value?.raw ?? "").join("") ?? "";
}

function readExamples(object) {
  const value = findProperty(object, "examples")?.value;
  if (value?.type !== "ArrayExpression") return [];
  return value.elements
    .filter((element) => element?.type === "ObjectExpression")
    .map((element) => ({
      title: readString(element, "title"),
      language: readString(element, "language") || "ts",
      invalid: readText(element, "invalid"),
      valid: readText(element, "valid"),
    }))
    .filter((example) => example.invalid || example.valid);
}

function readFixable(object) {
  const value = findProperty(object, "fixable")?.value?.value;
  if (typeof value === "string") return value;
  return value === false ? "no" : "no";
}

function readStringArray(object, key) {
  const value = findProperty(object, key)?.value;
  if (value?.type !== "ArrayExpression") return [];
  return value.elements
    .map((element) => (typeof element?.value === "string" ? element.value : ""))
    .filter(Boolean);
}

function validatedInputReplacement(opts) {
  const validatedUtility = readString(opts, "validatedUtility");
  const [rawUtility] = readStringArray(opts, "rawUtilities");
  if (!validatedUtility || !rawUtility) return readString(opts, "suggestion");
  return `Use ${validatedUtility}(event, validator) instead of ${rawUtility}(event) followed by separate validation.`;
}

function validatedInputExamples(opts) {
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

function findProperty(object, name) {
  return object.properties?.find((property) => propertyName(property) === name) ?? null;
}

function propertyName(property) {
  if (property?.type !== "Property" || property.computed) return null;
  if (property.key?.type === "Identifier") return property.key.name;
  if (typeof property.key?.value === "string") return property.key.value;
  return null;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  const keys = visitorKeys[node.type] ?? [];
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else {
      walk(value, visit);
    }
  }
}

function fallbackPackName(file) {
  const basename = file.split("/").at(-1)?.replace(/\.ts$/, "") ?? "rules";
  return basename === "vue" ? "vue-doctor/vue" : `nuxt-doctor/${basename}`;
}

function rulePath(rule) {
  const parts = rule.id.split("/");
  const pathParts =
    parts.length > 2
      ? parts.slice(1)
      : [rule.category || rule.pack.split("/").at(-1), parts.at(-1)];
  return pathParts.map(slugSegment).join("/");
}

function slugSegment(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function categoryTitle(value) {
  return slugSegment(value)
    .split("-")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function cell(value) {
  if (!value) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function escapeMarkdownText(value) {
  return String(value ?? "").replace(
    /\b[A-Za-z_$][\w$]*(?:<[^>\n]+>)?\([^)\n]*\)|<[^>\n]+>/g,
    (match) => `\`${match.replace(/`/g, "\\`")}\``,
  );
}

function trimCode(value) {
  return String(value ?? "").replace(/^\n+|\s+$/g, "");
}

function githubSourceUrl(source) {
  return `https://github.com/onmax/nuxt-doctor/blob/main/${source}`;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function renderMarkdownTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, 3, ...rows.map((row) => visibleLength(row[index] ?? ""))),
  );
  const renderRow = (row) =>
    `| ${row.map((value, index) => `${value}${" ".repeat(widths[index] - visibleLength(value))}`).join(" | ")} |`;
  return [
    renderRow(headers),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(renderRow),
  ];
}

function visibleLength(value) {
  return String(value).length;
}

for (const file of [
  join(root, "docs/content/1.vue/3.rules/index.md"),
  join(root, "docs/content/2.nuxt/4.rules/index.md"),
  join(root, "docs/content/3.nitro/2.rules/index.md"),
]) {
  if (!existsSync(dirname(file))) throw new Error(`Missing docs directory for ${file}`);
}
