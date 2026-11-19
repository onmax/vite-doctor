import { relative, resolve } from "pathe";
import { parse, rcompare, valid } from "semver";
import { createRule } from "../../../core/index.js";
import { diagnostics } from "../diagnostics.js";
import { parsePnpmLockfile, resolvedCopies, type ResolvedCopy } from "../lockfile.js";
import { manifestEntryRange, packageWorkspace, singletonMatcher } from "../manifests.js";

const RULE_ID = "package/no-duplicate-singleton";

export const noDuplicateSingleton = createRule({
  meta: {
    id: RULE_ID,
    title: "Install one copy of each singleton package",
    description:
      "Read pnpm-lock.yaml and find workspace packages and apps whose install reaches two versions of the same major of a package the app must load once, such as vue, nuxt, nitro, h3, vite, react or drizzle-orm. Add packages with the singletons option.",
    why: "Two versions of a singleton are two module instances. Vue, Pinia, Nuxt and React keep their state per instance, so code from one copy cannot see the other's injections, stores or app context, and h3 and Drizzle reject objects created by the other copy. A lockfile resolves the second copy when one package pins a version or a range that excludes the app's.",
    recommendedReplacement:
      "Update the package that resolves the extra version so it accepts the version the rest of the install uses, ideally as a peer, or add a pnpm override for that version and run pnpm install. Doctor reports each duplicate where it enters the workspace, at the package.json entry that leads to it.",
    examples: [
      {
        title: "Override a transitive pin to the app's Vue",
        language: "yaml",
        invalid: "# pnpm-lock.yaml resolves vue 3.5.44 and, through old-ui, vue 3.4.0",
        valid: "# pnpm-workspace.yaml\noverrides:\n  vue: 3.5.44",
      },
    ],
    category: "dependencies",
    severity: "warn",
    confidence: "manifest-backed",
    fixable: "suggestion",
    diagnosticCodes: ["PKG0008"],
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest"],
    docsUrl: "https://pnpm.io/settings#overrides",
  },
  create(ctx) {
    return {
      onProjectStart() {
        const workspace = packageWorkspace(ctx);
        const lockfilePath = resolve(workspace.root, "pnpm-lock.yaml");
        const text = ctx.fs.readText(lockfilePath);
        if (text === undefined) return;
        const lockfile = parsePnpmLockfile(text);
        if (!lockfile) {
          ctx.project.evidenceGaps = [
            ...(ctx.project.evidenceGaps ?? []),
            {
              source: "vite-doctor/package",
              message: `${RULE_ID} reads pnpm lockfile version 9 only; pnpm-lock.yaml has another version.`,
              files: [relative(ctx.project.root, lockfilePath)],
            },
          ];
          return;
        }
        const isSingleton = singletonMatcher(ctx.options);
        const scope = relative(workspace.root, ctx.project.root) || ".";
        const inScope = (importer: string) =>
          scope === "." || importer === scope || importer.startsWith(`${scope}/`);
        const published = new Map<string, ResolvedCopy[]>();
        const publishedCopies = (importer: string) => {
          let copies = published.get(importer);
          if (!copies) {
            copies = resolvedCopies(lockfile, importer, isSingleton, false).copies;
            published.set(importer, copies);
          }
          return copies;
        };
        const plain = (version: string) => version.slice(version.lastIndexOf("@") + 1);
        const line = (version: string) => {
          const parsed = parse(plain(version), { loose: true });
          if (!parsed) return version;
          return parsed.major === 0 ? `0.${parsed.minor}` : String(parsed.major);
        };
        const newestFirst = (a: string, b: string) => {
          const left = valid(plain(a), { loose: true });
          const right = valid(plain(b), { loose: true });
          return left && right ? rcompare(left, right, { loose: true }) : a.localeCompare(b);
        };
        const duplicates = (copies: Array<{ name: string; version: string }>) => {
          const lines = new Map<string, Set<string>>();
          for (const copy of copies) {
            const key = `${copy.name}\0${line(copy.version)}`;
            lines.set(key, (lines.get(key) ?? new Set()).add(copy.version));
          }
          return new Map([...lines].filter(([, versions]) => versions.size > 1));
        };

        for (const importer of Object.keys(lockfile.importers).sort()) {
          if (!inScope(importer)) continue;
          const { copies, linked } = resolvedCopies(lockfile, importer, isSingleton);
          for (const [key, versions] of duplicates(copies)) {
            const linkedDuplicate = linked.some((target) => {
              if (!inScope(target)) return false;
              // In a cycle, the lexically first importer owns the report.
              const reciprocal = resolvedCopies(
                lockfile,
                target,
                isSingleton,
                false,
              ).linked.includes(importer);
              if (reciprocal && target.localeCompare(importer) >= 0) return false;
              const inherited = duplicates(publishedCopies(target)).get(key);
              return inherited && [...versions].every((version) => inherited.has(version));
            });
            if (linkedDuplicate) continue;
            const name = key.split("\0")[0]!;
            // The version the importer declares itself is the one to keep; otherwise the newest.
            const own = copies.find(
              (copy) => copy.name === name && copy.path.length === 2 && versions.has(copy.version),
            )?.version;
            const ordered = [...versions].sort(
              (a, b) => Number(b === own) - Number(a === own) || newestFirst(a, b),
            );
            const kept = ordered[0]!;
            const extra = copies.find((copy) => copy.name === name && copy.version === ordered[1])!;
            const manifestFile = resolve(workspace.root, importer, "package.json");
            const manifestText = ctx.fs.readText(manifestFile);
            if (manifestText === undefined) continue;
            const range = manifestEntryRange(
              ctx,
              manifestFile,
              manifestText,
              extra.field,
              extra.path[1]!,
            );
            const routes = ordered.map((version) => {
              const copy = copies.find((item) => item.name === name && item.version === version)!;
              return `${version} through ${copy.path.join(" > ")}`;
            });
            const listed = `${ordered.slice(0, -1).join(", ")} and ${ordered.at(-1)}`;
            const culprit = extra.path.at(-2)!;
            const fix =
              extra.path.length === 2
                ? `Change ${extra.field} "${name}" of ${importer} to a range that includes ${kept}, so the install keeps one ${name}.`
                : `Update ${culprit}${extra.path.length > 3 ? ` (reached through ${extra.path[1]})` : ""} to a release that accepts ${name} ${kept}, or add "${name}": "${plain(kept)}" to pnpm overrides and run pnpm install. An override puts ${culprit} on a ${name} version it did not declare, so check that it still works.`;
            ctx.report(
              diagnostics.PKG0008({
                why: `${name} resolves to ${listed} in one install of ${importer}: ${routes.join("; ")}. Code from one copy does not share state, injections or classes with the other.`,
                fix,
                sources: [`${manifestFile}:${range.line}:${range.column}`],
              }),
              {
                ruleId: RULE_ID,
                severity: ctx.severity,
                category: "dependencies",
                file: manifestFile,
                range,
                confidence: "manifest-backed",
                evidence: [
                  ...ordered.flatMap((version) => {
                    const copy = copies.find(
                      (item) => item.name === name && item.version === version,
                    )!;
                    return copy.spans.map((span) => ({
                      kind: "manifest" as const,
                      file: lockfilePath,
                      range: ctx.helpers.rangeFromOffsets(lockfilePath, text, ...span),
                      summary: `Part of the lockfile route to ${name} ${version}: ${copy.path.join(" > ")}.`,
                    }));
                  }),
                  {
                    kind: "manifest",
                    file: manifestFile,
                    range,
                    summary: `${extra.field}["${extra.path[1]}"] leads to ${name} ${extra.version}.`,
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
