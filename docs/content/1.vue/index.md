---
title: Vue
description: Run Vue Doctor in a Vue 3.5 project.
---

Vue Doctor scans Vue SFCs for framework mistakes that ordinary lint rules miss.

## Run a scan

From a Vue project root:

```bash
pnpm dlx vite-doctor@alpha .
```

Use the same command in CI when Vue diagnostics should block a pull request:

```bash
pnpm dlx vite-doctor@alpha . --max-warnings 0
```

## What it checks

Vue Doctor focuses on SFC, reactivity, template, watcher, SSR, and security problems:

- refs used incorrectly
- watcher cleanup registered too late
- missing stable template keys
- unsafe `v-html`
- browser APIs in universal setup code

## Browse rules

Use the [Vue rules](/rules/vue) page when you need a rule id for `--rules`, CI policy, or a review note.
