---
title: "Rule reference"
description: "Nitro request-runtime diagnostics in the Nuxt Doctor rule pack."
---

# Rules

Nitro rules cover server and request-runtime boundaries, event-aware helpers, validation, HTTP method assertions, and request metadata.

Nuxt Doctor consumes this independent Nitro rule pack for `server/` and `app/server/` diagnostics.

These pages are generated from rule metadata in `packages/nuxt/src/rules/nitro`.

The same metadata is exported as JSON under `/rules/` in the docs site.

## Rules

| Rule                                                                                                                  | Title                                                   | Pack                | Severity | Category         | Fix        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------- | -------- | ---------------- | ---------- |
| [`nitro/server/no-browser-api`](/nitro/rules/server/no-browser-api)                                                   | Do not use browser APIs in Nitro server files           | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |
| [`nitro/server/no-client-composables`](/nitro/rules/server/no-client-composables)                                     | Do not use app composables in Nitro server files        | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |
| [`nitro/context/no-navigateto-in-nitro`](/nitro/rules/context/no-navigateto-in-nitro)                                 | Do not use navigateTo in Nitro routes                   | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |
| [`nitro/context/no-usenuxtapp-in-nitro`](/nitro/rules/context/no-usenuxtapp-in-nitro)                                 | Do not use useNuxtApp in Nitro routes                   | `nuxt-doctor/nitro` | `error`  | `server`         | suggestion |
| [`nitro/request/prefer-assert-method`](/nitro/rules/request/prefer-assert-method)                                     | Use assertMethod for single-method handlers             | `nuxt-doctor/nitro` | `info`   | `request`        | suggestion |
| [`nitro/server/prefer-event-fetch`](/nitro/rules/server/prefer-event-fetch)                                           | Use event.$fetch in Nitro handlers                      | `nuxt-doctor/nitro` | `warn`   | `server`         | suggestion |
| [`nitro/request/prefer-get-request-ip`](/nitro/rules/request/prefer-get-request-ip)                                   | Use request IP utilities instead of raw IP headers      | `nuxt-doctor/nitro` | `warn`   | `request`        | suggestion |
| [`nitro/request/prefer-validated-body`](/nitro/rules/request/prefer-validated-body)                                   | Use readValidatedBody for validated request bodies      | `nuxt-doctor/nitro` | `warn`   | `request`        | suggestion |
| [`nitro/request/prefer-validated-query`](/nitro/rules/request/prefer-validated-query)                                 | Use getValidatedQuery for validated query strings       | `nuxt-doctor/nitro` | `warn`   | `request`        | suggestion |
| [`nitro/request/prefer-validated-router-params`](/nitro/rules/request/prefer-validated-router-params)                 | Use getValidatedRouterParams for validated route params | `nuxt-doctor/nitro` | `warn`   | `request`        | suggestion |
| [`nitro/runtime/require-event-runtime-config-in-server`](/nitro/rules/runtime/require-event-runtime-config-in-server) | Pass event to useRuntimeConfig in server handlers       | `nuxt-doctor/nitro` | `warn`   | `runtime-config` | suggestion |

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
