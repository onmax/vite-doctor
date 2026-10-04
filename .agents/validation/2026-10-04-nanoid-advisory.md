# Nanoid dependency hardening evidence

Validated on 2026-10-04 against commit `a168931be997bf8a97688802cbc5be61d90b8ee8` plus this change.

## Finding and scope

[GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) includes the locked chain `@vue/compiler-sfc@3.5.40 → postcss@8.5.25 → nanoid@3.3.17`.
The workspace override and lockfile move only the affected Nanoid 3.x resolution to 3.3.18. Nanoid 5.1.16 and unrelated resolutions remain unchanged.

The remaining 3.3.17 defect is in its React Native async implementation:

| Operation against the actual installed source                       | 3.3.17                                               | 3.3.18                 |
| ------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------- |
| Native async `customAlphabet('ab', 0)()` with deterministic entropy | Does not settle within the 1-second subprocess limit | Returns `''`           |
| Native async `customAlphabet('ab', 6)(0)`                           | Returns one character                                | Returns `''`           |
| Native async generation with size 6                                 | Returns six characters                               | Returns six characters |
| Node zero-size generator and PostCSS anonymous input IDs            | Pass                                                 | Pass                   |

The upstream [3.3.18 patch](https://github.com/ai/nanoid/commit/e10f8d40ce9d1ab47f66d65a16b48086432730d0) adds the missing zero-size guard to `async/index.native.js`.
The regression loads that installed file in a child Node VM and supplies an Expo entropy provider that throws if called. It fails with 3.3.17 and passes with 3.3.18, without relying on a timing threshold to detect the defect.

Doctor's PostCSS path uses `nanoid/non-secure.nanoid(6)`. Its normal Node entrypoints already handle zero sizes in 3.3.17. This change removes an affected locked dependency; it does not establish a denial-of-service exploit in a Doctor Run.

## Verification

Installation and verification used a standalone copy with its own dependencies. `pnpm install --frozen-lockfile --ignore-scripts` passed with pnpm 11.20.0 and preserved Vite Plus 0.3.1.

| Check                                                      | Result                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Regression before the patch                                | 1 failure, 1 compatibility control passed                                   |
| Focused dependency, compiler, Vue asset, and fixture tests | 38 passed across 3 files                                                    |
| `node_modules/.bin/vp test run`                            | 5,088 passed across 73 files                                                |
| `node_modules/.bin/vp check`                               | Passed; two existing `AnyNode \| undefined` warnings                        |
| `node_modules/.bin/tsdown`                                 | Passed; 72 output files                                                     |
| Documentation `vp test run` and `vp check`                 | 19 tests passed; check passed                                               |
| Documentation production build                             | Passed; 657 routes prerendered, including social images                     |
| Packed CLI and public CLI import                           | Clean fixture exits 0; seeded `VITE0009` exits 1; imported `main()` exits 0 |
| `git diff --check`                                         | Passed                                                                      |

`tests/core/nanoid-security.test.ts` retains positive PostCSS ID generation, CSS roundtripping, Vue script compilation, scoped styles, and CSS variable compilation as compatibility controls.

## Audit boundaries and remaining work

The locked workspace production audit changed from 61 advisory records (22 high, 31 moderate, 8 low) to 60 (21 high, 31 moderate, 8 low). Every remaining advisory path begins with the `docs` workspace. `pnpm audit --prod` includes that workspace's application and transitive tooling dependencies; these totals do not describe Doctor's published production closure.

A separate consumer installed the built tarball with npm and no workspace overrides. It resolved `@vue/compiler-sfc@3.5.43 → postcss@8.5.28 → nanoid@3.3.19`; `npm audit --omit=dev --json` reported zero vulnerabilities. Consumers resolve their own dependency graph, so this result is a dated observation, not a guarantee or evidence that the workspace override propagates to consumers.

The remaining locked audit records are grouped below by the paths that require investigation. Dependency presence alone does not prove an exposed operation.

| Area                                                  | Packages and advisory-record counts                                                            | Reachability evidence or next check                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation image and payload handling              | `nuxt-og-image` 1, `sharp` 1, `devalue` 7                                                      | Production output contains dynamic OG-image routes; payload and image operations need controlled input-path tests.                                                                      |
| Documentation AI, MCP, and network dependencies       | `undici` 24, `fast-uri` 6, `hono` 4, `ip-address` 4, `qs` 2, `@fastify/busboy` 1               | Trace enabled server routes and the affected network/parser operations before asserting application exposure. Some Undici paths also come directly through Nuxt.                        |
| Documentation editor dependencies                     | `@tiptap/core` 2                                                                               | No authored editor use was found in `docs/app`; check inherited layer components before ruling out exposure.                                                                            |
| Documentation build, development, and content tooling | `svgo` 2, `esbuild` 1, `vitest` 1, `@vitest/mocker` 1, `js-yaml` 1, `node-forge` 1, `braces` 1 | Audit paths run through CSS optimization, font tooling, Vite checking, local TLS, YAML/content processing, and globbing. Runtime content parsing still needs a separate boundary check. |

The highest-priority follow-up is [GHSA-q8hw-4fvp-9rwv](https://github.com/advisories/GHSA-q8hw-4fvp-9rwv) in `nuxt-og-image@6.6.0`, patched in 6.7.0. Doctor's documentation extends Docus, has no authored OG-image security override, and produces `/_og/d/**` handlers. Those facts justify a controlled local reachability test; no project-specific SSRF exploit was demonstrated during this dependency patch.
