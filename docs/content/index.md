---
title: Vue Doctor & Nuxt Doctor
description: Static build analysis for framework code.
navigation: false
seo:
  title: Vue Doctor & Nuxt Doctor - framework-aware diagnostics
  description: Static build analysis for framework code. Doctor catches reactivity, hydration, runtime config, and server-boundary bugs before review.
---

::u-page-hero
#headline
::div{class="hero-eyebrow"}
:img{src="/vue-doctor-logo.svg" alt="Vue Doctor" class="hero-logo"}
Vue 3.5
:span{class="dot"}
:img{src="/nuxt-doctor-logo.svg" alt="Nuxt Doctor" class="hero-logo"}
Nuxt 4
::

#title
Search every Doctor rule.

#description
Static build analysis for framework code. Doctor reads app code, build config, project metadata, and server handlers to catch framework bugs before review.

#links
:u-button{to="/installation" size="xl" trailing-icon="i-lucide-arrow-right" label="Install Doctor"}
:u-button{to="/rules/nuxt" size="xl" color="neutral" variant="outline" icon="i-lucide-list-checks" label="Browse rules"}

#body
:::code-group{class="hero-code"}

```bash [Project CLI]
pnpm dlx vite-doctor@alpha .
```

```bash [Nuxt]
pnpm dlx nuxt module add vite-doctor/nuxt
pnpm exec nuxt doctor
```

```bash [Vue]
pnpm dlx vite-doctor@alpha .
```

:::
::

::u-page-section
#headline
Why Doctor

#title
Find framework bugs, not generic style issues.

#description
Doctor reads app code, templates, build configuration, project metadata, server handlers, and optional manifests. It focuses on mistakes that are easy to miss in code review: destructured prop watchers, async computed getters, raw fetches in SSR setup, route middleware leaks, runtime config exposure, and stale module APIs.
::

::u-page-section
#headline
Start

#title
Choose the entry point.

#body
:::u-page-grid{class="!grid-cols-1 sm:!grid-cols-3 !gap-4"}
::::u-page-card

---

icon: i-lucide-terminal
to: /installation

---

#title
Installation
#description
Choose the CLI, Nuxt module, or MCP setup for your workflow.
::::

::::u-page-card

---

icon: i-lucide-list-checks
to: /rules/nuxt

---

#title
Rules
#description
Search rule ids, severities, categories, and fix guidance.
::::

::::u-page-card

---

icon: i-lucide-book-open
to: /motivation

---

#title
Motivation
#description
Learn why Doctor exists for the Vue ecosystem.
::::
:::
::
