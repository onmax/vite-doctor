---
title: "Do not destructure setup props"
description: "Classic setup(props) props lose reactivity when destructured directly."
ruleId: "vue/reactivity/no-setup-props-destructure"
pack: "vue-doctor/vue"
severity: "error"
category: "reactivity"
fix: "suggestion"
---

`vue/reactivity/no-setup-props-destructure`

Classic `setup(props)` props lose reactivity when destructured directly.

## ::rule-badges

pack: "vue-doctor/vue"
category: "reactivity"
severity: "error"
fix: "suggestion"

---

::

## Why

The props proxy is reactive, but local destructured bindings are snapshots.

## Prefer

Use props.foo, `toRefs(props)`, or `<script setup>` reactive props destructuring.

## Metadata

## ::rule-metadata

pack: "vue-doctor/vue"
category: "reactivity"
severity: "error"
fix: "suggestion"
source: "packages/core/src/rules/vue/no-setup-props-destructure.ts"
sourceUrl: "https://github.com/onmax/nuxt-doctor/blob/main/packages/core/src/rules/vue/no-setup-props-destructure.ts"
docsUrl: ""

---

::
