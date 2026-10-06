# Doctor

This is the repository for Doctor, published as `vite-doctor`: framework-aware diagnostics for Vue, Vite, Nitro, Nuxt, and the projects around them. Doctor finds what a generic linter can't see and reports it in a form an agent can fix.

Start with `CONTEXT.md` for vocabulary, then read the relevant ADRs in `.agents/adr/` before touching architecture, diagnosis, surface design, issue generation, or broad refactors.

## Current status

Active product development, pre-1.0. Breaking changes are fine when they improve the final developer experience. Remove legacy paths and compatibility code that no longer serve the model instead of carrying them forward.

## A note from the author (Maxi)

This is a letter from me to you, the agent working on Doctor. Most of Doctor's output will be read by agents, not people, so I want you building it with that reader in mind.

Quick glossary:

- _you_: the agent reading this file and working on Doctor itself.
- _me_/_we_/_us_: the humans contributing to Doctor.
- _developers_: our users. They run Doctor in their Vite, Nuxt, and Nitro projects, often through their own agents, and rarely read Doctor's source.
- _agents_: the agents developers use to read Doctor reports and fix their code. This does NOT mean you.

### Know the framework better than the linter

Doctor's value is not generic linting. Anyone can run oxlint. Our value is framework-specific diagnosis: knowing that a Vite env variable ends up in the client bundle, or that a Nuxt auto-import shadows another one. Rule Packs should read like the framework maintainers wrote them.

If doing this right means parsing SFCs ourselves or collecting Runtime Evidence from a live dev server, do it. Don't settle for a pattern match when real evidence is available.

### Let their agents do the fixing

Build primitives, not features: Rule Packs and Presets, Doctor Extensions, Project Inventory, Runtime Evidence, CLI and Plugin Surfaces, Diagnostic Codes and their docs, and structured reports. Library authors and framework integrations compose them. Developers' agents act on the output.

Should Doctor report an exposed env variable with the file, range, Diagnostic Code, and a safe fix? Absolutely. Should Doctor ship a dashboard to triage those reports? No. An agent can read the JSON.

### Fight for the obvious surface

The obvious solution is whatever an agent would assume without reading the docs. If an agent would reasonably expect a report field, flag, or config option to work a certain way, make that true unless it conflicts with an ADR. Push back on us when you see a more obvious way.

Plugin Surfaces are first-class, not thin CLI wrappers. Doctor config should feel native in `vite.config.ts`, `nuxt.config.ts`, and future host configs while still feeding the same Doctor Run. Developers should never need to know about internal workspace packages, the Nuxt bridge, or Doctor Extension plumbing to get normal usage working.

### Shape the output, never the evidence

Format, order, and group reports however agents work best. Severity, location, confidence, and fix safety must be true. Agents act on what we report, so a false positive costs more than a missing diagnostic. When evidence is partial, the report has to say so.

## General rules

These are defaults, not laws. If you think one should be ignored, say so loudly and get approval before doing it.

- preserve Doctor's domain language from `CONTEXT.md` over local convenience;
- CLI Surface and Plugin Surface share one Doctor Run path;
- keep framework details behind Doctor language unless the framework boundary is the work;
- treat downstream workarounds as possible Doctor gaps unless they are clearly app-specific;
- executable config is a trust boundary: loading `doctor.config.*` stays explicit on the CLI, while host configs are already trusted and can pass Doctor config in memory;
- prefer existing libraries and modern tools when they fit; use AI tooling freely, but review the result against the ADRs;
- prefer inspectable artifacts (code, tests, reports, CLI output, manifests) over dashboards and hidden state;
- if a task contradicts an ADR, say so before changing the model;
- comments are rare and explain why, never what.

## Working here

- `pnpm ready` formats, builds, lints, and tests. Run it before opening a PR.
- Use `gh` for issues, PRs, releases, and workflow runs. Issues and PRDs live in this repository's GitHub Issues.
- Never comment on Issues or Pull Requests without explicit consent.
- Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Available CLIs: `gh`, `vercel`, `wrangler`. Never use `npx nuxthub`; it is deprecated. Deployments happen through git push and Cloudflare CI.
- Prefer the Browser skill over agent-browser, Chromium, or Playwright for local web targets unless asked otherwise.
- Other agents may be working in parallel. Don't overwrite changes you didn't make; inspect collisions and adapt around them.
