# Supported Docus dependency upgrade

Validated on 2026-10-04 from `3a5efcf` in a standalone copy with its own dependencies.

## Dependency contract

The original Docus 5.12.3 pin requires `nuxt-og-image ~6.6.0`. That range cannot receive the 6.7.0 fix for [GHSA-q8hw-4fvp-9rwv](https://github.com/advisories/GHSA-q8hw-4fvp-9rwv).

| Catalog    | Before                     | After                      | Reason                                                                                                  |
| ---------- | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `docus`    | 5.12.3                     | 5.13.0                     | The supported Docus release requires patched OG Image `~6.7.8`.                                         |
| `@nuxt/ui` | `^4.10.0`, resolved 4.10.0 | `^4.11.0`, resolved 4.11.3 | Docus 5.13 requires `^4.11.0`; the existing workspace override otherwise retains an unsupported 4.10.0. |
| `nuxt`     | `^4.5.1`, resolved 4.5.1   | `^4.5.2`, resolved 4.5.2   | Align the Nuxt and Nuxt Kit schema types after the required UI update.                                  |

Official release notes reviewed: [Docus 5.13](https://github.com/nuxt-content/docus/releases/tag/v5.13.0), [OG Image 6.7](https://github.com/nuxt-modules/og-image/releases/tag/v6.7.0), [Nuxt UI 4.11](https://github.com/nuxt/ui/releases/tag/v4.11.0), and [Nuxt 4.5.2](https://github.com/nuxt/nuxt/releases/tag/v4.5.2).

The intermediate UI update made `nuxt/kit` resolve the hoisted `@nuxt/schema@4.5.2` while `nuxt/schema` still exported 4.5.1. Root checking reproduced TS2322 and TS2589 at the `defineNuxtModule` assignment. Nuxt Kit 4.5.1 imports schema types without declaring that package as a dependency. Temporarily giving only that Kit installation the original schema made the same check pass; the temporary edge was removed. Updating Nuxt to 4.5.2 then passed with the normal frozen dependency graph. No Doctor source workaround is included.

The final installation satisfies all examined override-affected dependency ranges across 762 Docus/UI transitive package manifests. Vite Plus remains 0.3.1. Doctor's 173-entry runtime dependency closure retains its direct dependency versions; its shared Picomatch resolution changes from 4.0.5 to 4.0.7, with the corresponding Fdir peer key.

## Docus type registration

Docus 5.13 adds two accesses to `AppConfig.seo.schema`. Its published `app/types/index.d.ts` declares that contract, but Nuxt's generated application configuration excludes the root `node_modules` directory. The resulting application program imports `useSeo.ts` while omitting the Docus declaration, despite the generated Docus include glob. This produces two new TS2339 errors.

`docs/app/docus.d.ts` imports the shipped `docus/app/types` declaration. It adds no runtime code, copied declarations, or type assertions. The import removes both new errors. Baseline and final expanded Vue checks report the same 30 diagnostics, including 13 in authored `docs/app` files, after normalizing dependency paths and moved upstream line numbers.

The comparison uses Vue TSC 3.3.11 and TypeScript 6.0.3 from a separate checker installation. Both generated configurations refer to an unresolved bare Vue Router Volar plugin. For the controlled comparison, a temporary `.nuxt/tsconfig.expanded-check.json` copies each generated application configuration and replaces only that plugin string with the installed `vue-router/dist/volar/sfc-route-blocks.cjs` path. Both comparison runs load the plugin without warnings. Includes, excludes, and compiler options are unchanged. This corrects the comparison environment; the repository's normal generated typecheck still needs a complete follow-up.

## Verification

All commands ran in the standalone copy; no linked worktree installation was used. The final production build started without previous `.nuxt` or `.output` directories. Generated imports, component declarations, application/server configurations, and the Doctor manifest reference Docus 5.13.0 and contain no Docus 5.12.3 references.

| Check                                             | Result                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --ignore-scripts` | Passed                                                                                             |
| `node_modules/.bin/vp check`                      | Passed; two existing redundant-type warnings                                                       |
| `node_modules/.bin/vp test run --maxWorkers=2`    | 5,196 tests passed across 78 files                                                                 |
| `node_modules/.bin/tsdown`                        | Passed; 72 output files                                                                            |
| Documentation `vp check`                          | Passed                                                                                             |
| Documentation `vp test run --maxWorkers=2`        | 30 tests passed across three files                                                                 |
| Documentation `nuxi build`                        | Passed; 679 prerendered routes, no prerender HTTP 500s                                             |
| Generated output inspection                       | 329 HTML documents; home, CLI, DOC0001, DOC0011, and VITE0009 pages contain their rendered content |
| Normal social-image artifacts                     | Seven generated PNGs, matching the baseline                                                        |
| Built CLI controls                                | Clean Vite fixture exits 0; seeded VITE0009 fixture exits 1                                        |
| `git diff --check`                                | Passed                                                                                             |

The full package suite, distribution build, and clean documentation build verified the final dependency graph before the one-line type registration. After that declaration was added, root checking, documentation checking, and all 30 documentation tests passed again. Expanded Vue checking ran on both snapshots with the resolved plugin and confirmed no additional diagnostics. It remains a failing check on both snapshots, not a clean application typecheck.

Expanded comparison commands, run in each documentation directory:

```sh
vue-tsc --noEmit -p .nuxt/tsconfig.expanded-check.json
tsc --noEmit -p .nuxt/tsconfig.server.json
```

## Audit result and limits

The locked workspace production audit falls from 61 records (22 high, 31 moderate, 8 low) to 46 (18 high, 23 moderate, 5 low). It removes the OG Image record, 13 Undici records, and the Fastify Busboy record; no new advisory records appear. This audit includes the documentation application and its transitive tooling.

The remaining Nanoid record still reaches Doctor's locked production graph and is handled separately by PR #168. Every other remaining record has documentation-only dependency paths. No project-specific SSRF exploit was established, and this migration does not claim a clean overall audit.

The update adopts upstream AI SDK 7, Comark 0.6, Takumi 2, and default OG-image URL signing. The existing documentation configuration remains unchanged. Automatically generated signing secrets change between builds; previously generated dynamic URLs may not remain valid across deployments.

Additional checks exposed boundaries outside the repository's current required checks:

- Expanded generated Vue typechecking retains 30 baseline errors, including 13 unchanged authored application errors. The Docus declaration import resolves the two new schema errors. The comparison above removes the plugin-resolution warning without suppressing type errors.
- Expanded server typechecking retains one inherited Docus skills-route error. There are no authored `docs/server` endpoints in this snapshot.
- Both builds reference eight social-image URLs but emit seven PNG files. The homepage's custom image lacks a prerendered file in both snapshots; its runtime fallback remains unverified.
- An ordinary local Cloudflare smoke cannot initialize either the old or new worker output: Miniflare rejects a bare `secure-exec` import in the inherited executor chunk. No HTTP request is dispatched. This is a separate packaging boundary, so neither successful prerendering nor this migration establishes deployed worker compatibility.

No deployment, release, hosted build retry, or Issue/PR comment was performed. Follow-up work should establish a complete documentation typecheck and repair the existing worker-packaging and homepage-image gaps before treating those surfaces as verified.

## Follow-up Nuxt Kit lock alignment

The frontend Kit catalog was raised to `^4.5.2` in `7d413b4`. A subsequent lockfile inspection still found compatible `@nuxt/content` and `@nuxt/fonts` edges resolving Kit 4.5.1. Those three edges now reuse the existing Kit 4.5.2 snapshots with the same peer contexts, and unused 4.5.1 package/snapshot entries were removed. Both upstream packages declare `^4.5.0`, so this stays within their supported ranges without an override. Nuxt 3 Kit 3.21.10 remains for the test tooling, and Vite Plus stays 0.3.1.

This lock-only follow-up was checked in the prepared PR checkout using `pnpm install --frozen-lockfile --offline`, documentation `vp check`, documentation `vp test run --maxWorkers=2` (30 tests across three files), and `git diff --check`. `pnpm --filter docs why @nuxt/kit` confirms the Content and Fonts paths now resolve 4.5.2. The earlier full build and expanded comparison evidence above predates this patch resolution follow-up.
