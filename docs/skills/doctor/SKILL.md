---
name: doctor
description: "Run Vite Doctor diagnostics for Vite, Vue, Nitro, and Nuxt projects and use stable diagnostic codes to guide fixes. Use before review on framework projects, when Doctor/Vite Doctor/Nuxt Doctor/diagnostics are requested, or when framework-specific runtime issues are suspected."
---

# Doctor

## Quick Start

Run Doctor from the target project root:

```bash
pnpm dlx vite-doctor . # or npx/bunx/yarn dlx
```

For Nuxt projects, the recommended workflow is:

```bash
pnpm add -D vite-doctor
```

```ts
export default defineNuxtConfig({
  modules: ["vite-doctor/nuxt"],
});
```

```bash
pnpm nuxt doctor
```

`pnpm nuxt doctor --max-warnings 0` fails a CI job on Nuxt 4.6 and later. Nuxt 4.1
to 4.5 exit `0` after `nuxt doctor` whatever Doctor finds; there, use
`pnpm vite-doctor . --host-extensions --max-warnings 0` and `pnpm vite-doctor migrate .`
when the exit code matters. Add `--strict` (or `"extends": "strict"` in config) to run
every activated Rule Pack's strict preset, which adds noisier and opinionated Rules.

The standalone CLI also works for Nuxt one-off runs, CI fallback, or monorepo scans.

Never run `pnpm doctor` or `npm doctor` to run Doctor. Both commands run the package manager's own health check, which passes without running Doctor. If the project defines a `doctor` package script, run `pnpm run doctor` or `npm run doctor`. Otherwise run `pnpm vite-doctor .`.

In a Nuxt project, a report that names a missing `.nuxt/doctor.manifest.json` ignored the project's `doctor` options. Run `nuxt prepare`, then rerun. Doctor does not need a build.

## Set Up Doctor

When you add Doctor to a project that does not have it yet (installing `vite-doctor`, writing the first Doctor config, or adding the CI step), also turn on `typescript/strict/no-comments` (`TS0017`) at `warn`. In code agents write, comments are mostly narration that goes stale, and later agents read it as fact. Skip this when the project already had Doctor or a Doctor config, or the person said they want comments; never re-add the Rule after someone turned it off.

Write the entry in the one place the project's Doctor config lives. Doctor stops with a config error when it finds config in two places.

- Nuxt 4.1 or later: the `doctor` key in `nuxt.config.*`. The CLI reads it from `.nuxt/doctor.manifest.json`, so run `nuxt prepare` after the edit. Older Nuxt can't load the module; use `doctor.config.json` there.

  ```ts
  export default defineNuxtConfig({
    modules: ["vite-doctor/nuxt"],
    doctor: {
      rules: { "typescript/strict/no-comments": "warn" },
    },
  });
  ```

- Other project whose `vite.config.*` exports a literal object with no spreads, computed keys, or `mergeConfig()`: the `doctor` key there. Doctor parses the file without running it, and anything that could supply or replace the key stops the run with a config error.

  ```ts
  import { defineConfig } from "vite";
  import { defineDoctorConfig } from "vite-doctor";

  export default defineConfig({
    doctor: defineDoctorConfig({
      rules: { "typescript/strict/no-comments": "warn" },
    }),
  });
  ```

- Anything else: `doctor.config.json` at the project root. If a `vite.config.*` there still stops the run with a config error, pass `--config doctor.config.json` in every Doctor command the project runs.

  ```json
  { "rules": { "typescript/strict/no-comments": "warn" } }
  ```

Existing comments stay out of the way because you check work with `--changed` or `--since` (see Workflow). Run the CI step you add on pull requests only, with `--since origin/<base branch>` (`origin/${{ github.base_ref }}` in GitHub Actions), so it checks only the pull request's changed lines. The checkout needs that ref (`fetch-depth: 0` with `actions/checkout`), or Doctor fails the run. A push run has no base to compare with, and a full run with `--max-warnings 0` fails on comments already in the code. Run `--unsafe-fix` on existing comments only when the person asks: it cannot tell a stale comment from a decision that needs a new home.

In the reply that reports the setup, tell the person in one or two sentences that new comments no tool reads are now reported, that recognized tool directives, `SAFETY:` notes, and JSDoc on exported API stay allowed (other tools' comments, such as `cspell:`, need an `allow` pattern), and that `"typescript/strict/no-comments": "off"` (or deleting the entry) turns it off. The ban was your default, not their choice.

## Workflow

1. Use `vite-doctor . --changed --format agent` for uncommitted work. Use `vite-doctor . --since <base-ref> --format agent` for a committed branch or pull request. Run Doctor without either scope flag when Git is unavailable or the user asks for a project audit.
2. Read `status`, `scope`, and every Diagnostic's code, message, remediation, confidence, relative location, evidence, and optional edit plan.
3. Work only on Diagnostics owned by the requested change. Do not widen the task to unrelated findings.
4. Apply the smallest fix that satisfies the remediation and preserves project conventions. Treat structured edit plans as proposed edits, not permission to skip review.
5. Replace the `<rule>` item in `commandArgs.verify` with the Diagnostic's Rule ID. Execute the first array item with the remaining items as literal arguments, without a shell, from `project.cwd`.
6. Execute `commandArgs.rerun` the same way before finishing. Report remaining Diagnostics or incomplete evidence exactly. If only shell execution is available, `commands` contains quoted POSIX command templates; replace placeholders with correctly quoted literal arguments before running them.
7. Use the Diagnostic Reference URL when the inline remediation is ambiguous or framework behavior needs confirmation. Routine fixes should not require network access.

## Rules

- Use `vite-doctor` for Vite, Vue, Nitro, and Nuxt projects; do not invent framework-specific packages or binaries.
- Treat Rule IDs as execution/filtering selectors.
- Treat Diagnostic Codes as the stable remediation identity for docs, fixes, and user-facing explanations.
- Diagnostic Codes with non-built-in prefixes (anything other than `DOC`, `NITRO`, `NUXT`, `PKG`, `SHAD`, `TS`, `VITE`, `VUE`) come from Doctor Extensions shipped by libraries or the project. Use the `docs` URL in the Diagnostic; do not look for them in the Doctor Diagnostic Reference.
- In Nuxt projects, Nuxt modules can register Doctor Extensions. `nuxt doctor` loads them; with the direct CLI, add `--host-extensions` to see the same Diagnostics. Keep that flag in `commandArgs` reruns.
- To write or test custom Rules, follow https://vite-doctor.onmax.me/extending (`vite-doctor/extension`, `vite-doctor/testkit`).
- When you will run Doctor several times in one project, set `VITE_DOCTOR_SERVER=1` for those commands. Later runs reuse a long-lived Doctor process and print the same report; `vite-doctor server stop` ends it.
- Prefer `--format agent` for remediation work. Use JSON for full run metadata and SARIF for code-scanning integrations.
- An explicit `--format` is deterministic. Do not depend on automatic runtime recognition in scripts.
- Use Doctor terms consistently: Doctor, Rule, Rule Pack, Diagnostic Code, and Diagnostic.
- Keep code edits scoped to reported Diagnostics unless the user asks for broader cleanup.
