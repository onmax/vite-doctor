import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "pathe";
import { createRule, defineRulePack, type DoctorRule } from "@vue-doctor/core";
import { diagnostics } from "../diagnostics.js";

type AnyNode = any;

const ALLOWED_DOCUS_APP_CONFIG_KEYS = new Set([
  "docus",
  "ui",
  "seo",
  "header",
  "navigation",
  "socials",
  "toc",
  "github",
  "assistant",
]);

export const noBrokenInternalToLink = createRule({
  meta: {
    id: "nuxt-content/links/no-broken-internal-to-link",
    title: "Do not link to missing content routes",
    category: "content",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    return {
      onProjectEnd() {
        const contentRoot = join(ctx.project.root, "content");
        if (!existsSync(contentRoot)) return;
        const routes = collectContentRoutes(contentRoot);
        for (const file of collectMarkdownFiles(contentRoot)) {
          const text = readFileSync(file, "utf8");
          for (const link of findInternalToLinks(text)) {
            const route = normalizeRoute(link.value);
            if (!route || routes.has(route)) continue;
            ctx.report(
              diagnostics.NUXT0004({
                why: `Internal content link "${link.value}" does not resolve to a content route.`,
                fix: "Update the `to` target or add the missing content page.",
              }),
              {
                ruleId: "nuxt-content/links/no-broken-internal-to-link",
                severity: "warn",
                category: "content",
                file,
                range: ctx.helpers.rangeFromOffsets(file, text, link.start, link.end),
              },
            );
          }
        }
      },
    };
  },
});

export const noEmptyAppVueShadow = createRule({
  meta: {
    id: "docus/layers/no-empty-app-vue-shadow",
    title: "Do not shadow Docus app.vue with an empty app shell",
    category: "layers",
    severity: "error",
    fixable: "suggestion",
    requires: { nuxt: true, sfc: true },
  },
  create(ctx) {
    if (ctx.file.relativePath !== "app/app.vue") return;
    return {
      SFC() {
        if (!isTrivialAppVue(ctx.file.text)) return;
        ctx.report(
          diagnostics.NUXT0002({
            why: "This app/app.vue shadows Docus' app shell but does not preserve its layout, header, footer, navigation, or search wiring.",
            fix: "Remove app/app.vue or port the Docus app shell behavior into the override.",
          }),
          {
            ruleId: "docus/layers/no-empty-app-vue-shadow",
            severity: "error",
            category: "layers",
            file: ctx.file.path,
            range: ctx.range(0, Math.max(1, ctx.file.text.length)),
          },
        );
      },
    };
  },
});

export const noUnknownAppConfigKey = createRule({
  meta: {
    id: "docus/appconfig/no-unknown-key",
    title: "Use app.config keys read by Docus",
    category: "app-config",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true, script: true },
  },
  create(ctx) {
    if (ctx.file.relativePath !== "app/app.config.ts" && ctx.file.relativePath !== "app.config.ts")
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Property" || node.computed) return;
        if (!isTopLevelDefineAppConfigProperty(node)) return;
        const key = staticPropertyKey(node);
        if (!key || ALLOWED_DOCUS_APP_CONFIG_KEYS.has(key)) return;
        ctx.helpers.report(
          ctx,
          node,
          diagnostics.NUXT0001({
            why: `Docus does not read app.config.${key}.`,
            fix: "Remove this key or move it under a Docus-supported app.config section.",
          }),
          {
            ruleId: "docus/appconfig/no-unknown-key",
            severity: "warn",
            category: "app-config",
          },
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [
  noBrokenInternalToLink,
  noEmptyAppVueShadow,
  noUnknownAppConfigKey,
];

export const docusRulePack = defineRulePack({
  name: "vite-doctor/docus",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["docus"], modules: ["docus"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});

export default docusRulePack;

function collectMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(absolute));
    else if (/\.(md|mdc)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

function collectContentRoutes(root: string): Set<string> {
  const routes = new Set<string>();
  for (const file of collectMarkdownFiles(root)) {
    routes.add(contentFileToRoute(root, file));
  }
  return routes;
}

function contentFileToRoute(root: string, file: string): string {
  const withoutExtension = relative(root, file).replace(/\.(md|mdc)$/, "");
  const segments = withoutExtension
    .split("/")
    .map((segment) => segment.replace(/^\d+\./, ""))
    .filter((segment) => segment !== "index");
  return normalizeRoute(`/${segments.join("/")}`) ?? "/";
}

function findInternalToLinks(text: string): Array<{ value: string; start: number; end: number }> {
  const links: Array<{ value: string; start: number; end: number }> = [];
  const patterns = [/\bto:\s*(["']?)(\/[^"'\s}\]]*)\1/g, /\bto=(["'])(\/[^"']+)\1/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[2];
      if (!value) continue;
      const start = (match.index ?? 0) + match[0].indexOf(value);
      links.push({ value, start, end: start + value.length });
    }
  }
  return links;
}

function normalizeRoute(value: string): string | null {
  if (!value || value.startsWith("//") || value.startsWith("/api/")) return null;
  const [path] = value.split(/[?#]/);
  if (!path || path === "#") return null;
  if (path.includes(":")) return null;
  const normalized = `/${path.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? "/" : normalized;
}

function isTrivialAppVue(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const withoutComments = trimmed.replace(/<!--[\s\S]*?-->/g, "").trim();
  const template = withoutComments
    .match(/<template(?:\s[^>]*)?>([\s\S]*?)<\/template>/)?.[1]
    ?.trim();
  const script = withoutComments
    .replace(/<template(?:\s[^>]*)?>[\s\S]*?<\/template>/g, "")
    .replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/g, "")
    .trim();
  if (!template && !script) return true;
  if (script && !/^<script(?:\s[^>]*)?>\s*<\/script>$/.test(script)) return false;
  if (!template) return true;
  const normalizedTemplate = template.replace(/\s+/g, " ").trim();
  return /^<(NuxtPage|NuxtLayout)(?:\s[^>]*)?\s*\/?>$/.test(normalizedTemplate);
}

function isTopLevelDefineAppConfigProperty(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  const grandparent = parent?.__doctorParent;
  return (
    parent?.type === "ObjectExpression" &&
    grandparent?.type === "CallExpression" &&
    grandparent.arguments?.[0] === parent &&
    grandparent.callee?.type === "Identifier" &&
    grandparent.callee.name === "defineAppConfig"
  );
}

function staticPropertyKey(node: AnyNode): string | null {
  if (node.key?.type === "Identifier") return node.key.name;
  if (typeof node.key?.value === "string") return node.key.value;
  return null;
}
