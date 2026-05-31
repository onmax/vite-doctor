import { createRule } from "@vue-doctor/core";
import { staticString, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const noPublicSrcImport = createRule({
  meta: {
    id: "vite/assets/no-public-src-import",
    title: "Do not import public media assets",
    category: "assets",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/assets.html#the-public-directory",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        const source = String(node.source?.value ?? "");
        if (!isPublicImport(source)) return;
        ctx.report(
          diagnostics.VITE0002({
            why: `Public media and font assets should be referenced by URL, not imported: ${source}`,
            fix: "Move bundled assets into source, or reference public assets from /. Static JSON data imports are allowed.",
          }),
          {
            ruleId: "vite/assets/no-public-src-import",
            severity: ctx.severity,
            category: "assets",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const noSrcAbsolutePublicUrl = createRule({
  meta: {
    id: "vite/assets/no-src-absolute-public-url",
    title: "Do not URL-reference source files as public assets",
    category: "assets",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/assets.html#static-asset-handling",
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        const value = node.type === "VAttribute" ? node.value?.value : null;
        if (typeof value !== "string" || !value.startsWith("/src/")) return;
        ctx.report(
          diagnostics.VITE0003({
            why: `Source asset "${value}" is referenced as a public URL.`,
            fix: "Import source assets or use a relative URL so Vite can transform them.",
          }),
          {
            ruleId: "vite/assets/no-src-absolute-public-url",
            severity: ctx.severity,
            category: "assets",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const noDynamicNewUrl = createRule({
  meta: {
    id: "vite/assets/no-dynamic-new-url",
    title: "Keep new URL asset paths static",
    category: "assets",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/assets.html#new-url-url-import-meta-url",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "NewExpression" || node.callee?.name !== "URL") return;
        if (isToolingOrServerPath(ctx.file.relativePath) || isFixturePath(ctx.file.relativePath))
          return;
        const [first, second] = node.arguments ?? [];
        if (!second || !ctx.file.text.slice(second.start, second.end).endsWith("import.meta.url"))
          return;
        if (staticString(first)) return;
        if (!isAssetUrlContext(node)) return;
        ctx.report(
          diagnostics.VITE0001({
            why: "Vite cannot reliably include assets from a dynamic new URL() path.",
            fix: "Use a static string path or import.meta.glob for dynamic asset sets.",
          }),
          {
            ruleId: "vite/assets/no-dynamic-new-url",
            severity: ctx.severity,
            category: "assets",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

function isPublicImport(source: string): boolean {
  if (isStaticDataImport(source)) return false;
  return (
    source.startsWith("/public/") || source.startsWith("public/") || source.includes("/public/")
  );
}

function isStaticDataImport(source: string): boolean {
  return /\.(?:json|json5)(?:\?.*)?$/i.test(source);
}

function isAssetUrlContext(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  if (parent?.type === "VariableDeclarator") {
    const name = parent.id?.name ?? "";
    return /(asset|image|img|icon|logo|sprite|src|source|media|font)/i.test(name);
  }
  if (parent?.type === "AssignmentExpression") {
    const name = parent.left?.name ?? parent.left?.property?.name ?? "";
    return /(asset|image|img|icon|logo|sprite|src|source|media|font)/i.test(name);
  }
  if (parent?.type === "CallExpression") {
    const callee = parent.callee?.name ?? parent.callee?.property?.name ?? "";
    return !["fetch", "$fetch", "open", "URL", "fileURLToPath"].includes(callee);
  }
  if (parent?.type === "MemberExpression") {
    const name = parent.property?.name ?? "";
    return /^(src|href|poster)$/.test(name);
  }
  return false;
}

function isToolingOrServerPath(path: string): boolean {
  return /(?:^|\/)(?:src\/node|server|node|packages\/vite\/src\/node)\//.test(path);
}

function isFixturePath(path: string): boolean {
  return /(?:^|\/)(?:playground|fixtures?|test|tests|__tests__)\//.test(path);
}
