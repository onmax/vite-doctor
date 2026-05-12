---
title: "Use request IP utilities instead of raw IP headers"
description: "Request-sensitive Nitro code should not trust client-controlled forwarding headers directly."
ruleId: "nitro/request/prefer-get-request-ip"
pack: "nuxt-doctor/nitro"
severity: "warn"
category: "request"
fix: "suggestion"
---

`nitro/request/prefer-get-request-ip`

Request-sensitive Nitro code should not trust client-controlled forwarding headers directly.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "request"
severity: "warn"
fix: "suggestion"

---

::

## Prefer

Use the H3/Nitro request IP utility and centralize trusted proxy handling instead of reading IP headers directly.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "request"
severity: "warn"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/prefer-get-request-ip.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/prefer-get-request-ip.ts"
docsUrl: ""

---

::
