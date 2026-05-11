---
title: "Rule reference"
description: "Nitro request-runtime diagnostics in the Nuxt Doctor rule pack."
---

# Rules

Nitro rules cover server and request-runtime boundaries, event-aware helpers, validation, HTTP method assertions, and request metadata.

Nuxt Doctor consumes this shared Nitro rule pack for `server/` and `app/server/` diagnostics.

These pages are generated from rule metadata in `packages/nuxt/src/rules/nitro` and shared Nuxt server rules.

The same metadata is exported as JSON under `/rules/` in the docs site.

## Rules

| Rule                                                                                                      | Title                                             | Pack                | Severity | Category         | Fix        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------- | -------- | ---------------- | ---------- |
| [`nuxt/context/no-usenuxtapp-in-nitro`](./context/no-usenuxtapp-in-nitro)                                 | Do not use useNuxtApp in Nitro routes             | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |
| [`nuxt/context/no-navigateto-in-nitro`](./context/no-navigateto-in-nitro)                                 | Do not use navigateTo in Nitro routes             | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |
| [`nuxt/server/prefer-event-fetch`](./server/prefer-event-fetch)                                           | Use event.$fetch in Nitro handlers                | `nuxt-doctor/nitro` | `warn`   | `server`         | suggestion |
| [`nuxt/runtime/require-event-runtime-config-in-server`](./runtime/require-event-runtime-config-in-server) | Pass event to useRuntimeConfig in server handlers | `nuxt-doctor/nitro` | `warn`   | `runtime-config` | suggestion |
| [`nuxt/server/no-client-composables`](./server/no-client-composables)                                     | Do not use app composables in Nitro server files  | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |
| [`nuxt/server/no-browser-api`](./server/no-browser-api)                                                   | Do not use browser APIs in Nitro server files     | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |

## JSON export

The docs build also writes static JSON files:

- `/rules/vue.json`
- `/rules/nitro.json`
- `/rules/nuxt.json`
- `/rules/all.json`

Run:

```bash
vp exec nuxt-doctor rules --format json
```
