import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";

export const noRequiredOptionalPeer = createRule({
  meta: {
    id: "package/no-required-optional-peer",
    title: "Keep optional peers optional at the default entrypoint",
    description:
      "Find optional peers loaded unconditionally by a package's default JavaScript entrypoint or its required local imports.",
    why: "peerDependenciesMeta.optional lets consumers omit a peer. A static import, re-export, or unconditional load from the default entrypoint still requires that peer, so loading the library can fail before an optional integration is used.",
    recommendedReplacement:
      "Remove optional: true if every consumer needs the peer. Otherwise defer loading it until the integration is requested and handle absence, or expose that integration through a dedicated subpath that the default entrypoint does not load. Doctor conservatively skips guarded and deferred loads; it does not prove that their error handling is correct.",
    examples: [
      {
        title: "Load an optional peer only when its integration is requested",
        language: "js",
        invalid:
          'import peer from "optional-peer";\nexport const core = () => "ready";\nexport const integration = () => peer();',
        valid:
          'export const core = () => "ready";\nexport async function integration() {\n  try {\n    const { default: peer } = await import("optional-peer");\n    return peer();\n  } catch {\n    throw new Error("Install optional-peer to use this integration");\n  }\n}',
      },
    ],
    category: "dependencies",
    severity: "warn",
    fixable: "suggestion",
    diagnosticCodes: ["PKG0003"],
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest", "ast"],
    docsUrl: "https://docs.npmjs.com/cli/configuring-npm/package-json#peerdependenciesmeta",
  },
  create(ctx) {
    return {
      async onProjectStart() {
        const { packageArtifacts } = await import("../artifacts.js");
        const artifacts = packageArtifacts(ctx.project);
        if (!artifacts) return;
        const manifest = artifacts.manifest;
        for (const reference of artifacts.references) {
          const name = reference.packageName;
          if (
            reference.kind !== "runtime" ||
            !reference.required ||
            !manifest.peerDependencies?.[name] ||
            manifest.peerDependenciesMeta?.[name]?.optional !== true ||
            manifest.dependencies?.[name]
          )
            continue;
          ctx.report(
            diagnostics.PKG0003({
              why: `"${name}" is declared as an optional peer but "${reference.specifier}" is loaded unconditionally from a default package entrypoint. Consumers that omit the peer cannot load this entrypoint.`,
              fix: `Make "${name}" a required peer, or move the integration behind a guarded deferred load or a dedicated subpath that the default entrypoint does not load. Do not remove the peer declaration.`,
              sources: [`${reference.file}:${reference.range.line}:${reference.range.column}`],
            }),
            {
              ruleId: "package/no-required-optional-peer",
              severity: ctx.severity,
              category: "dependencies",
              file: reference.file,
              range: reference.range,
              confidence: "manifest-backed",
              evidence: [
                {
                  kind: "manifest",
                  file: `${ctx.project.root}/package.json`,
                  summary: `peerDependenciesMeta["${name}"].optional is true.`,
                },
                {
                  kind: "ast",
                  file: reference.file,
                  range: reference.range,
                  summary:
                    "An unconditional load is reachable through required imports from a default package entrypoint.",
                },
              ],
            },
          );
        }
      },
    };
  },
});
