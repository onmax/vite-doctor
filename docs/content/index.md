---
title: Vue Doctor & Nuxt Doctor
description: Diagnose Vue 3.5 and Nuxt 4 codebase health. Catches reactivity mistakes, SSR hazards, hydration risks, route middleware leaks, and stale module APIs before review.
navigation: false
seo:
  title: Vue Doctor & Nuxt Doctor — framework-aware diagnostics
  description: Diagnose Vue 3.5 and Nuxt 4 codebases. Catch reactivity mistakes, SSR hazards, hydration risks, route middleware leaks, and stale module APIs before review.
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
Diagnose Vue and Nuxt codebase health.

#description
Framework-aware diagnostics for Vue 3.5 and Nuxt 4. Catch reactivity mistakes, SSR hazards, hydration risks, route middleware leaks, runtime config exposure, and stale module APIs before they reach review.

#links
:u-button{to="/nuxt/getting-started" size="xl" trailing-icon="i-lucide-arrow-right" label="Get started"}
:u-button{to="https://github.com/onmax/nuxt-doctor" size="xl" color="neutral" variant="outline" icon="i-simple-icons-github" label="GitHub" target="\_blank"}

#body
:::code-group{class="hero-code"}

```bash [Nuxt]
pnpm dlx nuxt-doctor .
```

```bash [Vue]
pnpm dlx vue-doctor
```

:::
::

::u-page-section
#headline
Why Doctor

#title
Find framework bugs, not generic style issues.

#description
Doctor reads Vue SFCs, templates, Nuxt project metadata, and optional Nuxt manifests. It focuses on mistakes that are easy to miss in code review: destructured prop watchers, async computed getters, raw fetches in SSR setup, route middleware leaks, runtime config exposure, and stale module APIs.
::

::u-page-section
#headline
Pick your track

#title
Same engine, two entry points.

#description
Run the Vue analyzer on any Vue 3.5 codebase, or extend it with Nuxt 4 awareness for routing, Nitro, runtime config, and modules.

#body
:::u-page-grid{class="!grid-cols-1 sm:!grid-cols-2 !gap-4"}
::::u-page-card

---

icon: i-simple-icons-vuedotjs
to: /vue
spotlight: true
spotlight-color: primary

---

#title
Vue Doctor
#description
Core analyzer for Vue 3.5 SFCs, reactivity, templates, SSR, and security checks. Runs on any Vue project.
::::

## ::::u-page-card

icon: i-simple-icons-nuxtdotjs
to: /nuxt
spotlight: true
spotlight-color: secondary

---

#title
Nuxt Doctor
#description
Same engine plus Nuxt 4 imports, routing, Nitro, runtime config, and module manifest checks.
::::
:::
::

::u-page-section
#headline
Flags

#title
Tune the scan to the moment.

#description
The same flags work for `vue-doctor` and `nuxt-doctor`. Mix them to triage a single rule, gate a CI job, or stream JSON to an agent.

#body
:::u-page-grid{class="flag-grid !grid-cols-1 sm:!grid-cols-2 lg:!grid-cols-3 !gap-4"}
::::u-page-card

---

icon: i-lucide-git-branch
variant: subtle

---

#title
`--changed`
#description
Scan only files that changed against the base branch. Useful in CI and pre-commit.
::::

## ::::u-page-card

icon: i-lucide-wand-2
variant: subtle

---

#title
`--fix`
#description
Apply safe fixes only. Use `--unsafe-fix` to include fixes that need a quick review.
::::

## ::::u-page-card

icon: i-lucide-filter
variant: subtle

---

#title
`--rules <id>`
#description
Run a single rule or rule prefix when triaging or building a CI policy.
::::

## ::::u-page-card

icon: i-lucide-alert-triangle
variant: subtle

---

#title
`--severity error`
#description
Report only errors and blockers. Pair with `--max-warnings 0` to fail CI on warnings.
::::

## ::::u-page-card

icon: i-lucide-braces
variant: subtle

---

#title
`--json`
#description
Emit machine-readable output for agents, dashboards, or custom tooling.
::::

## ::::u-page-card

icon: i-lucide-shield-check
variant: subtle

---

#title
`--trusted-config`
#description
Local `doctor.config.*` is executable, so Doctor only loads it when you opt in.
::::
:::
::

::u-page-section
#headline
Where it runs

#title
Local, CI, or from an agent.

#body
:::u-page-grid{class="!grid-cols-1 sm:!grid-cols-3 !gap-4"}
::::u-page-card

---

icon: i-lucide-terminal
to: /nuxt/getting-started

---

#title
CLI-first scans
#description
Run `vue-doctor` or `nuxt-doctor` locally, in CI, or against changed files.
::::

## ::::u-page-card

icon: i-lucide-package
to: /nuxt/module

---

#title
Nuxt manifest
#description
Generate `.nuxt/doctor.manifest.json` for sharper auto-import, layer, route, and server-handler diagnostics.
::::

## ::::u-page-card

icon: i-lucide-shield-alert
to: /nuxt/rules

---

#title
High-signal rules
#description
Focused Vue and Nuxt rule packs with safe fixes where the engine can preserve behavior.
::::
:::
::

::u-page-section
#title
Ship Vue and Nuxt code with fewer surprises.

#description
Run a scan in seconds. No config required, no executable config loaded by default.

#links
:u-button{to="/nuxt/getting-started" size="xl" trailing-icon="i-lucide-arrow-right" label="Get started"}
:u-button{to="/vue" size="xl" color="neutral" variant="outline" label="Read the Vue guide"}
::
