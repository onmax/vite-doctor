# Engineering campaign roadmap

The [engineering campaign issue](https://github.com/onmax/vite-doctor/issues/72) owns the roadmap and reproduction fixtures, following the repository's issue-tracker convention.

The queue contains 100 candidates: 35 observed mismatches and 65 investigations. An investigation becomes a PR only after demonstrating a defect or a meaningful coverage/documentation gap. Existing correct behavior can retire a candidate without a PR. These counts describe the review queue, not completed improvements or promised PRs.

## Published changes

| PR                                                 | Change                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| [61](https://github.com/onmax/vite-doctor/pull/61) | Skip safe edits when the source file cannot be read.                             |
| [62](https://github.com/onmax/vite-doctor/pull/62) | Keep info-only Vite Plugin Surface output at info level.                         |
| [63](https://github.com/onmax/vite-doctor/pull/63) | Limit preview publishing permissions and disable persisted checkout credentials. |
| [64](https://github.com/onmax/vite-doctor/pull/64) | Preserve diagnostic documentation overrides and opt-outs in reports.             |
| [65](https://github.com/onmax/vite-doctor/pull/65) | Check, test, and build documentation in CI.                                      |
| [67](https://github.com/onmax/vite-doctor/pull/67) | Use lexical scope for worker references to the global `process`.                 |
| [68](https://github.com/onmax/vite-doctor/pull/68) | Confine persistent cache paths to the project root.                              |
| [69](https://github.com/onmax/vite-doctor/pull/69) | Distinguish computed env variables from static property names.                   |
| [70](https://github.com/onmax/vite-doctor/pull/70) | Remove an unsafe automatic Nuxt `useFetch` import rename.                        |
| [71](https://github.com/onmax/vite-doctor/pull/71) | Allow the public CLI module to be imported from Node stdin.                      |

Each PR records its own tests, independent review, and limitations. PR status remains in GitHub. Historical changes preceding this campaign are not counted here.

## Real-repository validation

The official [Vite repository](https://github.com/vitejs/vite/tree/10033218d239c927cdc375970b5741cce408e81b) was cloned into `/tmp/doctor-real-vite`. The built CLI from the env-key fix was run against all 16 `packages/create-vite/template-*` projects at that revision:

```sh
node /tmp/pr-vite-static-env/dist/cli.mjs <template-path> --no-cache --format json
```

| Target                                                                                                                 | Dependency state                                                                                     | Observed result                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 14 vanilla, React, Preact, Svelte, Solid, Qwik, and Lit templates                                                      | Template dependencies not installed                                                                  | Existing Vite/TypeScript analysis completed without findings.                                  |
| Vue JavaScript and TypeScript templates                                                                                | Template dependencies not installed                                                                  | Exit 3, incomplete, `DOC0022` for unresolved Vue runtime.                                      |
| Vue TypeScript template                                                                                                | Dependencies installed with `npm install --ignore-scripts --no-audit --no-fund --package-lock=false` | Exit 0, clean, Vue runtime resolved.                                                           |
| Vanilla TypeScript template through an actual Vite build with `doctor({ mode: "warn", format: "json", cache: false })` | Build host uses Doctor's installed Vite                                                              | Plugin Surface and CLI both reported no findings on the pristine source.                       |
| Same vanilla template with a controlled `import.meta.env.VITE_SECRET_TOKEN` read                                       | Source addition restored after the run                                                               | Plugin Surface and CLI both reported `VITE0009`; CLI exited 1 and the plugin logged a warning. |

These runs verify the existing Doctor entry points and Rule Packs. They do not establish framework-specific support for React, Preact, Svelte, Solid, Qwik, or Lit. The controlled addition verifies detection and surface parity; it is not an upstream vulnerability finding.

## Verification boundaries

The env-key branch passed 4,347 tests, formatting, lint, typechecking, and the distribution build after review found and corrected a numeric-member HMR regression. Cache containment passed 4,341 tests and the same static/build checks on its isolated branch. Packed CLI checks exercise 20 public exports plus NodeNext/Bundler declaration consumers.

Some parallel local runs exposed shared dependency-tree mutations and missing ambient Vue resolution in temporary fixtures. A clean rerun is required after those environment failures; increasing global test timeouts is not part of this campaign's published changes. Cache containment does not promise protection against hostile concurrent filesystem replacement or hardlinks.
