---
title: "Use event.$fetch in Nitro handlers"
description: "Proxy internal API calls through event.$fetch() when request context matters."
ruleId: "nitro/server/prefer-event-fetch"
pack: "nuxt-doctor/nitro"
severity: "warn"
category: "server"
fix: "suggestion"
---

`nitro/server/prefer-event-fetch`

Proxy internal API calls through event.$`fetch()` when request context matters.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "server"
severity: "warn"
fix: "suggestion"

---

::

## Why

$`fetch()` does not automatically carry request-scoped context such as headers, cookies, or event context. event.$`fetch()` preserves the current Nitro request context for internal server calls.

## Prefer

Use event.$`fetch()` when proxying to other server routes from a Nitro handler.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "server"
severity: "warn"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/prefer-event-fetch.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/prefer-event-fetch.ts"
docsUrl: ""

---

::
