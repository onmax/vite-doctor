---
title: Nuxt
description: Add Nuxt Doctor to a Nuxt 4 project.
---

Nuxt Doctor combines the CLI with a Nuxt module. Use both: the module gives Doctor better Nuxt evidence, and the CLI gives CI/CD a single command to run.

## Add the module

Install the module first:

```bash
pnpm dlx nuxt module add vite-doctor/nuxt
```

Then run the Nuxt command:

```bash
pnpm exec nuxt doctor
```

The module writes Nuxt project evidence into the build directory. Doctor uses it for auto-imports, components, layers, aliases, route rules, server handlers, runtime config, and keyed composables.

## Run in CI/CD

Use the CLI from the project root:

```bash
pnpm dlx vite-doctor@alpha . --max-warnings 0
```

## Browse rules

Use [Nuxt rules](/rules/nuxt) for app, routing, hydration, runtime config, and module checks.

Use [Nitro rules](/rules/nitro) for server handlers and request-runtime checks.
