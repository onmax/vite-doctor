# oxlint JS-plugin Rule host experiment

Refs #197. This is an experiment. It does not touch any production Doctor code path, and it is
not meant to merge as-is.

Question: if Doctor file Rules ran on oxlint's JS-plugin runtime (Rust discovery, parsing and
semantic analysis in parallel, JS Rules over raw-transfer ASTs), how much faster would a Doctor Run
get, would Diagnostics stay identical, and what breaks?

Short answer: the same six Rules cost 3x to 7x less CPU on oxlint, and the Diagnostics are
identical once three Doctor report-boundary steps are applied. Almost all of the gain comes from
skipping work Doctor does today that these Rules never needed. Very little comes from
parallelism, because oxlint runs JS plugins on one thread. My recommendation is no-go on oxlint
as Doctor's engine and no-go on a Rust core for now. Take the specific wins in-process instead.
Details and next steps are at the end.

## What is here

| File                        | Purpose                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `plugin.mjs`, `rules/*.mjs` | oxlint JS plugin `doctor` with six ported Rules, plus a `noop` rule that only visits `Program`                           |
| `inventory.mjs`             | Runs Doctor once with a capture Rule and records the Project Inventory each file's Rules see, reduced to JSON            |
| `oxlint.mjs`                | Resolves oxlint from vite-plus and writes a temp config outside the repo, so `vp lint` never loads it as a nested config |
| `fixtures.mjs`              | Synthetic Nuxt project with positive and negative cases for every ported Rule, plus host-difference probes               |
| `bench.mjs`                 | Alternated timing runs, a Doctor `--profile` breakdown and Diagnostic parity                                             |
| `doctor-api.mjs`            | Loads `runViteDoctor` from the built `dist` chunk (it is not a public export)                                            |
| `results/*.json`            | Raw samples, medians, Doctor phases and parity details from the run below                                                |

```sh
pnpm build
PERF_LAB_DIR=/tmp/vd-perf-lab-198 pnpm perf:oxlint-host --runs 7   # fixtures,medium,large
```

The harness takes the perf lab's lock, so it queues behind `pnpm perf run` instead of skewing it.

## Ported Rules

| Doctor Rule                                            | Code      | Shape                               | Port notes                                                                                                                                                                              |
| ------------------------------------------------------ | --------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/boundaries/no-unvalidated-deserialization` | TS0005    | Simple callee filter                | `ScriptNode` split into 6 typed visitors. Same regex `hasLocalBindingBefore` heuristic.                                                                                                 |
| `vite/assets/no-public-src-import`                     | VITE0002  | Import-based, Project Inventory     | `ImportDeclaration` visitor. Reads Vite `publicDir`, project root and Nuxt `appDir` from settings.                                                                                      |
| `vite/assets/no-dynamic-new-url`                       | VITE0001  | Callee filter, Vite alias inventory | Vite aliases can be RegExps, so the capture serializes them as `{ regexp: { source, flags } }`.                                                                                         |
| `vue/reactivity/no-setup-props-destructure`            | VUE0007   | Scope/binding-heavy Vue script Rule | Doctor re-parses with typescript-eslint. The port collects functions and declarators, then resolves bindings in `Program:exit` with `sourceCode.scopeManager`. Same logic otherwise.    |
| `nitro/request/prefer-validated-query`                 | NITRO0006 | Nitro server Rule                   | Doctor re-parses with typescript-eslint to index read references. The port reads the same references from oxlint's scope manager. File classification needs `framework` from inventory. |
| `nuxt/fetch/no-raw-fetch-in-setup`                     | NUXT0026  | Nuxt Rule gated by inventory        | `AwaitExpression` visitor. `appDir` comes from inventory.                                                                                                                               |

The only mechanical change in every port is `node.__doctorParent` becoming `node.parent`.
oxlint and Doctor both use oxc's ESTree/TS-ESTree output, so node shapes, `start`/`end` and
`range` match.

## Method

- Same Rules only. Doctor runs `dist/cli.mjs <root> --no-cache --format json --rules <active>`.
  oxlint runs `oxlint -c <tmp config> --disable-nested-config --format json --threads 4 <paths>`
  with every built-in rule off and only the ported Rules that Doctor activated for that corpus.
- Corpora are the perf lab clones at `/tmp/vd-perf-lab-198` (#185, #225): `medium` is npmx.dev
  (Nuxt, 601 Doctor files) and `large` is vitehub (1,518 Doctor files). Since #218 the vitehub
  root is a multi-Nuxt workspace that Doctor refuses in auto mode, so `large` runs with
  `--framework nitro`, which is how it ran before #218. Only 4 of the 6 Rules activate there.
- Cold means the Doctor analysis cache is off. The OS page cache is warm for both engines.
  oxlint has no cache.
- CPU is user + system time of the whole process from `scripts/perf-lab/probe.mjs`. oxlint's Rust
  threads live in the same Node process (napi), so they are included.
- 7 runs per engine, alternated, with the order reversed every other run. Tables show medians.
- Machine: 4 vCPU AMD EPYC 7452, shared with other agents. 1-minute load average was 5.8 to 10
  during the run, so wall time is noisy. CPU time is the more reliable number.
- oxlint 1.75.0 (through vite-plus 0.2.7), `@oxlint/plugins` 1.73.0, Node 24.19.0, 4 oxlint
  threads (`threads_count` in oxlint's JSON).

Engines:

- `doctor`: current engine, the same Rules only.
- `oxlint`: oxlint's own file discovery over the whole corpus.
- `oxlint-files`: oxlint given Doctor's exact file list. This is the fair comparison.
- `oxlint-files-1t`: same with `--threads 1`.
- `oxlint-files-noop`: same file list, one JS rule that only visits `Program`. This is the floor
  for "every AST is handed to JS".
- `oxlint-rust-correctness`: native oxlint `correctness` rules, no JS plugins. This is the
  reference point from #197.

## Results

### medium (npmx.dev)

| Engine                  | Files | Wall ms | CPU ms | Max RSS MB |
| ----------------------- | ----: | ------: | -----: | ---------: |
| doctor                  |   601 |   6,445 |  7,584 |        565 |
| oxlint (own discovery)  |   803 |   1,478 |  1,500 |        147 |
| oxlint-files            |   601 |   1,190 |  1,106 |        119 |
| oxlint-files-1t         |   601 |   1,248 |  1,116 |        114 |
| oxlint-files-noop       |   601 |     817 |    882 |        109 |
| oxlint-rust-correctness |   601 |     154 |    134 |        100 |

### large (vitehub, `--framework nitro`)

| Engine                  | Files | Wall ms | CPU ms | Max RSS MB |
| ----------------------- | ----: | ------: | -----: | ---------: |
| doctor                  | 1,518 |   8,723 |  8,163 |        700 |
| oxlint (own discovery)  | 2,439 |   6,096 |  5,194 |        287 |
| oxlint-files            | 1,518 |   3,039 |  2,718 |        199 |
| oxlint-files-1t         | 1,518 |   3,390 |  2,745 |        147 |
| oxlint-files-noop       | 1,518 |   2,546 |  2,553 |        198 |
| oxlint-rust-correctness | 1,518 |     382 |    468 |        107 |

### fixtures (29 files)

| Engine                  | Wall ms | CPU ms |
| ----------------------- | ------: | -----: |
| doctor                  |   1,287 |  1,179 |
| oxlint-files            |     263 |    212 |
| oxlint-rust-correctness |      83 |     46 |

All samples are in `results/*.json`.

### Where the time goes

Doctor, from one `--profile` run with the same Rules (ms, in-process):

| Corpus | project | parse phase | fileRules | slowest Rules                                              |
| ------ | ------: | ----------: | --------: | ---------------------------------------------------------- |
| medium |     197 |       3,785 |       815 | no-setup-props-destructure 212, prefer-validated-query 149 |
| large  |     164 |       6,045 |     2,880 | no-unvalidated-deserialization 340, no-dynamic-new-url 218 |

With six script Rules selected, Doctor still spends most of the run in its parse phase. That
phase builds SFC descriptors, template ASTs and FileFacts for the workspace graph whether or not a
selected Rule needs them. The two scope-heavy Rules re-parse each file with typescript-eslint on
top of that.

oxlint, read off the engine table:

- `oxlint-files` and `oxlint-files-1t` use the same CPU and are within about 10% wall time of
  each other on both corpora, and wall
  time is close to CPU time. The run is effectively single-threaded. Rust parses in parallel, but
  oxlint deserializes every AST and walks it on the one JS thread, and that dominates.
- The JS floor (`noop` minus `rust-correctness`) is about 750 ms for 601 files and about 2,100 ms
  for 1,518 files, roughly 1.3 ms per file. That is the price of raw transfer plus full AST
  deserialization in JS before any Rule runs.
- The ported Rules themselves add about 220 ms on medium and 170 ms on large (`oxlint-files`
  minus `noop`), including the lazy typescript-eslint scope analysis oxlint runs for the two
  scope-heavy Rules.
- Native Rust rules are another 5x to 7x cheaper than the JS floor. That gap is what a Rust
  Rule implementation would buy, and Doctor Rules are not written in Rust.
- oxlint's own discovery lints tests, fixtures and scripts that Doctor skips: 803 vs 601 files on
  medium, 2,439 vs 1,518 on large. A host has to pass Doctor's file list or ignore patterns.

Against Doctor, same files: 6.9x less CPU on medium (7,584 to 1,106 ms) and 3.0x less on large
(8,163 to 2,718 ms). Wall time drops 5.4x and 2.9x. oxlint numbers exclude Project Inventory;
Doctor still has to compute it before oxlint starts (`project` phase, 160 to 280 ms here).

## Parity

Comparison key is `path:code:start:end` in UTF-16 offsets, plus message and line/column checks.

| Corpus   | Doctor | oxlint raw | oxlint after Doctor fingerprint dedupe | Matched | Doctor-only |                                        oxlint-only |
| -------- | -----: | ---------: | -------------------------------------: | ------: | ----------: | -------------------------------------------------: |
| medium   |     29 |         31 |                                     29 |      29 |           0 |                                                  0 |
| large    |     19 |         22 |                                     20 |      19 |           0 | 0, plus 1 suppressed by a `doctor-disable` comment |
| fixtures |     27 |         29 |                                     28 |      27 |           0 |                     1, expected (mixed SFC blocks) |

Messages and line/columns match for every matched Diagnostic. The directory-discovery run and
the Doctor-file-list run give the same in-scope result. Every difference has a known cause:

1. **Byte offsets.** oxlint's JSON output reports UTF-8 byte offsets. Doctor uses UTF-16. Line and
   column agree. Files with non-ASCII text before a finding (arrows, emoji in comments) shifted by
   2 to 4 until the harness converted them. JS plugin nodes themselves use UTF-16 offsets.
2. **Fingerprint collisions drop real Diagnostics in Doctor.** Doctor's fingerprint is
   `sha256(ruleId:file:nearestAnchor:why)`, where the anchor is the name of the nearest preceding
   `const`/`let`/`var`/`function`. Dedupe then keeps the first Diagnostic per fingerprint. In
   npmx.dev `cli/src/server.ts`, `const users = JSON.parse(...) as ...` appears at lines 519 and
   599, and `const packages = ...` at 679 and 716, so Doctor reports 2 of 4 genuine TS0005
   findings. vitehub loses 2 more the same way, and the fixtures lose a class field whose nearest
   declaration is the `const` above it. This is a Doctor bug that has nothing to do with the host.
   It is worth its own issue (not filed, per the no-comment rule).
3. **Suppressions.** vitehub `packages/blob/src/drivers/fs.ts:308` has a
   `doctor-disable-next-line` comment. Doctor moves the finding to `suppressedDiagnostics`; oxlint
   does not know the directive. Doctor finds these comments by re-parsing the file (oxc for
   scripts, vue-eslint-parser for SFCs), which is report-boundary work any host keeps.
4. **Mixed `<script>` + `<script setup>` blocks** (fixture `MixedBlocks.vue`). oxlint lints each
   block as its own `Program`, with block-local source text and scope, and maps spans back to the
   file. Doctor merges both blocks into one `Program` at file offsets and runs source-text
   heuristics over the whole SFC, template included. When `const JSON = ...` lives in `<script>`
   and `JSON.parse(text) as T` in `<script setup>`, Doctor stays quiet and oxlint reports TS0005.
   Any Rule that resolves bindings across blocks behaves differently. Real code rarely hits this,
   and the corpora did not.
5. **Scope of files.** One TS0005 in an npmx.dev spec file and 49 in vitehub tests and fixtures
   are outside Doctor's file set. They are excluded from the comparison above.

## What maps cleanly

- **Visitor shape.** The typed visitors from Rule Pack v2 (#190) map one to one to oxlint
  visitors, including `:exit` and `Program:exit` for whole-file analysis. The current catch-all
  `ScriptNode` would need oxlint's `*` selector and dispatch every node into JS, so #190 is a
  prerequisite for any host.
- **AST and ranges.** Same oxc ESTree/TS-ESTree shapes and UTF-16 `start`/`end`/`range`. oxlint
  sets `node.parent`. `ctx.range(node)` becomes the node itself; SFC block spans come back in file
  positions.
- **Scope analysis.** `sourceCode.scopeManager` is typescript-eslint's scope manager, run lazily in
  JS over the AST oxlint already deserialized. The ported Vue and Nitro Rules use it unchanged in
  place of `parseForESLint`. That re-parse is the cost #225 measured (29.9 s of 33.8 s of
  `runFileRules` on vitehub with Vue Rules active).
- **Codes and messages.** Diagnostic Code plus `why` fit in oxlint's `message`; parity confirms the
  text. Fixes could use oxlint's fixer and `suggest` APIs for Doctor's structured edit plans (not
  exercised here).
- **Rule options.** oxlint accepts options only when a rule declares `meta.schema` or
  `defaultOptions`. Doctor's `ctx.options` would need schemas.

## What does not map

- **Vue templates.** oxlint parses only the `<script>` blocks of `.vue` files. Every `TemplateNode`
  and `SFC` Rule (button types, `v-html`, i18n, `no-src-absolute-public-url`, hydration template
  checks) has to stay on Doctor's engine, which means Doctor still runs `@vue/compiler-sfc` and
  vue-eslint-parser on every SFC, and those files get parsed twice.
- **Project Inventory and Runtime Evidence.** The only channel is `settings`, which oxlint
  `JSON.parse`s and deep-freezes again for every file that reads it. JSON also cannot carry
  RegExp aliases, functions or Maps. The experiment passes a path in `settings` and loads the
  inventory file once per process. That forces a two-phase run: Doctor computes inventory in JS,
  writes it out, spawns oxlint, then ingests results. Inventory that only exists in-process (the
  Vite Plugin Surface's resolved aliases and `publicDir`, runtime graph resolution, Nuxt
  compatibility) has to be serialized first. CLI runs have no Vite inventory at all today, so the
  `vite` fields were `null` on both corpora.
- **Diagnostic metadata.** oxlint diagnostics have a message and a span. The mandatory `fix`, docs
  URL, per-Diagnostic severity (`nuxt/no-manual-action-usefetch` picks error or warn per finding),
  confidence, evidence and category have no slot. ADR-0010 wants `nostics` Diagnostics built from
  code and params at the report boundary, so a host needs a side channel carrying code + params
  (for example JSON in `message`, or a side file) that Doctor re-hydrates through the Diagnostics
  Host. Raw oxlint text must never reach users.
- **Fingerprints, suppressions, baselines, `--changed`.** All Doctor report-boundary steps over
  source text. The harness had to re-implement the fingerprint to compare. oxlint's own
  `oxlint-disable` / `eslint-disable` comments would also silence Doctor Rules, which is a second,
  conflicting suppression syntax.
- **`ctx.cache` and run lifecycle.** Doctor's `RuleCache`, the per-file memo in
  `script-scope.ts`, and `onWorkspaceStart`/`onProjectEnd` assume one process with a run lifecycle.
  oxlint has module state per process plus per-file `createOnce` `before`/`after` hooks, and no
  run-level hooks. It works today because JS plugins run on one thread; it breaks the day oxlint
  moves JS plugins to workers.
- **Cross-file Rules and analyses.** Workspace graph, `NuxtManifest`, graph Rules, dead code, dupes
  and health need FileFacts for every file. oxlint has no cross-file phase and no way to return
  facts. Doctor would still parse every file to build FileFacts, which removes much of the parse
  savings above for normal (non `--rules`) runs.
- **Programmatic use.** oxlint has no public JS API. The CLI talks to an internal napi binding, and
  JS plugins are alpha and "not subject to semver". Doctor would spawn the CLI with a generated
  config, from both the CLI Surface and inside Vite's process for the Vite Plugin Surface.

## Constraints from the ADRs

- **ADR-0004 (Rule Pack format).** Rule Packs are the stable library-author format, so authors must
  not write oxlint rules. A host would be an adapter (`toOxlintRule(doctorRule)`) that builds a
  `RuleContext` facade: file handle, read-only inventory view, helpers, and `ctx.report` writing to
  the side channel. That adapter only covers the subset of the format oxlint can run: typed
  visitors, ESTree nodes with `parent`, an eslint-scope compatible scope API, JSON inventory, no
  template or SFC hooks, no cross-file state. Doctor would end up with two executors behind one
  format, picked per Rule from `requires`. That is a real format constraint: new format features
  would need to work on both executors or be flagged as JS-only.
- **ADR-0003 (shared Doctor Run).** An oxlint host can only be a step inside the shared Doctor Run
  (inventory, host file Rules, ingest, cross-file Rules, report), used the same way by the CLI
  Surface and the Vite Plugin Surface. Surfaces must not call oxlint directly. Nothing here
  violates that; a production version would have to keep it.
- **ADR-0010.** See diagnostic metadata above. The side channel has to carry code + params, not
  rendered text.

No ADR files were added or changed.

## Release-matrix cost

- **oxlint JS plugins.** Doctor would add `oxlint` as a runtime dependency (today it only arrives
  as a dev dependency through vite-plus). That brings 19 platform binding packages through
  `optionalDependencies`, about 16 MB unpacked on linux-x64. oxc maintains them. There is no
  wasm binding for oxlint (oxc-parser has one), so StackBlitz/WebContainers and other unsupported
  platforms need the current JS engine as a fallback. The alpha plugin API means an exact version
  pin and re-testing on every oxlint bump.
- **Rust core via napi.** Doctor would own the crate: a CI matrix of 8 to 10 targets (darwin
  x64/arm64, linux x64/arm64 gnu/musl, win32 x64/arm64, wasm32-wasi), one package per target per
  release, provenance, a Rust toolchain for contributors, and tracking oxc crate versions. A Rust
  core that does discovery, parsing, semantic and facts and then hands raw-transfer ASTs to JS
  Rule Packs is oxlint's JS-plugin architecture. The measurements show its JS side (about 1.3 ms
  per file to deserialize, on one thread) then dominates. Going faster than that means Rules in
  Rust, which conflicts with ADR-0004.

## Recommendation

**No-go** on oxlint JS plugins as Doctor's file-Rule engine today. The speedup is real but
narrow: it covers script-only file Rules in `--rules` runs, it is single-threaded, it needs a
two-phase run with serialized inventory, a diagnostic side channel and a second executor in the
Rule Pack format, and it rests on an alpha API without a programmatic entry point. Template Rules,
cross-file Rules and FileFacts keep Doctor's parse phase alive regardless.

**No-go** on a Rust core for now. It costs a release matrix and buys the same JS-side ceiling,
unless Rules move to Rust.

**Go** on the in-process wins this experiment isolates. Each one is something oxlint does that
Doctor can do without oxlint:

1. Land #190. Typed visitors are a prerequisite for any host and cut dispatch on their own.
2. Run `@typescript-eslint/scope-manager` `analyze()` over the oxc AST Doctor already parsed,
   shared per file, instead of `parseForESLint` re-parses. Doctor already depends on the scope
   manager. This is the change that made the two scope-heavy Rules cheap here.
3. Make the parse phase lazy: SFC descriptors, template ASTs and FileFacts only when a selected
   Rule or analysis needs them. With 6 script Rules selected it was 3.8 s of a 6.4 s run on medium.
4. Measure worker-thread file Rule execution owned by Doctor. That is the only way to use more
   than one core for JS Rules, and oxlint does not do it either.
5. Fix fingerprint collisions so distinct findings in one scope stop deduping each other (parity
   finding 2).

Revisit oxlint when it ships a stable JS-plugin API, a programmatic entry point and JS plugins on
worker threads, or Vue template support. The harness is reusable: rerun
`pnpm perf:oxlint-host` against a newer oxlint. Separately, once #190 lands, the same adapter
could export Doctor Rule Packs as an oxlint plugin for people who already run oxlint. That would
be a new surface and needs a product decision first.
