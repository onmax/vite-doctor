---
title: Overview
description: Use Nuxt Doctor to scan Nitro server and request-runtime code.
---

Nitro rules focus on server handlers, request validation, runtime config, and framework boundaries inside `server/` and `app/server/` code.

## What it checks

Nitro diagnostics cover request-runtime correctness:

- **Request validation** — prefer validated body, query, and route params.
- **HTTP methods** — assert expected methods inside handlers.
- **Request metadata** — use Nitro helpers such as `getRequestIP`.
- **Server boundaries** — avoid Nuxt app composables and client-only APIs in Nitro routes.
- **Runtime config** — read runtime config with the event in server code.

::u-page-section
#title
Start with Nitro rules

#body
:::u-page-grid{class="!grid-cols-1 sm:!grid-cols-2 !gap-4"}
::::u-page-card

---

icon: i-lucide-list-checks
to: /nitro/rules

---

#title
Nitro rules
#description
Review request, server, and runtime diagnostics.
::::

::::u-page-card

icon: i-lucide-terminal
to: /nuxt/getting-started

---

#title
Run Nuxt Doctor
#description
Scan Nitro code through the Nuxt Doctor CLI.
::::
:::
::

## Commands

List the Nuxt and Nitro rule packs:

```bash
pnpm dlx nuxt-doctor rules
```

Scan a Nuxt app, including Nitro server code:

```bash
pnpm dlx nuxt-doctor .
```
