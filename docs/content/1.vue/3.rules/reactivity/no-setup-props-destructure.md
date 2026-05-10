---
title: "Do not destructure setup props"
description: "Classic setup(props) props lose reactivity when destructured directly."
---

# Do not destructure setup props

`vue/reactivity/no-setup-props-destructure`

Classic setup(props) props lose reactivity when destructured directly.

## Why

The props proxy is reactive, but local destructured bindings are snapshots.

## Prefer

Use props.foo, toRefs(props), or <script setup> reactive props destructuring.

## Metadata

- Pack: `vue-doctor/vue`
- Severity: `error`
- Category: `reactivity`
- Fix: `suggestion`
- Source: `packages/core/src/rules/vue/no-setup-props-destructure.ts`
