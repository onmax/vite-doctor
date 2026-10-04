import { dirname, relative, resolve } from "pathe";
import { createRule, type RuleContext } from "../../../core/index.js";
import { staticString, type AnyNode } from "./shared.js";
import { diagnostics } from "../../../diagnostics.js";

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
        if (!isPublicImport(ctx, source)) return;
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
        if (node.type !== "VAttribute") return;
        const element = node.parent?.parent;
        const tag = element?.rawName;
        const attribute = node.directive ? node.key.argument?.name : node.key.name;
        if (!Object.hasOwn(assetAttributes, tag) || !assetAttributes[tag]!.includes(attribute))
          return;
        if (node.directive && node.key.name.name !== "bind") return;
        if (!node.directive && transformedVueAssets[tag]?.includes(attribute)) return;
        const value = node.directive ? staticString(node.value?.expression) : node.value?.value;
        if (typeof value !== "string" || !value.startsWith("/src/")) return;
        ctx.report(
          diagnostics.VITE0003({
            why: `Source asset "${value}" is referenced by a URL attribute Vue does not transform by default.`,
            fix: "Import the source asset and bind its generated URL, or move it to public and reference it from /.",
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

const transformedVueAssets: Record<string, string[]> = {
  video: ["src", "poster"],
  source: ["src", "srcset"],
  img: ["src", "srcset"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};

const assetAttributes: Record<string, string[]> = {
  ...transformedVueAssets,
  audio: ["src"],
  track: ["src"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
  a: ["href"],
  link: ["href"],
};

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

function isPublicImport(ctx: RuleContext, source: string): boolean {
  const viteInventory = ctx.project.inventory?.vite;
  const publicDir =
    viteInventory && typeof viteInventory === "object" && "publicDir" in viteInventory
      ? viteInventory.publicDir
      : undefined;
  if (publicDir === false || publicDir === "") return false;
  const path = source.split(/[?#]/)[0]!;
  if (isStaticDataImport(path)) return false;
  let target: string | undefined;
  if (path.startsWith("./") || path.startsWith("../"))
    target = resolve(dirname(ctx.file.path), path);
  else if (path.startsWith("/") && !path.startsWith("//"))
    target = resolve(ctx.project.root, `.${path}`);
  else if (ctx.project.nuxt) {
    if (path.startsWith("~~/") || path.startsWith("@@/"))
      target = resolve(ctx.project.root, path.slice(3));
    else if (path.startsWith("~/") || path.startsWith("@/"))
      target = resolve(ctx.project.nuxt.appDir, path.slice(2));
  }
  if (!target) return false;
  const publicPath = relative(
    resolve(ctx.project.root, typeof publicDir === "string" ? publicDir : "public"),
    target,
  );
  return publicPath !== ".." && !publicPath.startsWith("../") && !publicPath.startsWith("/");
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
