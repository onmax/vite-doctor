import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

export const noPhantomDependencies = createRule({
  meta: {
    id: "package/no-phantom-dependencies",
    title: "Declare dependencies referenced by published output",
    description:
      "Find external packages referenced by library entrypoints and their reachable JavaScript or declarations but absent from consumer dependency declarations.",
    why: "A library can work in its own workspace while its JavaScript or declarations fail for consumers under isolated dependency layouts. Development dependencies and another package's transitive dependencies do not establish the consumer contract.",
    recommendedReplacement:
      "Declare the referenced package in dependencies or peerDependencies according to who owns it. For a guarded optional integration, declare an optional peer. For declaration-only references, preserve the type dependency for consumers or remove it from the emitted declarations. Rebuild and rerun Doctor; do not infer a compatible version range from an installed transitive dependency.",
    examples: [
      {
        title: "Declare a dependency retained in dist/index.js",
        language: "json",
        invalid: '{ "main": "dist/index.js", "devDependencies": { "h3": "^1.0.0" } }',
        valid: '{ "main": "dist/index.js", "dependencies": { "h3": "^1.0.0" } }',
      },
    ],
    category: "dependencies",
    severity: "warn",
    fixable: "suggestion",
    diagnosticCodes: ["PKG0001", "PKG0002"],
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest", "ast"],
    docsUrl: "https://nubjs.com/blog/phantom-dependencies-package-extensions",
  },
  create(ctx) {
    return {
      async onProjectStart() {
        const { packageArtifacts } = await import("../artifacts.js");
        const artifacts = packageArtifacts(ctx.project);
        if (!artifacts) return;
        const manifest = artifacts.manifest;
        const declared = new Set(
          Object.keys({
            ...manifest.dependencies,
            ...manifest.peerDependencies,
            ...manifest.optionalDependencies,
          }),
        );
        for (const reference of artifacts.references) {
          const name = reference.packageName;
          const typePackage = name.startsWith("@")
            ? `@types/${name.slice(1).replace("/", "__")}`
            : `@types/${name}`;
          if (declared.has(name) || (reference.kind === "types" && declared.has(typePackage)))
            continue;
          const typeOnly = reference.kind === "types";
          const why = `${typeOnly ? "Published declarations" : "Published JavaScript"} reference "${reference.specifier}", but "${name}" is not declared in dependencies, peerDependencies, or optionalDependencies.${manifest.devDependencies?.[name] ? " It is only a development dependency." : ""}`;
          const fix = typeOnly
            ? `Declare "${reference.typeReference ? `${name}" or its type provider "${typePackage}` : name}" in dependencies or peerDependencies, or remove the external reference from emitted declarations. Consumers do not install this package's devDependencies.`
            : `Declare "${name}" in dependencies if the library owns it, or peerDependencies if the host supplies it. Use an optional peer only for an integration that handles its absence. Choose a supported version range and rebuild.`;
          const diagnostic = typeOnly ? diagnostics.PKG0002 : diagnostics.PKG0001;
          ctx.report(
            diagnostic({
              why,
              fix,
              sources: [`${reference.file}:${reference.range.line}:${reference.range.column}`],
            }),
            {
              ruleId: "package/no-phantom-dependencies",
              severity: ctx.severity,
              category: "dependencies",
              file: reference.file,
              range: reference.range,
              confidence: "manifest-backed",
              evidence: [
                {
                  kind: "manifest",
                  file: `${ctx.project.root}/package.json`,
                  summary: `No consumer dependency declaration for ${name}.`,
                },
                {
                  kind: "ast",
                  file: reference.file,
                  range: reference.range,
                  summary: `Literal ${reference.kind} reference in an artifact reachable from a package entrypoint.`,
                },
              ],
            },
          );
        }
      },
    };
  },
});
