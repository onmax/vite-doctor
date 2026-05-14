---
title: Nitro
description: Scan Nitro server and request-runtime code.
---

Nitro rules check server handlers, request validation, runtime config, and server/client boundaries. Run them through Nuxt Doctor or the CLI.

## Run a scan

From a Nuxt or Nitro project root:

```bash
pnpm dlx vite-doctor@alpha .
```

Nuxt projects should also add the module when they want stronger server-route and runtime-config evidence:

```bash
pnpm dlx nuxt module add vite-doctor/nuxt
```

## What it checks

Nitro rules focus on request-runtime correctness:

- validated body, query, and route params
- expected HTTP methods
- request metadata helpers
- runtime config access with the current event
- client-only APIs inside server code

Use the [Nitro rules](/rules/nitro) page when you need a rule id or fix guidance.
