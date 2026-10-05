# Doctor Perf Lab

A repeatable place to measure Doctor Runs before and after a change, and to prove a change keeps
Diagnostics identical.

The lab runs a built `dist/cli.mjs` against pinned public corpora:

| Corpus     | Project                                                             | Why                               |
| ---------- | ------------------------------------------------------------------- | --------------------------------- |
| `small`    | [vitesse-lite](https://github.com/antfu-collective/vitesse-lite)    | Vite + Vue starter                |
| `tailwind` | [nuxt-ui-templates/saas](https://github.com/nuxt-ui-templates/saas) | Nuxt + Tailwind, shadcn Rule Pack |
| `medium`   | [npmx.dev](https://github.com/npmx-dev/npmx.dev)                    | Real Nuxt app, ~800 source files  |
| `large`    | [vitehub](https://github.com/vite-hub/vitehub)                      | Monorepo, ~1,500 source files     |

Corpora are cloned without `node_modules`, so Runtime Evidence that depends on installed packages
reports as unknown. That keeps runs deterministic; use `--corpus-path` to measure an installed local
project.

## Usage

```sh
pnpm build
pnpm perf prepare                     # clone corpora into .perf-lab/corpora
pnpm perf run --label base            # measure this build
# ...change code, pnpm build...
pnpm perf run --label head
pnpm perf compare base head           # markdown table, exits 1 if Diagnostics differ
pnpm perf report head                 # phases, Rule Pack totals, slowest 20 Rules
pnpm perf trace --corpus medium       # parse count and time per parser
```

To measure another checkout without copying the lab, pass its package root:
`node scripts/perf-lab/lab.mjs run --doctor ../other-worktree --label other`.

Options:

- `--corpus small,medium` limits corpora.
- `--corpus-path name=/abs/path[:path/to/changed-file.ts]` adds a local project.
- `--runs 3` sets samples per scenario. Results report the median.
- `--scenarios nocache,cold,warm,changed,profile,startup` limits scenarios.
- `PERF_LAB_DIR` moves corpora and results out of the repository, for sharing between worktrees.

## Scenarios

- `nocache`: full Doctor Run with `--no-cache`.
- `cold`: cache cleared, then a cached run.
- `warm`: a second cached run after a priming run.
- `changed`: appends one line to the corpus `changeFile` and runs `--changed`.
- `profile`: `--profile`, recording phases and per-Rule time (`ruleTimings`).
- `startup`: `vite-doctor --version` and importing `vite-doctor/plugin`.

Each sample records wall time, CPU time, and peak RSS (via `probe.mjs`), plus a digest of the
normalized Diagnostics: code, Rule, file, range, fingerprint, severity, and suppression state.
`compare` treats a digest change as a failure and prints the added and removed Diagnostics.

Runs take a lock in the lab directory, so concurrent agents queue instead of skewing each other's
timings or editing the same corpus files.
