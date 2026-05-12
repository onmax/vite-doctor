---
title: "Do not use browser APIs in Nitro server files"
description: "Browser globals are unavailable in Nitro server runtime."
ruleId: "nitro/server/no-browser-api"
pack: "nuxt-doctor/nitro"
severity: "error"
category: "server"
fix: "suggestion"
---

`nitro/server/no-browser-api`

Browser globals are unavailable in Nitro server runtime.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"

---

::

## Why

Nitro code can run in Node, edge, or worker runtimes where browser APIs such as window, document, and localStorage do not exist.

## Prefer

Use request/event data, server utilities, or move browser work to app client code.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "server"
severity: "error"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/no-browser-api-in-server.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/no-browser-api-in-server.ts"
docsUrl: ""

---

::
