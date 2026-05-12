---
title: "Pass event to useRuntimeConfig in server handlers"
description: "Read runtime config with the Nitro event inside server handlers."
ruleId: "nitro/runtime/require-event-runtime-config-in-server"
pack: "nuxt-doctor/nitro"
severity: "warn"
category: "runtime-config"
fix: "suggestion"
---

`nitro/runtime/require-event-runtime-config-in-server`

Read runtime config with the Nitro event inside server handlers.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "runtime-config"
severity: "warn"
fix: "suggestion"

---

::

## Why

Passing the event lets Nitro resolve request-aware runtime config consistently in server code.

## Prefer

Use `useRuntimeConfig(event)`.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "runtime-config"
severity: "warn"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/require-event-runtime-config-in-server.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/require-event-runtime-config-in-server.ts"
docsUrl: ""

---

::
