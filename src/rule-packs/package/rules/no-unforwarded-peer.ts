import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { manifestEntryRange, packageWorkspace } from "../manifests.js";

const RULE_ID = "package/no-unforwarded-peer";

export const noUnforwardedPeer = createRule({
  meta: {
    id: RULE_ID,
    title: "Forward the peers of workspace dependencies",
    description:
      "Find published workspace packages that depend on another workspace package without declaring that package's required peers in peerDependencies, dependencies or optionalDependencies.",
    why: "A peer is resolved from the packages above the one that declares it. When package A depends on workspace package B and B requires peer P, an app that installs only A never declares P: a strict install has no P and B fails to load, and an auto-installed P is a copy the app does not share. A development dependency on P covers only A's own tests. Yarn reports the same gap as a missing peer of A.",
    recommendedReplacement:
      "Declare the peer in the dependent package's peerDependencies with the same specifier the workspace dependency uses, and keep a devDependency for its own tests. If the dependent never loads the code that needs the peer, declare it as an optional peer instead.",
    examples: [
      {
        title: "Forward Auth's drizzle-orm peer from Realtime",
        language: "json",
        invalid:
          '{ "name": "@acme/realtime", "dependencies": { "@acme/auth": "workspace:*" } }\n// @acme/auth: { "peerDependencies": { "drizzle-orm": "^1.0.0" } }',
        valid:
          '{ "name": "@acme/realtime", "dependencies": { "@acme/auth": "workspace:*" }, "peerDependencies": { "drizzle-orm": "^1.0.0" } }',
      },
    ],
    category: "dependencies",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    diagnosticCodes: ["PKG0007"],
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest"],
    docsUrl: "https://pnpm.io/how-peers-are-resolved",
  },
  create(ctx) {
    return {
      onProjectStart() {
        const workspace = packageWorkspace(ctx);
        const byName = new Map(
          workspace.packages.flatMap((item) =>
            item.manifest.name ? [[item.manifest.name, item]] : [],
          ),
        );
        for (const item of workspace.packages) {
          const manifest = item.manifest;
          if (manifest.private) continue;
          const declared = new Set(
            Object.keys({
              ...manifest.dependencies,
              ...manifest.optionalDependencies,
              ...manifest.peerDependencies,
            }),
          );
          for (const field of ["dependencies", "optionalDependencies"] as const) {
            for (const dependencyName of Object.keys(manifest[field] ?? {})) {
              const dependency = byName.get(dependencyName);
              if (!dependency || dependency === item) continue;
              const peers = dependency.manifest.peerDependencies ?? {};
              for (const [peer, specifier] of Object.entries(peers)) {
                if (
                  declared.has(peer) ||
                  peer === manifest.name ||
                  dependency.manifest.peerDependenciesMeta?.[peer]?.optional === true
                )
                  continue;
                const name = manifest.name ?? item.root;
                const range = manifestEntryRange(ctx, item.file, item.text, field, dependencyName);
                const development = manifest.devDependencies?.[peer]
                  ? ` "${peer}" is only a development dependency of "${name}".`
                  : "";
                ctx.report(
                  diagnostics.PKG0007({
                    why: `"${name}" depends on "${dependencyName}", which requires the peer "${peer}" ("${specifier}"), but "${name}" does not declare "${peer}". An app that installs "${name}" gets no "${peer}" under strict peers, or a copy it does not share.${development}`,
                    fix: `Add "${peer}": "${specifier}" to peerDependencies of "${name}". If "${name}" never loads the part of "${dependencyName}" that needs "${peer}", declare it as an optional peer in peerDependenciesMeta instead.`,
                    sources: [`${item.file}:${range.line}:${range.column}`],
                  }),
                  {
                    ruleId: RULE_ID,
                    severity: ctx.severity,
                    category: "dependencies",
                    file: item.file,
                    range,
                    confidence: "manifest-backed",
                    evidence: [
                      {
                        kind: "manifest",
                        file: item.file,
                        range,
                        summary: `${field}["${dependencyName}"] and no peerDependencies, dependencies or optionalDependencies entry for ${peer}.`,
                      },
                      {
                        kind: "manifest",
                        file: dependency.file,
                        summary: `peerDependencies["${peer}"] is "${specifier}" and not optional.`,
                      },
                    ],
                  },
                );
              }
            }
          }
        }
      },
    };
  },
});
