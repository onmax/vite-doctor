import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

const toolPackages = new Set([
  "vite",
  "vitest",
  "@nuxt/kit",
  "rollup",
  "rolldown",
  "esbuild",
  "webpack",
  "@rspack/core",
  "unplugin",
  "vite-doctor",
]);
const toolSegments = new Set([
  "cli",
  "vite",
  "nuxt",
  "test",
  "vitest",
  "rollup",
  "rolldown",
  "esbuild",
  "webpack",
  "rspack",
]);

export const optionalPeerImportInTry = createRule({
  meta: {
    id: "package/optional-peer-import-in-try",
    title: "Guard import() of optional packages with try or .catch()",
    description:
      "Find import() calls of optional peers and optional dependencies that no try block in the same function and no .catch() handles, in runtime JavaScript reachable from a package export.",
    why: "esbuild, and the Wrangler, Netlify, and Vite builds that use it, fails the consumer's build when an import() names a package that is not installed. It keeps the import for run time only when the import() sits in a try body of the same function or has a .catch() or two-argument .then(). A try in a caller, or a loader callback passed to a helper that catches, does not count.",
    recommendedReplacement:
      "Write the import() of the optional package inside a try in the function that calls it, and turn a missing package into an error that names the install command. A .catch() on the import() also works.",
    examples: [
      {
        title: "Keep the import() of an optional peer inside the try",
        language: "js",
        invalid: 'export const loadForge = () => importOptional(() => import("forge"), "forge");',
        valid:
          'export async function loadForge() {\n  try {\n    return await import("forge");\n  } catch (error) {\n    throw new Error("Install forge to use this integration", { cause: error });\n  }\n}',
      },
    ],
    category: "dependencies",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    diagnosticCodes: ["PKG0004"],
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest", "ast"],
    docsUrl: "https://esbuild.github.io/api/#non-analyzable-imports",
  },
  create(ctx) {
    return {
      async onProjectStart() {
        const { chainLabeler, describeChain, optionalPeer, packageArtifacts } =
          await import("../artifacts.js");
        for (const artifacts of packageArtifacts(ctx)) {
          const manifest = artifacts.manifest;
          const optional = (name: string) =>
            optionalPeer(manifest, name) ||
            Boolean(
              manifest.optionalDependencies?.[name] &&
              !manifest.dependencies?.[name] &&
              !manifest.peerDependencies?.[name],
            );
          // An entry that loads the package unconditionally is dedicated to it, or PKG0003 reports it.
          const requiredByEntry = new Set(
            artifacts.references.flatMap((reference) =>
              reference.reaches
                .filter((reach) => reach.required)
                .map((reach) => `${reach.entry}\0${reference.packageName}`),
            ),
          );
          // Node loads build tooling itself, so no bundler resolves its import() calls ahead of time.
          const cliPackage = /(?:^|[/-])cli$/.test(manifest.name ?? "");
          const buildTooling = (entry: string) =>
            cliPackage ||
            entry.split("/").some((segment) => toolSegments.has(segment)) ||
            [...toolPackages].some((tool) => requiredByEntry.has(`${entry}\0${tool}`));
          const label = chainLabeler(ctx, artifacts);
          for (const reference of artifacts.references) {
            const name = reference.packageName;
            if (
              reference.kind !== "runtime" ||
              !reference.dynamic ||
              reference.dynamic.handlesAbsence ||
              !optional(name)
            )
              continue;
            const reach = reference.reaches.find(
              (item) => !requiredByEntry.has(`${item.entry}\0${name}`) && !buildTooling(item.entry),
            );
            if (!reach) continue;
            const declaration = manifest.optionalDependencies?.[name]
              ? "an optional dependency"
              : "an optional peer";
            ctx.report(
              diagnostics.PKG0004({
                why: `"${name}" is ${declaration}, and the "${reach.entry}" export reaches import("${reference.specifier}") outside any try or .catch(): ${describeChain(reach.via, label)}. esbuild-based builds of consumers without "${name}" fail on it, even when they never call this code.`,
                fix: `Move import("${reference.specifier}") into a try in this function, and in the catch turn a missing "${name}" into an error that names the install command, or add .catch() to the import(). Do not wrap it in a loader callback for another function to try.`,
                sources: [`${reference.file}:${reference.range.line}:${reference.range.column}`],
              }),
              {
                ruleId: "package/optional-peer-import-in-try",
                severity: ctx.severity,
                category: "dependencies",
                file: reference.file,
                range: reference.range,
                confidence: "manifest-backed",
                evidence: [
                  {
                    kind: "manifest",
                    file: `${artifacts.root}/package.json`,
                    summary: `"${name}" is ${declaration}.`,
                  },
                  {
                    kind: "ast",
                    file: reference.file,
                    range: reference.range,
                    summary: `No try block in the enclosing function and no .catch() handles this import().`,
                  },
                ],
              },
            );
          }
        }
      },
    };
  },
});
