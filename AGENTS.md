# AGENTS.md instructions for /Users/maxi/nuxt/doctor

Code comments: only when necessary; explain _why_, not _what_. If code is self-explanatory, skip comments.

## Git / GitHub

- For GitHub actions (PRs, issues, releases, etc.) use `gh` CLI (not the web UI).
- Never comment on Issues or Pull Request without explicit consent.

## CLI

- `gh`, `vercel`, `wrangler`
- NuxtHub CLI is deprecated: never use `npx nuxthub`. Deployments happen via git push -> Cloudflare CI.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues for `onmax/vite-doctor`; use the `gh` CLI. See `.agents/issue-tracker.md`.

### Triage labels

Use the default five-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `.agents/triage-labels.md`.

### Domain docs

This is a single-context repo: use root `CONTEXT.md` and root `.agents/adr/`. See `.agents/domain.md`.
