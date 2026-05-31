# Doctor

Start with `CONTEXT.md`, then read the relevant ADRs under `.agents/adr/` before architecture, diagnosis, surface design, issue generation, or broad refactors.

## Current Status

Doctor is in active product development. Optimize changes for the final developer experience, even when that means making breaking changes, removing legacy paths, or dropping compatibility code that no longer serves the model.

Code comments should be rare. Add them only when they explain why a non-obvious decision exists; do not narrate what the code already says.

## Project Direction

Doctor is a diagnostics system for Vue, Vite, Nitro, Nuxt, and adjacent ecosystem projects. Its value is not generic linting; its value is framework-specific diagnosis, runtime evidence, rule-pack composition, and output that agents can use to remediate code quickly.

Keep the product centered on **Doctor Runs**, **Rule Packs**, **Doctor Extensions**, **CLI Surfaces**, **Plugin Surfaces**, **Project Inventory**, **Runtime Evidence**, **Diagnostics**, and **Diagnostic Codes**. Use the vocabulary in `CONTEXT.md` when naming work, discussing architecture, writing tests, or creating issues.

## AI Stack

Use modern AI tooling aggressively and pragmatically. Pre-trained chains, generated first drafts, hosted model tools, and agent workflows are acceptable when they move the project faster and the final code is still reviewed against Doctor's architecture.

Prefer tools and workflows that leave concrete, inspectable artifacts: code, tests, Doctor reports, CLI output, generated manifests, and machine-readable diagnostics. Do not hide essential behavior behind dashboard-only workflows or uninspectable state.

Treat agent-facing ergonomics as a product requirement. If an agent consumer would reasonably expect an API, report field, command, or config surface to work a certain way, try to make that assumption true unless it conflicts with a documented ADR.

## Build Diagnostics Primitives, Not Everything

Avoid app-level feature creep. Build reusable Doctor primitives that library authors, framework integrations, and agent consumers can compose:

- Rule Packs and Presets
- Doctor Extensions
- Project Inventory
- Runtime Evidence
- CLI Surfaces and Plugin Surfaces
- Diagnostic Codes and documentation
- structured reports for automation

Do not build product-specific UI or workflow automation unless it directly improves Doctor's diagnostics model or documentation.

## Fight For The Obvious Surface

Plugin Surfaces are first-class product surfaces, not thin CLI wrappers. Surface configuration should feel native in `vite.config.ts`, `nuxt.config.ts`, and future host configs while still feeding the shared Doctor Run model.

Avoid designs that force users to understand internal workspace packages, transitional Nuxt bridge details, or Doctor Extension plumbing before normal usage works.

Executable config files are a trust boundary. Loading `doctor.config.*` must stay explicit where the CLI surface treats it as executable input. Host config options are already trusted by the host system, so they can pass in-memory Doctor configuration directly.

## Default Rules

- Preserve Doctor's domain language over local convenience.
- Prefer existing libraries and modern tools when they fit the architecture.
- Make Plugin Surface and CLI Surface behavior share one Doctor Run path.
- Keep framework-specific implementation details behind Doctor language unless the framework boundary is the work.
- Treat downstream workarounds as possible Doctor gaps unless they are clearly app-specific.
- If a task contradicts an ADR, say so before changing the model.
- If a rule should be ignored, say why explicitly before doing it.

## Git / GitHub

Use `gh` CLI for GitHub actions such as issues, PRs, releases, and workflow inspection. Do not use the GitHub web UI for project operations.

Never comment on Issues or Pull Requests without explicit user consent.

Issues and PRDs live in GitHub Issues for this repository. Infer the repo from `git remote -v`; see `.agents/issue-tracker.md`.

Use the default triage-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `.agents/triage-labels.md`.

## CLI

Available project CLIs include `gh`, `vercel`, and `wrangler`.

NuxtHub CLI is deprecated: never use `npx nuxthub`. Deployments happen through git push and Cloudflare CI.

Prefer the Browser skill over agent browser, Chromium, or Playwright when inspecting local web targets, unless the user explicitly asks for a different browser tool.

## Parallel Work

Assume other agents may be working in parallel. Do not overwrite changes you did not make. If a collision appears, inspect it and adapt around it rather than reverting someone else's work.
