import { createRule } from "../../../core/index.js";
import type { EntryReach, PackageReference } from "../artifacts.js";
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
    confidence: "manifest-backed",
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
        const {
          chainLabeler,
          defaultEntry,
          describeChain,
          installedPackageArtifacts,
          installedWith,
          matchExportKey,
          optionalPeer,
          packageArtifacts,
        } = await import("../artifacts.js");
        for (const artifacts of packageArtifacts(ctx)) {
          const manifest = artifacts.manifest;
          const label = chainLabeler(ctx, artifacts);
          const report = (
            reference: PackageReference,
            reach: EntryReach,
            why: string,
            fix: string,
            evidence: string,
          ) =>
            ctx.report(
              diagnostics.PKG0003({
                why,
                fix,
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
                  { kind: "manifest", file: `${artifacts.root}/package.json`, summary: evidence },
                  {
                    kind: "ast",
                    file: reference.file,
                    range: reference.range,
                    summary: `The "${reach.entry}" export loads it unconditionally: ${describeChain(reach.via, label)}.`,
                  },
                ],
              },
            );
          for (const reference of artifacts.references) {
            if (reference.kind !== "runtime") continue;
            const name = reference.packageName;
            const ownOptional = optionalPeer(manifest, name);
            const defaultReach = reference.required
              ? reference.reaches.find((reach) => reach.entry === defaultEntry && reach.required)
              : undefined;
            if (ownOptional && defaultReach) {
              report(
                reference,
                defaultReach,
                `"${name}" is declared as an optional peer, but the "${defaultEntry}" export loads "${reference.specifier}" unconditionally: ${describeChain(defaultReach.via, label)}. Consumers that omit the peer cannot load this entrypoint.`,
                `Make "${name}" a required peer, or move the integration behind a guarded deferred load or a dedicated subpath that the default entrypoint does not load. Do not remove the peer declaration.`,
                `peerDependenciesMeta["${name}"].optional is true.`,
              );
              continue;
            }
            const subpath = `.${reference.specifier.slice(name.length)}`;
            if (subpath === defaultEntry || name === manifest.name) continue;
            const requiredReaches = reference.reaches.filter(
              (reach) => reach.required && reach.executionRequired !== false,
            );
            if (!requiredReaches.length) continue;
            const peer = installedPackageArtifacts(ctx, name, reference.file);
            const peerEntry = peer && matchExportKey(peer.manifest, subpath);
            if (!peer || !peerEntry) continue;
            const peerLabel = chainLabeler(ctx, peer);
            const reported = new Set<string>();
            for (const loaded of peer.references) {
              const transitive = loaded.packageName;
              const peerReach = loaded.reaches.find(
                (reach) =>
                  reach.entry === peerEntry &&
                  reach.required &&
                  (!reach.mode || reach.mode === reference.loadMode),
              );
              if (
                !peerReach ||
                loaded.kind !== "runtime" ||
                reported.has(transitive) ||
                transitive === manifest.name ||
                transitive === name ||
                installedWith(peer.manifest, transitive) ||
                installedWith(manifest, transitive)
              )
                continue;
              // An optional peer that this package also declares may back a dedicated subpath.
              const reach = optionalPeer(manifest, transitive)
                ? requiredReaches.find((item) => item.entry === defaultEntry)
                : requiredReaches[0];
              if (!reach) continue;
              reported.add(transitive);
              const status = optionalPeer(peer.manifest, transitive)
                ? `an optional peer of ${name}`
                : peer.manifest.devDependencies?.[transitive]
                  ? `only a devDependency of ${name}`
                  : `not declared by ${name}`;
              const own = optionalPeer(manifest, transitive)
                ? "an optional peer of this package"
                : "not declared by this package";
              const chain = `${describeChain(reach.via, label)} → ${describeChain(peerReach.via, peerLabel)}`;
              report(
                reference,
                reach,
                `The "${reach.entry}" export loads "${reference.specifier}" unconditionally, and that ${name} subpath loads "${transitive}", which is ${status} and ${own}: ${chain}. Installing ${name} does not install "${transitive}", so consumers without it cannot load this entrypoint.`,
                `Load "${reference.specifier}" lazily, inside a try that handles a missing "${transitive}", where the feature needs it. If every consumer of "${reach.entry}" needs it, declare "${transitive}" in peerDependencies instead${reach.entry === defaultEntry ? "" : ", optional when only this subpath needs it"}.`,
                `"${transitive}" is ${status}, and ${own}.`,
              );
            }
          }
        }
      },
    };
  },
});
