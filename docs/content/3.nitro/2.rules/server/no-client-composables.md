---
title: "Do not use app composables in Nitro server files"
description: "Nuxt app composables are not available from Nitro server files."
ruleId: "nitro/server/no-client-composables"
pack: "nuxt-doctor/nitro"
severity: "error"
category: "server"
fix: "suggestion"
---

`nitro/server/no-client-composables`

Nuxt app composables are not available from Nitro server files.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"

---

::

## Why

Server handlers run with Nitro request context, not Vue setup context. App composables like `useRoute()`, `useFetch()`, and `useHead()` depend on the Nuxt app runtime.

## Prefer

Use event-aware Nitro utilities in server handlers.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/no-client-composables-in-server.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/no-client-composables-in-server.ts"
docsUrl: ""

---

::
