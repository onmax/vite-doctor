import { relative, resolve } from "pathe";
import type {
  DiagnosticEvidence,
  RuleContext,
  RuleFileSystem,
  TemplateAttributeNode,
  TemplateElementNode,
  TemplateTextNode,
} from "../../../../core/index.js";
import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";
import { collectLocaleInventory, findKeyOffset, hasLocaleFiles } from "./i18n-locales.js";
import type { LocaleMessage } from "./i18n-locales.js";
import { collectTranslationUsage, isKeyUsed, type TranslationUsage } from "./i18n-usage.js";

const I18N_PACKAGE_NAMES = new Set(["vue-i18n", "@nuxtjs/i18n"]);
const STATIC_TEXT_ATTRIBUTES = new Set(["alt", "aria-label", "label", "placeholder", "title"]);

export const noUnusedTranslations = createRule({
  meta: {
    id: "vue/i18n/no-unused-translations",
    title: "Disallow unused translations",
    category: "i18n",
    severity: "warn",
    confidence: "heuristic-medium",
    requires: { vue: true, crossFile: true },
    requiresContext: ["cross-file"],
    execution: "manifest",
    cost: "medium",
  },
  create(ctx) {
    return {
      onProjectEnd() {
        const root = ctx.project.root;
        const inventory = collectLocaleInventory(ctx.fs, root);
        if (inventory.messages.length === 0) return;
        const usage = collectTranslationUsage(
          ctx.fs,
          root,
          new Set(inventory.files),
          inventory.messages,
        );
        for (const message of inventory.messages) {
          if (
            message.locale !== inventory.baseLocale ||
            isLocaleMetadataKey(message.key) ||
            [message.key, ...message.aliases].some((key) => isKeyUsed(usage, key))
          )
            continue;
          reportUnusedTranslation(ctx, message, inventory.baseLocale, usage);
        }
      },
    };
  },
});

function reportUnusedTranslation(
  ctx: RuleContext,
  message: LocaleMessage,
  baseLocale: string,
  usage: TranslationUsage,
) {
  const root = ctx.project.root;
  const subject = `Translation key "${message.key}" in base locale "${baseLocale}"`;
  const evidence: DiagnosticEvidence[] = [
    {
      kind: "facts",
      summary: `Scanned ${count(usage.sourceFiles, "source file")} and ${count(usage.references, "translation reference")}; none uses this key, its prefix, or a linked message that points to it.`,
    },
  ];
  const [firstDynamic] = usage.dynamic;
  if (firstDynamic) {
    const text = ctx.fs.readText(firstDynamic.file) ?? "";
    evidence.push({
      kind: "facts",
      summary: `${count(usage.dynamic.length, "translation call")} ${usage.dynamic.length === 1 ? "passes" : "pass"} a key that is only known at runtime, so usage is partial evidence.`,
      file: firstDynamic.file,
      range: ctx.helpers.rangeFromOffsets(
        firstDynamic.file,
        text,
        firstDynamic.start,
        firstDynamic.end,
      ),
    });
  }
  const [firstUnparsed] = usage.unparsedFiles;
  if (firstUnparsed) {
    evidence.push({
      kind: "facts",
      summary: `${count(usage.unparsedFiles.length, "source file")} could not be parsed and ${usage.unparsedFiles.length === 1 ? "was" : "were"} scanned with a fallback pattern, so usage is partial evidence.`,
      file: firstUnparsed,
    });
  }
  const why = firstDynamic
    ? `${subject} has no static reference, but ${count(usage.dynamic.length, "dynamic translation call")} (first in ${relative(root, firstDynamic.file)}) build keys Doctor cannot resolve and could reach it.`
    : firstUnparsed
      ? `${subject} has no static reference, but Doctor could only pattern-scan ${count(usage.unparsedFiles.length, "source file")} (first ${relative(root, firstUnparsed)}), so a reference there may be missed.`
      : `${subject} has no reference: no translation call, <i18n-t>, v-t, linked message, or string literal in ${count(usage.sourceFiles, "scanned source file")} uses it.`;
  const partial = Boolean(firstDynamic || firstUnparsed);
  ctx.report(
    diagnostics.VUE0002({
      why,
      fix: partial
        ? `Check that no runtime-built key resolves to "${message.key}", then delete it from every locale file.`
        : `Delete "${message.key}" from every locale file, or reference it with t('${message.key}') if the UI still needs it.`,
    }),
    {
      ruleId: "vue/i18n/no-unused-translations",
      severity: "warn",
      category: "i18n",
      file: message.file.path,
      range: ctx.helpers.rangeFromOffsets(
        message.file.path,
        message.file.text,
        findKeyOffset(message.file, message.key, message.value),
      ),
      confidence: partial ? "heuristic-medium" : "heuristic-high",
      evidence,
    },
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export const noUntranslatedText = createRule({
  meta: {
    id: "vue/i18n/no-untranslated-text",
    title: "Disallow untranslated visible text",
    category: "i18n",
    severity: "warn",
    confidence: "heuristic-medium",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    const cacheKey = `vue-i18n:project-has-i18n:${ctx.project.root}`;
    let hasI18n = ctx.cache.get<boolean>(cacheKey);
    if (hasI18n === undefined) {
      hasI18n = projectHasI18n(ctx.fs, ctx.project.root);
      ctx.cache.set(cacheKey, hasI18n);
    }
    if (!hasI18n) return;
    let translationDepth = 0;
    const reportText = (node: TemplateTextNode | TemplateAttributeNode, why: string, fix: string) =>
      ctx.helpers.report(ctx, node, diagnostics.VUE0001({ why, fix }), {
        ruleId: "vue/i18n/no-untranslated-text",
        severity: "warn",
        category: "i18n",
      });
    return {
      template: {
        element(node) {
          if (isI18nTranslation(node)) translationDepth++;
        },
        "element:exit"(node) {
          if (isI18nTranslation(node)) translationDepth--;
        },
        text(node) {
          if (translationDepth > 0) return;
          const value = normalizeVisibleText(node.content);
          if (!isUserFacingText(value)) return;
          reportText(
            node,
            `Visible text "${truncate(value)}" should come from Vue i18n.`,
            "Replace the hardcoded text with t(), $t(), or <i18n-t>.",
          );
        },
        attribute(node) {
          if (translationDepth > 0 || !STATIC_TEXT_ATTRIBUTES.has(node.name)) return;
          const value = normalizeVisibleText(node.value?.content ?? "");
          if (!isUserFacingText(value)) return;
          reportText(
            node,
            `Attribute "${node.name}" contains untranslated text "${truncate(value)}".`,
            "Bind the attribute to t() or $t().",
          );
        },
      },
    };
  },
});

function projectHasI18n(fs: RuleFileSystem, root: string): boolean {
  return hasLocaleFiles(fs, root) || projectHasI18nPackage(fs, root);
}

function projectHasI18nPackage(fs: RuleFileSystem, root: string): boolean {
  const pkg: any = fs.readJson(resolve(root, "package.json"));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies };
  return Object.keys(deps).some((name) => I18N_PACKAGE_NAMES.has(name));
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isUserFacingText(value: string): boolean {
  if (!value) return false;
  if (value.length < 2) return false;
  if (/^[\d\s.,:;!?()[\]{}'"`/\\|+*=<>_-]+$/.test(value)) return false;
  if (/^(https?:|\/|#|[\w-]+\/[\w-]+)/.test(value)) return false;
  if (/^["'`]?[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\($/.test(value)) return false;
  if (/^[a-z0-9_.:-]+$/.test(value) && !/\s/.test(value)) return false;
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value);
}

function isI18nTranslation(element: TemplateElementNode): boolean {
  return element.tag === "i18n-t" || element.tag === "I18nT";
}

function isLocaleMetadataKey(key: string): boolean {
  return key.split(".").some((part) => part.startsWith("$"));
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}
