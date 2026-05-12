---
title: "Do not use useNuxtApp in Nitro routes"
description: "Nitro handlers run outside the Nuxt app runtime, so useNuxtApp() is unavailable."
ruleId: "nitro/context/no-usenuxtapp-in-nitro"
pack: "nuxt-doctor/nitro"
severity: "error"
category: "server"
fix: "suggestion"
---

`nitro/context/no-usenuxtapp-in-nitro`

Nitro handlers run outside the Nuxt app runtime, so `useNuxtApp()` is unavailable.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"

---

::

## Why

Nitro request handlers execute in the server runtime with an event object, not inside Vue or Nuxt app setup. App composables rely on Nuxt app instance state that does not exist there.

## Prefer

Use event-aware Nitro, h3, or server utilities that receive the request event.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/no-use-nuxt-app-in-nitro.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/no-use-nuxt-app-in-nitro.ts"
docsUrl: ""

---

::
