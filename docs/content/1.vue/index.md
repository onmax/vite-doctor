---
title: Overview
description: Use Vite Doctor to scan Vue 3.5 applications and libraries.
---

Vue Doctor is the Vue rule pack inside `vite-doctor`. It understands Vue SFCs, `<script setup>`, template directives, refs, computed values, watchers, SSR rendering, and safe fixes.

## What it checks

Vue Doctor focuses on framework correctness instead of formatting:

- **Reactivity** — prop mutation, refs used without `.value`, and destructured props passed directly to `watch`.
- **Computed values** — async getters and getters with side effects.
- **Watchers** — watchers or cleanup handlers registered after `await`.
- **Templates** — missing `v-for` keys, `v-if` with `v-for`, and template refs that should use `useTemplateRef`.
- **SSR and security** — browser globals in universal setup code and unsafe `v-html` usage.

::u-page-section
#title
Start with Vue Doctor

#body
:::u-page-grid{class="!grid-cols-1 sm:!grid-cols-2 !gap-4"}
::::u-page-card

---

icon: i-lucide-terminal
to: /vue/installation

---

#title
Install and run
#description
Add the CLI and scan a Vue project.
::::

::::u-page-card

icon: i-lucide-list-checks
to: /rules/vue

---

#title
Vue rules
#description
Review the first reactivity, watcher, template, SSR, and security checks.
::::
:::
::

## Commands

Run the default scan:

```bash
pnpm dlx vite-doctor@alpha .
```

List the Vue rule pack:

```bash
pnpm dlx vite-doctor@alpha rules
```

Clean the local Doctor cache:

```bash
pnpm dlx vite-doctor@alpha cache clean
```
