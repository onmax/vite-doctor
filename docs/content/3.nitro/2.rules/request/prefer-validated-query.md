---
title: "Use getValidatedQuery for validated query strings"
description: "When a Nitro handler validates query input, read and validate it through the H3 utility."
ruleId: "nitro/request/prefer-validated-query"
pack: "nuxt-doctor/nitro"
severity: "warn"
category: "request"
fix: "suggestion"
---

`nitro/request/prefer-validated-query`

When a Nitro handler validates query input, read and validate it through the H3 utility.

## ::rule-badges

pack: "nuxt-doctor/nitro"
category: "request"
severity: "warn"
fix: "suggestion"

---

::

## Examples

### Keep reading and validation together

Reported pattern:

```ts
export default defineEventHandler(async (event) => {
  const input = await getQuery(event);
  const value = validator.parse(input);

  return value;
});
```

Possible fix:

```ts
export default defineEventHandler(async (event) => {
  const value = await getValidatedQuery(event, validator);

  return value;
});
```

## Why

Raw request input and validation can drift apart when they are separate operations. Nitro and h3 provide validated helpers that keep parsing and validation coupled at the request boundary.

## Prefer

Use `getValidatedQuery(event, validator)` instead of `getQuery(event)` followed by separate validation.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "request"
severity: "warn"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/prefer-validated-query.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/prefer-validated-query.ts"
docsUrl: ""

---

::
