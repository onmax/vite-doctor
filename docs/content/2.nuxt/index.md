---
title: Overview
description: Use Nuxt Doctor to scan Nuxt 4 apps and modules.
---

Nuxt Doctor extends Vue Doctor with Nuxt 4 project detection, auto-import awareness, route middleware checks, Nitro/server rules, runtime config checks, hydration diagnostics, module overlays, and the optional `vite-doctor/nuxt` manifest.

## What it checks

Nuxt Doctor combines Vue rules with Nuxt-specific checks:

- **Imports and composables** — auto-import collisions, explicit `#imports`, and shadowed Nuxt composables.
- **Fetching** — raw `$fetch` or `fetch` in SSR setup and custom wrappers that await `useFetch` or `useAsyncData`.
- **Routing and middleware** — incorrect `useRoute`, `navigateTo`, router navigation, and API trust inside route middleware.
- **Server boundaries** — `useNuxtApp` or `navigateTo` in Nitro/server code.
- **Runtime and hydration** — public runtime secrets, browser side effects in setup, unstable keys, and non-serializable state.
- **Module overlays** — Nuxt Content, Nuxt UI, Nuxt Scripts, VueUse, and Better Auth checks when those modules are present.

::u-page-section
#title
Start with Nuxt Doctor

#body
:::u-page-grid{class="!grid-cols-1 sm:!grid-cols-2 !gap-4"}
::::u-page-card

---

icon: i-lucide-terminal
to: /nuxt/getting-started

---

#title
Install and run
#description
Install once, get Nuxt-aware checks.
::::

::::u-page-card

icon: i-lucide-package
to: /nuxt/module

---

#title
Add the module
#description
Generate `.nuxt/doctor.manifest.json` for faster and more accurate Nuxt diagnostics.
::::

::::u-page-card

icon: i-lucide-bot
to: /nuxt/ai

---

#title
AI reports
#description
Expose read-only MCP reports and combine them with agent-ready runtime logs.
::::
:::
::

## Commands

Add the Vite Doctor Nuxt module to a Nuxt app:

```bash
pnpm dlx nuxt module add vite-doctor/nuxt
```

List the Nuxt and Vue rule packs:

```bash
pnpm dlx vite-doctor rules
```

Fail on warnings:

```bash
pnpm dlx vite-doctor . --max-warnings 0
```
