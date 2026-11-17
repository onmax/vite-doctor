import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import {
  inRunScope,
  exactVersion,
  manifestEntryRange,
  packageWorkspace,
  publishedRange,
  singletonMatcher,
} from "../manifests.js";

const RULE_ID = "package/no-pinned-singleton";

export const noPinnedSingleton = createRule({
  meta: {
    id: RULE_ID,
    title: "Declare singleton packages by range",
    description:
      "Find published workspace packages that declare an exact version of a package the app must load once, such as vue, nuxt, nitro, h3, vite, react or drizzle-orm, in peerDependencies, dependencies or optionalDependencies. catalog: and workspace: specifiers are resolved to the range pnpm publishes. Add packages with the singletons option.",
    why: "An app shares a singleton only when every declaration accepts the app's version. An exact peer fails strict peer checks or makes the package manager install a second copy next to the app's, and an exact dependency installs its own copy whenever the app has another version. Two copies of Vue, Nuxt or React split their state, so injections and composables find nothing, and two copies of h3 or Drizzle fail their identity checks.",
    recommendedReplacement:
      'Declare the peer as a range that accepts the app\'s version, such as "^3.5.44", or point catalog: at a catalog entry that is a range. For a dependency, take the singleton from the app as a peer, or depend on a range. Configure more singletons with ["warn", { "singletons": ["comark", "@ai-sdk/*"] }].',
    examples: [
      {
        title: "Accept the app's Vue",
        language: "json",
        invalid: '{ "peerDependencies": { "vue": "3.5.44" } }',
        valid: '{ "peerDependencies": { "vue": "^3.5.44" } }',
      },
    ],
    category: "dependencies",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    diagnosticCodes: ["PKG0005", "PKG0006"],
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest"],
    docsUrl: "https://pnpm.io/how-peers-are-resolved",
  },
  create(ctx) {
    return {
      onProjectStart() {
        const isSingleton = singletonMatcher(ctx.options);
        const workspace = packageWorkspace(ctx);
        for (const item of workspace.packages) {
          const manifest = item.manifest;
          if (manifest.private || !inRunScope(item)) continue;
          for (const field of [
            "peerDependencies",
            "dependencies",
            "optionalDependencies",
          ] as const) {
            for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
              if (!isSingleton(name)) continue;
              const resolved = publishedRange(workspace, name, specifier);
              const version = resolved && exactVersion(resolved.range);
              if (!version) continue;
              const range = manifestEntryRange(ctx, item.file, item.text, field, name);
              const declared = `${field} "${name}": "${specifier}"`;
              const source = resolved.catalog
                ? ` resolves to ${version} through ${resolved.catalog} in pnpm-workspace.yaml and`
                : specifier.startsWith("workspace:")
                  ? ` is published as ${version} and`
                  : "";
              const peer = field === "peerDependencies";
              const suggested = specifier.startsWith("workspace:")
                ? "workspace:^"
                : `${resolved.alias ?? ""}^${version}`;
              const why = peer
                ? `${declared}${source} pins a package the app must load once. An app on any other ${name} version fails strict peer checks or installs a second ${name} next to its own.`
                : `${declared}${source} pins a package the app must load once. When the app uses another ${name} version, installing ${manifest.name ?? item.root} adds a second copy.`;
              const fix = peer
                ? `Declare "${name}": "${suggested}"${resolved.catalog ? `, or point the peer at a catalog entry that is a range` : ""}, so the package accepts the app's copy.`
                : `Move "${name}" to peerDependencies with a range such as "${suggested}" so the app provides the one copy, or depend on "${suggested}"${resolved.catalog ? ` through a catalog entry that is a range` : ""}.`;
              ctx.report(
                (peer ? diagnostics.PKG0005 : diagnostics.PKG0006)({
                  why,
                  fix,
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
                      summary: `${field}["${name}"] publishes the exact version ${version}.`,
                    },
                  ],
                },
              );
            }
          }
        }
      },
    };
  },
});
