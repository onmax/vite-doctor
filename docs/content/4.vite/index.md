---
title: Overview
description: Use Vite Doctor rules to scan Vite-specific env, asset, worker, plugin, HMR, SSR, and dev server configuration.
---

Vite rules focus on the compile-time and dev-server surfaces that can behave differently from ordinary JavaScript.

## What it checks

- **Environment exposure** — catch secret-looking client env values and broad `envPrefix` settings.
- **Define constants** — avoid leaking secrets through Vite compile-time replacements.
- **Assets and workers** — keep URLs statically analyzable so Vite can bundle them correctly.
- **Plugins and HMR** — name local plugins and clean up side effects across hot updates.
- **SSR and dev server safety** — avoid browser globals in SSR entries and broad filesystem access.

::u-page-section
#title
Start with Vite rules

#body
:::u-page-grid{class="!grid-cols-1 sm:!grid-cols-2 !gap-4"}
::::u-page-card

---

icon: i-lucide-list-checks
to: /vite/rules

---

#title
Vite rules
#description
Review env, define, assets, workers, plugins, HMR, SSR, and server diagnostics.
::::

::::u-page-card

icon: i-lucide-terminal
to: /cli

---

#title
Run Vite Doctor
#description
Use the project CLI to run the checks configured by the project.
::::
:::
::

## Commands

List Vite rule metadata:

```bash
pnpm dlx vite-doctor rules
```

Run the scripts already defined by a Vite project:

```bash
pnpm dlx vite-doctor
```
