---
title: "Do not use navigateTo in Nitro routes"
description: "Nitro handlers should redirect with server response utilities instead of Nuxt app navigation."
ruleId: "nitro/context/no-navigateto-in-nitro"
pack: "nuxt-doctor/nitro"
severity: "error"
category: "server"
fix: "suggestion"
---

`nitro/context/no-navigateto-in-nitro`

Nitro handlers should redirect with server response utilities instead of Nuxt app navigation.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"

---

::

## Why

`navigateTo()` is a Nuxt app navigation helper. Nitro handlers need to write an HTTP redirect response for the current request event.

## Prefer

Use `sendRedirect(event, path)` in Nitro handlers.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/no-navigate-to-in-nitro.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/no-navigate-to-in-nitro.ts"
docsUrl: ""

---

::
