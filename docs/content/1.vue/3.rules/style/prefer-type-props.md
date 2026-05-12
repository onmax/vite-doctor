---
title: "Prefer TypeScript props declarations"
description: "Use type-only defineProps declarations in TypeScript <script setup> components."
ruleId: "vue/style/prefer-type-props"
pack: "vue-doctor/vue"
severity: "warn"
category: "style"
fix: "suggestion"
---

`vue/style/prefer-type-props`

Use type-only defineProps declarations in TypeScript `<script setup>` components.

## ::rule-badges

pack: "vue-doctor/vue"
category: "style"
severity: "warn"
fix: "suggestion"

---

::

## Examples

### Declare props with TypeScript

Reported pattern:

```vue
<script setup lang="ts">
const props = defineProps({
  title: String,
  count: Number,
});
</script>
```

Possible fix:

```vue
<script setup lang="ts">
interface Props {
  title: string;
  count?: number;
}

const props = defineProps<Props>();
</script>
```

## Why

Runtime prop declarations duplicate information TypeScript can already express, and they make prop contracts harder to reuse across components, composables, and tests.

## Prefer

Use `defineProps<Props>()` or `defineProps<{ foo: string }>()` instead of runtime props objects when the component already uses TypeScript.

## Metadata

## ::rule-metadata

pack: "vue-doctor/vue"
category: "style"
severity: "warn"
fix: "suggestion"
source: "packages/core/src/rules/vue/prefer-type-props.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/core/src/rules/vue/prefer-type-props.ts"
docsUrl: ""

---

::
