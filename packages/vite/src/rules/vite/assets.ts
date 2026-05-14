import { createRule } from "@vue-doctor/core";
import { staticString, type AnyNode } from "./shared.js";

export const noPublicSrcImport = createRule({
  meta: {
    id: "vite/assets/no-public-src-import",
    title: "Do not import files from public",
    category: "assets",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        const source = String(node.source?.value ?? "");
        if (!isPublicImport(source)) return;
        ctx.report({
          ruleId: "vite/assets/no-public-src-import",
          severity: ctx.severity,
          category: "assets",
          file: ctx.file.path,
          range: ctx.range(node),
          message: `Files in public should be referenced by URL, not imported: ${source}`,
          suggestion: "Move the asset into source if it needs bundling, or reference it from /.",
        });
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
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        const value = node.type === "VAttribute" ? node.value?.value : null;
        if (typeof value !== "string" || !value.startsWith("/src/")) return;
        ctx.report({
          ruleId: "vite/assets/no-src-absolute-public-url",
          severity: ctx.severity,
          category: "assets",
          file: ctx.file.path,
          range: ctx.range(node),
          message: `Source asset "${value}" is referenced as a public URL.`,
          suggestion: "Import source assets or use a relative URL so Vite can transform them.",
        });
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
        ctx.report({
          ruleId: "vite/assets/no-dynamic-new-url",
          severity: ctx.severity,
          category: "assets",
          file: ctx.file.path,
          range: ctx.range(node),
          message: "Vite cannot reliably include assets from a dynamic new URL() path.",
          suggestion: "Use a static string path or import.meta.glob for dynamic asset sets.",
        });
      },
    };
  },
});

function isPublicImport(source: string): boolean {
  return (
    source.startsWith("/public/") || source.startsWith("public/") || source.includes("/public/")
  );
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
