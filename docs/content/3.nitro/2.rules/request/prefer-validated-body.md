---
title: "Use readValidatedBody for validated request bodies"
description: "When a Nitro handler validates a request body, read and validate it through the H3 utility."
ruleId: "nitro/request/prefer-validated-body"
pack: "nuxt-doctor/nitro"
severity: "warn"
category: "request"
fix: "suggestion"
---

`nitro/request/prefer-validated-body`

When a Nitro handler validates a request body, read and validate it through the H3 utility.

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
  const input = await readBody(event);
  const value = validator.parse(input);

  return value;
});
```

Possible fix:

```ts
export default defineEventHandler(async (event) => {
  const value = await readValidatedBody(event, validator);

  return value;
});
```

## Why

Raw request input and validation can drift apart when they are separate operations. Nitro and h3 provide validated helpers that keep parsing and validation coupled at the request boundary.

## Prefer

Use `readValidatedBody(event, validator)` instead of `readBody(event)` followed by separate validation.

## Metadata

## ::rule-metadata

pack: "nuxt-doctor/nitro"
category: "request"
severity: "warn"
fix: "suggestion"
source: "packages/nuxt/src/rules/nitro/prefer-validated-body.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/nuxt/src/rules/nitro/prefer-validated-body.ts"
docsUrl: ""

---

::
