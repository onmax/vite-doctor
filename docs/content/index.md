---
title: Vite Doctor
description: Static build analysis for framework code.
navigation: false
seo:
  title: Vite Doctor - framework-aware diagnostics
  description: Static build analysis for framework code. Doctor catches reactivity, hydration, runtime config, and server-boundary bugs before review.
---

::u-page-hero
#headline
::div{class="hero-eyebrow"}
:img{src="/doctor-icon.png" alt="Doctor" class="hero-logo"}
Vite, Vue, Nuxt, and Nitro
::

#title
Search every Doctor rule.

#description
Static build analysis for framework code. Doctor reads app code, build config, project metadata, and server handlers to catch framework bugs before review.

#links
:u-button{to="/cli" size="xl" trailing-icon="i-lucide-arrow-right" label="Run Doctor"}
:u-button{to="/nuxt" size="xl" color="neutral" variant="outline" icon="i-lucide-list-checks" label="Browse frameworks"}

#body
:::code-group{class="hero-code"}

```bash [Project CLI]
pnpm dlx vite-doctor@alpha .
```

```bash [Nuxt]
pnpm add -D vite-doctor@alpha
pnpm nuxt doctor
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
to: /cli

---

#title
CLI
#description
Run project checks and framework scans.
::::

::::u-page-card

---

icon: i-lucide-list-checks
to: /nuxt

---

#title
Frameworks
#description
Choose the Nuxt, Vue, Vite, or Nitro guide before opening a rule.
::::

::::u-page-card

---

icon: i-lucide-package
to: /nuxt/rules

---

#title
Nuxt rules
#description
Install Doctor and browse Nuxt checks.
::::
:::
::
