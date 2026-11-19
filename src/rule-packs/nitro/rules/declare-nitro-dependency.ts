import { relative, resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { parseScript } from "../../../core/internal/script.js";
import { owningWorkspacePackage } from "../../../core/internal/workspace-packages.js";
import { diagnostics } from "../diagnostics.js";
import {
  declaredIn,
  isLibrary,
  isPackageRuntimeSource,
  isTypeOnlyModuleReference,
  moduleServerRuntime,
  owningPackage,
  runtimeDeclaration,
  type OwningPackage,
} from "./nitro-package.js";
import { hasViteNitroPlugin } from "./server-layout.js";
import { type AnyNode, createRule } from "./shared.js";

const RULE_ID = "nitro/dependencies/declare-nitro";
const NITRO_SPECIFIER = /^nitro(?:\/|$)/;
const HOST_RUNTIME_SPECIFIER =
  /^nitro\/(?:app|cache|context|database|kv|runtime-config|services|storage|task|vite\/runtime)$/;
const HOST_RUNTIME_EXPORTS = new Set(["definePlugin", "useNitroApp", "useRuntimeConfig"]);
/** Entries a package imports to create a Nitro build of its own. */
const NITRO_BUILD_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']nitro\/(?:builder|vite|rsbuild)["']|\bimport\s*\(\s*["']nitro\/(?:builder|vite|rsbuild)["']/m;
const SOURCE_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.output/**", "**/.nitro/**"];

export const declareNitroDependency = createRule({
  meta: {
    id: RULE_ID,
    title: "Declare nitro as a peer in packages that import it",
    description:
      "Flags published packages whose shipped source imports nitro or a nitro/* subpath without declaring nitro, and packages whose Nitro server code imports nitro while declaring it in dependencies or optionalDependencies instead of peerDependencies.",
    why: "Consumers do not install a package's devDependencies. A package that imports nitro/h3 or another nitro subpath without declaring nitro works in its own workspace but cannot resolve it under a strict install, and its consumers get no signal about which Nitro it needs. Packages that declare nuxt get Nitro through the Nuxt app that installs them. A package whose code runs in the app's Nitro server and lists nitro in dependencies gets its own copy of nitro when the ranges differ, so nitro/h3 and the other runtime entries resolve to a Nitro the app does not run.",
    recommendedReplacement:
      "Declare nitro in peerDependencies with the Nitro 3 range the package supports, and keep it in devDependencies for the package's own build and tests.",
    category: "dependencies",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/migration#h3-v2",
    requires: { script: true, nitro: true },
    activationScope: "workspace",
    prefilter: { names: ["nitro"] },
  },
  create(ctx) {
    const owner = owningPackage(ctx);
    if (!owner?.manifest.name || owner.manifest.private === true) return;
    if (!isLibrary(owner.manifest) || !isPackageRuntimeSource(owner)) return;
    const manifest = owner.manifest;
    if (typeof manifest.peerDependencies?.nitro === "string") return;
    const installedIn = declaredIn(manifest, "nitro").find(
      (field) => field === "dependencies" || field === "optionalDependencies",
    );
    if (
      !installedIn &&
      // Nuxt layers and modules run inside a Nuxt app, which installs Nitro.
      ["nuxt", "@nuxt/kit"].some((name) => runtimeDeclaration(manifest, name) !== undefined)
    )
      return;
    const moduleRuntime = installedIn ? moduleServerRuntime(ctx, owner) : undefined;
    const hasHostRuntime =
      installedIn && ((ctx.file.scriptAst?.body ?? []) as AnyNode[]).some(isHostRuntimeReference);
    let reported = false;
    const visit = (node: AnyNode) => {
      const source = node.source;
      if (reported || typeof source?.value !== "string") return;
      if (!NITRO_SPECIFIER.test(source.value)) return;
      if (isTypeOnlyModuleReference(node)) return;
      if (installedIn) {
        const coupled =
          isHostRuntimeReference(node) ||
          (source.value === "nitro/h3" && (moduleRuntime === "server" || hasHostRuntime));
        if (!coupled || moduleRuntime === "unselected" || ownsNitro(ctx, owner)) return;
      }
      reported = true;
      const devOnly = declaredIn(manifest, "nitro").includes("devDependencies");
      ctx.report(
        diagnostics.NITRO0028(
          installedIn
            ? {
                why: `${manifest.name} uses "${source.value}" in code coupled to the app's Nitro server, but declares nitro in ${installedIn} instead of peerDependencies. When its range and the app's differ, consumers install a second nitro for this package, and "${source.value}" resolves to a Nitro the app does not run.`,
                fix: `Move nitro from ${installedIn} to peerDependencies with the Nitro 3 range this package supports, and keep it in devDependencies for the package's own build and tests.`,
              }
            : {
                why: `${manifest.name} imports "${source.value}" but ${devOnly ? "declares nitro only in devDependencies" : "does not declare nitro"}. Consumers that install it under a strict layout cannot resolve nitro.`,
                fix: "Declare nitro in peerDependencies with the Nitro 3 range this package supports.",
              },
        ),
        {
          ruleId: RULE_ID,
          severity: ctx.severity,
          category: "dependencies",
          file: ctx.file.path,
          range: ctx.range(source),
        },
      );
    };
    return {
      ImportDeclaration: visit,
      ExportNamedDeclaration: visit,
      ExportAllDeclaration: visit,
    };
  },
});

function isHostRuntimeReference(node: AnyNode): boolean {
  if (!node.source?.value || isTypeOnlyModuleReference(node)) return false;
  if (HOST_RUNTIME_SPECIFIER.test(node.source.value)) return true;
  if (node.source.value !== "nitro") return false;
  return (node.specifiers ?? []).some((specifier: AnyNode) => {
    if ((specifier.importKind ?? specifier.exportKind) === "type") return false;
    const name =
      specifier.type === "ImportSpecifier"
        ? specifier.imported
        : specifier.type === "ExportSpecifier"
          ? specifier.local
          : undefined;
    return HOST_RUNTIME_EXPORTS.has(name?.name ?? name?.value);
  });
}

/**
 * A Nitro app, or a package that builds its own Nitro, such as a framework on top of it, owns
 * the Nitro its server code runs in, so `nitro` belongs in its dependencies.
 */
function ownsNitro(ctx: RuleContext, owner: OwningPackage): boolean {
  const key = `nitro:owns-nitro:${owner.dir}`;
  const cached = ctx.cache.get<boolean>(key);
  if (cached !== undefined) return cached;
  const packages = projectWorkspacePackages(ctx.project);
  const owns =
    ctx.fs.glob("nitro.config.{ts,mts,cts,js,mjs,cjs}", { cwd: owner.dir }).length > 0 ||
    ctx.fs.glob("vite.config.{ts,mts,cts,js,mjs,cjs}", { cwd: owner.dir }).some((file) => {
      const text = ctx.fs.readText(file);
      const ast = text?.includes("nitro/vite") ? parseScript(file, text) : null;
      return ast !== null && hasViteNitroPlugin(ast);
    }) ||
    ctx.fs
      .glob("**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx,vue}", {
        cwd: owner.dir,
        exclude: SOURCE_EXCLUDE,
      })
      .some((file) => {
        const root = owningWorkspacePackage(packages, relative(ctx.project.root, file));
        if (resolve(ctx.project.root, root) !== owner.dir) return false;
        const inner = file.slice(owner.dir.length + 1);
        if (!isPackageRuntimeSource({ ...owner, path: inner })) return false;
        const text = ctx.fs.readText(file);
        return text !== undefined && NITRO_BUILD_IMPORT.test(text);
      });
  ctx.cache.set(key, owns);
  return owns;
}
