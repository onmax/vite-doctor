import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "pathe";
import { parseSync, visitorKeys } from "oxc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const vueSources = ruleSourcesFromIndex(join(root, "packages/core/src/rules/vue/index.ts"));
const nuxtRulesDir = join(root, "packages/nuxt/src/rules");
const nuxtSources = [
  ...ruleSourcesFromIndex(join(nuxtRulesDir, "nuxt/index.ts")),
  ...readdirSync(nuxtRulesDir)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts" && file !== "nuxt.ts")
    .sort()
    .map((file) => join(nuxtRulesDir, file)),
];

const vueRules = collectRules(vueSources, "vue-doctor/vue");
const nuxtRules = collectRules(nuxtSources, "nuxt-doctor/nuxt");
const publicRulesDir = join(root, "docs/public/rules");

mkdirSync(publicRulesDir, { recursive: true });
writeJson(join(publicRulesDir, "vue.json"), { rules: vueRules });
writeJson(join(publicRulesDir, "nuxt.json"), { rules: nuxtRules });
writeJson(join(publicRulesDir, "all.json"), { rules: [...vueRules, ...nuxtRules] });

writeRuleDocs({
  dir: join(root, "docs/content/1.vue/3.rules"),
  index: {
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
    title: "Rules",
    description: "Nuxt 4 diagnostics in the Nuxt and ecosystem rule packs.",
    intro: [
      "Nuxt rules cover auto-imports, fetching, routing, Nuxt context, Nitro/server boundaries, runtime config, hydration, middleware security, state serialization, content, Docus, and optional module overlays.",
      "These pages are generated from rule metadata in `packages/nuxt/src/rules`.",
    ],
    command: "vp exec nuxt-doctor rules --format json",
  },
  rules: nuxtRules,
});

function collectRules(files, defaultPack) {
  return files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const ast = parseSync(file, text, { sourceType: "module", lang: "ts" }).program;
    const pack = readPackName(ast) ?? defaultPack ?? fallbackPackName(file);
    return findMetaObjects(ast)
      .map((meta) => ({
        pack,
        source: relative(root, file),
        id: readString(meta, "id"),
        title: readString(meta, "title"),
        description: readString(meta, "description"),
        why: readString(meta, "why"),
        recommendedReplacement: readString(meta, "recommendedReplacement"),
        category: readString(meta, "category"),
        severity: readString(meta, "severity"),
        fixable: readFixable(meta),
        docsUrl: readString(meta, "docsUrl"),
      }))
      .filter((rule) => rule.id);
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

  writeFileSync(join(dir, "index.md"), renderRulesIndex({ ...index, rules }));

  for (const rule of rules) {
    const file = join(dir, `${rulePath(rule)}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderRulePage(rule));
  }
}

function renderRulesIndex({ title, description, intro, command, rules }) {
  const lines = [
    "---",
    `title: ${yamlString(title)}`,
    `description: ${yamlString(description)}`,
    "---",
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
        `[\`${rule.id}\`](./${rulePath(rule)})`,
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
    `# ${title}`,
    "",
    `\`${rule.id}\``,
    "",
  ];

  if (rule.description) lines.push(rule.description, "");
  if (rule.why) lines.push("## Why", "", rule.why, "");
  if (rule.recommendedReplacement) {
    lines.push("## Prefer", "", rule.recommendedReplacement, "");
  }

  lines.push(
    "## Metadata",
    "",
    `- Pack: \`${rule.pack}\``,
    `- Severity: \`${rule.severity}\``,
    `- Category: \`${rule.category}\``,
    `- Fix: ${rule.fixable ? `\`${rule.fixable}\`` : "none"}`,
    `- Source: \`${rule.source}\``,
  );

  if (rule.docsUrl) lines.push(`- Docs: ${rule.docsUrl}`);

  lines.push("");
  return lines.join("\n");
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

function readFixable(object) {
  const value = findProperty(object, "fixable")?.value?.value;
  if (typeof value === "string") return value;
  return value === false ? "no" : "no";
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
]) {
  if (!existsSync(dirname(file))) throw new Error(`Missing docs directory for ${file}`);
}
