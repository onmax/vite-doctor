---
title: "Use assertMethod for single-method handlers"
description: "Single-method Nitro handlers should use the H3 method assertion helper instead of ad hoc method checks."
ruleId: "nitro/request/prefer-assert-method"
pack: "nuxt-doctor/nitro"
severity: "info"
category: "request"
fix: "suggestion"
---

`nitro/request/prefer-assert-method`

Single-method Nitro handlers should use the H3 method assertion helper instead of ad hoc method checks.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "request"
severity: "info"
fix: "suggestion"

---

::

## Prefer

Use `assertMethod(event, "POST")` for handlers that accept one HTTP method.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "request"
severity: "info"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/prefer-assert-method.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/prefer-assert-method.ts"
docsUrl: ""

---

::
