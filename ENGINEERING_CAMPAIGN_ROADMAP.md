# Engineering Campaign Roadmap

This backlog is evidence-driven from the current source and test inventory. Each row is intended to become one independently reviewable PR with a failing reproduction or coverage gap, a minimal implementation or fixture, and fresh verification. Rows derived from an exact Rule ID with no test-tree reference still require a reproduction before production changes.

| # | Candidate PR | Evidence and acceptance target | Primary area |
|---:|---|---|---|
| 1 | Rule coverage: vite/worker/no-dynamic-worker-url | Add a focused fixture for `vite/worker/no-dynamic-worker-url` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/vite/` |
| 2 | Rule coverage: typescript/evidence/no-known-value-widening | Add a focused fixture for `typescript/evidence/no-known-value-widening` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/typescript/` |
| 3 | Rule coverage: typescript/performance/no-array-filter-map | Add a focused fixture for `typescript/performance/no-array-filter-map` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/typescript/` |
| 4 | Rule coverage: typescript/performance/no-reduce-accumulator-copy | Add a focused fixture for `typescript/performance/no-reduce-accumulator-copy` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/typescript/` |
| 5 | Rule coverage: typescript/evidence/no-widen-then-assert | Add a focused fixture for `typescript/evidence/no-widen-then-assert` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/typescript/` |
| 6 | Rule coverage: vue/watch/require-side-effect-cleanup | Add a focused fixture for `vue/watch/require-side-effect-cleanup` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 7 | Rule coverage: vue/ssr/use-id-for-stable-ids | Add a focused fixture for `vue/ssr/use-id-for-stable-ids` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 8 | Rule coverage: vue/watch/require-post-flush-for-dom-read | Add a focused fixture for `vue/watch/require-post-flush-for-dom-read` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 9 | Rule coverage: vue/ssr/data-allow-mismatch-surgical | Add a focused fixture for `vue/ssr/data-allow-mismatch-surgical` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 10 | Rule coverage: vue/reactivity/no-setup-props-destructure | Add a focused fixture for `vue/reactivity/no-setup-props-destructure` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 11 | Rule coverage: vue/lifecycle/no-mutation-in-onupdated | Add a focused fixture for `vue/lifecycle/no-mutation-in-onupdated` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 12 | Rule coverage: vue/watch/no-onwatchercleanup-after-await | Add a focused fixture for `vue/watch/no-onwatchercleanup-after-await` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 13 | Rule coverage: vue/ssr/no-random-or-local-time-render | Add a focused fixture for `vue/ssr/no-random-or-local-time-render` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 14 | Rule coverage: vue/i18n/no-unused-translations | Add a focused fixture for `vue/i18n/no-unused-translations` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 15 | Rule coverage: vue/i18n/no-untranslated-text | Add a focused fixture for `vue/i18n/no-untranslated-text` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 16 | Rule coverage: vue/watch/no-async-watcheffect-after-await-read | Add a focused fixture for `vue/watch/no-async-watcheffect-after-await-read` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/vue/` |
| 17 | Rule coverage: package/no-phantom-dependencies | Add a focused fixture for `package/no-phantom-dependencies` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/package/` |
| 18 | Rule coverage: nitro/h3/no-http-error-masking | Add a focused fixture for `nitro/h3/no-http-error-masking` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/nitro/` |
| 19 | Rule coverage: nuxt/review/api-authorization-coverage | Add a focused fixture for `nuxt/review/api-authorization-coverage` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/nuxt/` |
| 20 | Rule coverage: nuxt-scripts/no-third-party-usehead-script | Add a focused fixture for `nuxt-scripts/no-third-party-usehead-script` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 21 | Rule coverage: nuxt-scripts/no-third-party-config-script | Add a focused fixture for `nuxt-scripts/no-third-party-config-script` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 22 | Rule coverage: nuxt-image/prefer-nuxtimg | Add a focused fixture for `nuxt-image/prefer-nuxtimg` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 23 | Rule coverage: nuxt-image/require-alt | Add a focused fixture for `nuxt-image/require-alt` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 24 | Rule coverage: nuxt-image/prefer-responsive-dimensions | Add a focused fixture for `nuxt-image/prefer-responsive-dimensions` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 25 | Rule coverage: nuxt-image/prefer-nuxtpicture-for-formats | Add a focused fixture for `nuxt-image/prefer-nuxtpicture-for-formats` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 26 | Rule coverage: nuxthub/no-personalized-cached-handler | Add a focused fixture for `nuxthub/no-personalized-cached-handler` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 27 | Rule coverage: nuxthub/prefer-cached-event-handler | Add a focused fixture for `nuxthub/prefer-cached-event-handler` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 28 | Rule coverage: vueuse/prefer-usewindow-size | Add a focused fixture for `vueuse/prefer-usewindow-size` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 29 | Rule coverage: vueuse/prefer-usebreakpoints | Add a focused fixture for `vueuse/prefer-usebreakpoints` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 30 | Rule coverage: vueuse/prefer-useclipboard | Add a focused fixture for `vueuse/prefer-useclipboard` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 31 | Rule coverage: vueuse/prefer-useevent-listener | Add a focused fixture for `vueuse/prefer-useevent-listener` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 32 | Rule coverage: vueuse/prefer-use-observers | Add a focused fixture for `vueuse/prefer-use-observers` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 33 | Rule coverage: vueuse/prefer-use-timers | Add a focused fixture for `vueuse/prefer-use-timers` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 34 | Rule coverage: vueuse/prefer-use-storage | Add a focused fixture for `vueuse/prefer-use-storage` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 35 | Rule coverage: vueuse/prefer-use-scroll-and-element | Add a focused fixture for `vueuse/prefer-use-scroll-and-element` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/` |
| 36 | Rule coverage: nuxt/imports/no-auto-import-collision | Add a focused fixture for `nuxt/imports/no-auto-import-collision` covering a boundary case and a clean counterexample; the exact Rule ID has no reference in the current tests tree. | `tests/rule-packs/nuxt/` |
| 37 | Cache corruption recovery | Reproduce a truncated Doctor cache and verify the run invalidates only the damaged entry, then add a regression fixture. | `src/core/internal/scan-session.ts` |
| 38 | Cache stale invalidation | Verify changed package manifests invalidate dependent Project Inventory facts without discarding unrelated cache entries. | `src/core/internal/scan-session.ts` |
| 39 | Cache path confinement | Test symlinked and parent traversal cache paths and preserve the inside-project invariant. | `src/core/internal/scan-session.ts` |
| 40 | Duplicate extension names | Reject duplicate Doctor Extension names deterministically and expose the authoring diagnostic. | `src/extension.ts` |
| 41 | Rule Pack version validation | Add malformed and prerelease version fixtures for Rule Pack registration. | `src/extension.ts` |
| 42 | Config extends auto composition | Cover `auto` plus explicit presets and assert ordering across activated Rule Packs. | `src/config.ts` |
| 43 | TypeScript activation | Prove JavaScript-only projects do not activate the TypeScript Rule Pack while mixed projects do. | `src/core/internal/applicability.ts` |
| 44 | Diagnostic code collisions | Exercise registration of the same Diagnostic Code from two extensions and assert the invariant diagnostic. | `src/core/diagnostic-registry.ts` |
| 45 | Suppressed report serialization | Verify suppressed diagnostics retain code, rule, and suppression metadata in JSON and agent output. | `src/core/reports.ts` |
| 46 | Stable diagnostic fingerprints | Add a fixture proving evidence detail changes update fingerprints without changing unrelated findings. | `src/core/internal/diagnostics.ts` |
| 47 | Overlapping safe fixes | Cover deterministic tie-breaking for overlapping edits and skipped-edit accounting. | `src/core/internal/diagnostics.ts` |
| 48 | Fix permission preservation | Test mode preservation and failure reporting when a source file changes permissions during fixing. | `src/core/internal/diagnostics.ts` |
| 49 | Unresolved runtime graph packages | Verify unresolved package edges carry actionable evidence gaps and do not crash rules. | `src/core/internal/runtime-graph.ts` |
| 50 | Workspace graph cycles | Add cyclic workspace fixture coverage for import and export graph reporting. | `src/core/internal/workspace-graph.ts` |
| 51 | Git inventory modes | Exercise unusual Git status and diff configuration and preserve changed-line selection. | `src/core/internal/git-change-ranges.ts` |
| 52 | Renamed-file inventory | Verify renamed files report old and new paths consistently in changed and since scopes. | `src/core/internal/source-inventory.ts` |
| 53 | Explicit config trust boundary | Test executable `doctor.config.*` loading remains opt-in while host surfaces accept in-memory config. | `src/cli-main.ts` |
| 54 | Malformed JSON config | Add CLI fixtures for scalar, array, and invalid JSON config values with stable invocation diagnostics. | `src/cli-main.ts` |
| 55 | Cache CLI actions | Cover `cache clear`, `cache path`, and unknown actions with exit-code assertions. | `src/cli-main.ts` |
| 56 | CLI diagnostic exit codes | Verify blocker/error/warn thresholds map to documented process exit codes in text and agent formats. | `src/cli-main.ts` |
| 57 | Nuxt host command shim | Run packed `pnpm nuxt doctor` and direct shim invocations against clean and failing fixtures. | `scripts/test-packed-cli.mjs` |
| 58 | Vite Plugin Surface severity | Keep info-only reports on `logger.info` while threshold failures remain warnings. | `src/plugin.ts` |
| 59 | Plugin failure thresholds | Test Plugin Surface fail behavior for blocker, error, warn, and max-warnings settings. | `src/plugin.ts` |
| 60 | Plugin config extends | Assert Vite host configuration composes `extends: auto` and explicit Rule Pack presets identically to CLI runs. | `src/plugin.ts` |
| 61 | Plugin runtime evidence | Verify resolved Vite config and command mode reach the shared Doctor Run as Runtime Evidence. | `src/plugin.ts` |
| 62 | Nuxt module in-memory config | Exercise Nuxt module options without loading an executable config file and assert shared-run parity. | `src/nuxt.ts` |
| 63 | Nuxt host status documentation | Add a packed fixture documenting and testing the known Nuxt host-command exit-status behavior. | `.agents/adr/0011-nuxt-host-command-shim.md` |
| 64 | NodeNext packed exports | Expand packed declaration checks for every public Rule Pack subpath under NodeNext resolution. | `scripts/test-packed-cli.mjs` |
| 65 | Bundler packed exports | Expand packed declaration checks for Vite/Rolldown bundler resolution and extension exports. | `scripts/test-packed-cli.mjs` |
| 66 | Fork preview token isolation | Keep fork pull requests read-only while preserving trusted same-repository preview publishing. | `.github/workflows/pkg-pr-new.yml` |
| 67 | Documentation CI coverage | Run docs check, tests, and Nuxt build in CI against the same ref used by root checks. | `.github/workflows/ci.yml` |
| 68 | Docs dependency advisories | Audit transitive docs dependencies and record safe upgrades or scoped overrides with build verification. | `docs/package.json` |
| 69 | Release reproducibility | Build and pack twice from clean installs and compare public file lists and declaration entrypoints. | `.github/workflows/release.yml` |
| 70 | Windows path fixtures | Run cache, source inventory, and packed CLI fixtures with Windows separators and drive roots. | `tests/fixtures` |
| 71 | macOS path fixtures | Run symlink and packed CLI fixtures on macOS with the package compatibility matrix. | `.github/workflows/package-compatibility.yml` |
| 72 | Node 22 compatibility | Pin and run the full packed CLI and Rule Pack smoke matrix on the minimum supported Node version. | `.github/workflows/package-compatibility.yml` |
| 73 | Node 24 compatibility | Run the same matrix on the current Node release and compare diagnostic output schemas. | `.github/workflows/package-compatibility.yml` |
| 74 | Framework support contract matrix | Document and fixture-test activation and surface parity for Vite, Vue, Nitro, Nuxt, and TypeScript. | `tests/fixtures` |
| 75 | Benchmark regression guard | Record rule-runner benchmark baselines and fail only on statistically meaningful regressions. | `tests/core/rule-runner.bench.ts` |
| 76 | Fixture timeout isolation | Split slow Nuxt and Vite fixture suites so resource contention cannot hide a product regression. | `tests` |
| 77 | Secret redaction | Add adversarial config and report fixtures proving secret values never appear in diagnostics or timings. | `src/rule-packs/vite/rules/define.ts` |
| 78 | SARIF schema validation | Validate emitted SARIF against the 2.1.0 schema for docs opt-outs, related locations, and fingerprints. | `tests/core/reports.test.ts` |
| 79 | Agent schema validation | Validate agent reports against a checked-in schema including incomplete and clean statuses. | `src/core/reports.ts` |
| 80 | Diagnostic docs completeness | Fail docs generation when a user-facing Diagnostic Code lacks a generated reference page. | `docs/rules/source.ts` |
| 81 | Documentation link checker | Check every Rule Catalog and Diagnostic Reference URL during docs tests. | `docs` |
| 82 | Docs accessibility | Add automated checks for heading order, link names, and keyboard navigation on Rule Catalog pages. | `docs/app` |
| 83 | Run timing observability | Expose stable phase timing fields and test their presence without making values nondeterministic. | `src/core/reports.ts` |
| 84 | Incremental cache metrics | Add report metadata for cache hit/miss counts and test invalidation boundaries. | `src/core/internal/scan-session.ts` |
| 85 | Extension authoring docs | Document Doctor Extension registration, Rule Pack presets, and inventory hooks with a runnable fixture. | `src/extension.ts` |
| 86 | ADR model parity | Update ADR examples to match current report fields and public subpath exports. | `.agents/adr` |
| 87 | Migration deprecation tests | Exercise unsupported migration targets and verify stable actionable diagnostics. | `src/migration.ts` |
| 88 | Config extends migration | Test explicit `extends` validation and migration messages for removed legacy options. | `src/config.ts` |
| 89 | Strict preset activation | Verify strict presets opt into noisy rules without changing Recommended Preset activation. | `src/core/internal/applicability.ts` |
| 90 | CLI/plugin parity | Run the same fixture through CLI and Vite Plugin Surface and compare codes, evidence, and fingerprints. | `tests/vite/cli.test.ts` |
| 91 | TypeScript parser recovery | Exercise malformed and partially typed TypeScript files and preserve actionable parse evidence. | `src/core/internal/project.ts` |
| 92 | Vue SFC source maps | Verify template/script source ranges survive SFC parsing with CRLF and embedded languages. | `src/core/internal/sfc.ts` |
| 93 | Template visitor ordering | Assert visitor hooks observe parent/child nodes in documented order across Vue and HTML templates. | `src/core/internal/template.ts` |
| 94 | Runtime evidence provenance | Ensure every runtime edge records its source and confidence in agent reports. | `src/core/internal/runtime-graph.ts` |
| 95 | Evidence gap remediation | Test incomplete runs emit stable restore-evidence instructions in all machine formats. | `src/core/reports.ts` |
| 96 | Rule execution phases | Cover workspace, project, script, template, and runtime phase ordering with a multi-rule fixture. | `src/core/internal/rule-runner.ts` |
| 97 | Rule cancellation | Abort a long-running extension cleanly and preserve completed diagnostics when the run signal fires. | `src/core/internal/rule-execution.ts` |
| 98 | Extension inventory merge | Merge overlapping Project Inventory facts without dropping provenance or host evidence. | `src/core/internal/facts.ts` |
| 99 | Plugin disposal | Verify Vite Plugin Surface disposes timers and listeners when a dev server closes. | `src/plugin.ts` |
| 100 | Nuxt module lifecycle | Exercise module setup, ready, and close hooks against one shared Doctor Run. | `src/nuxt.ts` |
| 101 | CLI cwd resolution | Run the CLI from a nested workspace directory and assert project-root discovery. | `src/cli-main.ts` |
| 102 | CLI format parity | Compare text, JSON, agent, and SARIF severity counts for the same fixture. | `src/cli-main.ts` |
| 103 | CLI help contract | Snapshot public commands and option descriptions for agent-facing discoverability. | `src/cli-main.ts` |
| 104 | Config schema errors | Test unknown keys, wrong types, and conflicting options with stable validation diagnostics. | `src/config.ts` |
| 105 | Rule selection filtering | Verify `--rules` supports qualified IDs, codes, and explicit exclusions without accidental activation. | `src/core/internal/applicability.ts` |
| 106 | Preset catalog ordering | Keep Rule Catalog output deterministic when extensions register packs in different orders. | `src/core/diagnostic-code-map.ts` |
| 107 | Diagnostic registry lookup | Test code lookup and duplicate registration across independently loaded extensions. | `src/core/diagnostic-registry.ts` |
| 108 | SARIF related locations | Validate related source locations and region columns against the SARIF schema. | `src/core/reports.ts` |
| 109 | Agent next-step commands | Keep explain/verify/rerun commands valid for incomplete, clean, and failing runs. | `src/core/reports.ts` |
| 110 | Fix dry-run output | Add a dry-run fixture that reports planned edits without modifying files or cache state. | `src/core/internal/diagnostics.ts` |
| 111 | Package artifact symlinks | Exercise published output with symlinked workspace artifacts and preserve dependency diagnostics. | `src/rule-packs/package/artifacts.ts` |
| 112 | Package export conditions | Test import/require/types/browser condition combinations in packed package output. | `src/rule-packs/package/artifacts.ts` |
| 113 | Shadcn preset activation | Prove the Shadcn Rule Pack activates only when its project markers are present. | `src/rule-packs/shadcn/index.ts` |
| 114 | Nitro route evidence | Verify method-suffix diagnostics distinguish dynamic and static route handlers. | `src/rule-packs/nitro/rules/shared.ts` |
| 115 | Nuxt manifest evidence | Test missing, stale, and partial Nuxt manifests and the resulting evidence gaps. | `src/core/internal/nuxt-inventory.ts` |
| 116 | Nuxt layer boundaries | Add fixtures for inherited layers and app-directory shadowing. | `src/rule-packs/nuxt/rules/nuxt/file-classification.ts` |
| 117 | Nuxt content links | Run broken-link analysis through aliases, fragments, and generated content routes. | `src/rule-packs/nuxt/rules/docus.ts` |
| 118 | Security diagnostic redaction | Ensure request headers, env values, and auth evidence never leak into rendered messages. | `src/rule-packs/nuxt/review/authorization.ts` |
| 119 | Dependency lock drift | Fail package diagnostics when packed manifests and lockfile dependency contracts diverge. | `src/rule-packs/package/artifacts.ts` |
| 120 | Docs generated route inventory | Compare Rule Catalog IDs and generated diagnostic pages for missing or duplicate routes. | `docs/rules/source.ts` |
| 121 | Docs build memory budget | Record docs build peak memory and retain a reproducible CI budget. | `package.json` |
| 122 | Docs preview smoke | Serve the generated docs artifact and smoke-test a Rule page and Diagnostic Reference URL. | `docs` |
| 123 | CI matrix ref pinning | Verify reusable workflows honor caller refs on push, pull request, and release events. | `.github/workflows` |
| 124 | CI cancellation policy | Cancel superseded docs/package jobs without leaving partial preview artifacts. | `.github/workflows` |
| 125 | Release provenance | Verify packed artifacts include version provenance and exclude generated workspace caches. | `.github/workflows/release.yml` |
| 126 | Dependency audit policy | Add a documented triage rule for high transitive advisories in the docs workspace. | `docs/package.json` |
| 127 | Framework fixture inventory | Maintain one clean and one finding fixture for each supported framework surface. | `tests/fixtures` |
| 128 | Cross-platform CLI encoding | Exercise JSON/SARIF output with Unicode paths and line endings on all supported OSes. | `scripts/test-packed-cli.mjs` |

Inventory snapshot: 154 exact Rule IDs were scanned from `id:` metadata declarations; 36 had no exact test-tree reference. The first campaign wave opened separate PRs for core fix application, report documentation metadata, Vite Plugin Surface logging, CI token isolation, and docs CI coverage. Remaining rows stay planned until an agent can reproduce and justify the change.
