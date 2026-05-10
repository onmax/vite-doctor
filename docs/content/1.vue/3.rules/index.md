---
title: "Rules"
description: "Vue 3.5 diagnostics in the core rule pack."
---

Vue rules cover reactivity, computed values, watchers, lifecycle cleanup, template correctness, SSR safety, and template security.

These pages are generated from rule metadata in `packages/core/src/rules/vue.ts`.

The same metadata is exported as JSON under `/rules/` in the docs site.

## Rules

| Rule                                                                                               | Title                                              | Pack             | Severity | Category     | Fix        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------- | -------- | ------------ | ---------- |
| [`vue/reactivity/no-prop-mutation`](./reactivity/no-prop-mutation)                                 | Do not mutate props                                | `vue-doctor/vue` | `error`  | `reactivity` | suggestion |
| [`vue/reactivity/defineprops-watch-getter`](./reactivity/defineprops-watch-getter)                 | Watch destructured props with a getter             | `vue-doctor/vue` | `error`  | `reactivity` | safe       |
| [`vue/reactivity/no-ref-as-operand`](./reactivity/no-ref-as-operand)                               | Use .value when refs are operands                  | `vue-doctor/vue` | `error`  | `reactivity` | suggestion |
| [`vue/computed/no-side-effects`](./computed/no-side-effects)                                       | Computed getters should be pure                    | `vue-doctor/vue` | `error`  | `computed`   | suggestion |
| [`vue/computed/no-async`](./computed/no-async)                                                     | Do not use async computed getters                  | `vue-doctor/vue` | `error`  | `computed`   | suggestion |
| [`vue/watch/no-after-await`](./watch/no-after-await)                                               | Register watchers and lifecycle hooks before await | `vue-doctor/vue` | `error`  | `watchers`   | suggestion |
| [`vue/watch/no-onwatchercleanup-after-await`](./watch/no-onwatchercleanup-after-await)             | Call onWatcherCleanup synchronously                | `vue-doctor/vue` | `error`  | `watchers`   | suggestion |
| [`vue/template/require-v-for-key`](./template/require-v-for-key)                                   | Require stable keys on v-for                       | `vue-doctor/vue` | `error`  | `template`   | suggestion |
| [`vue/template/no-v-if-with-v-for`](./template/no-v-if-with-v-for)                                 | Do not combine v-if and v-for on the same element  | `vue-doctor/vue` | `error`  | `template`   | suggestion |
| [`vue/template/prefer-use-template-ref`](./template/prefer-use-template-ref)                       | Prefer useTemplateRef for template refs            | `vue-doctor/vue` | `info`   | `template`   | suggestion |
| [`vue/ssr/no-browser-api-in-setup`](./ssr/no-browser-api-in-setup)                                 | Do not read browser APIs in SSR setup paths        | `vue-doctor/vue` | `error`  | `ssr`        | suggestion |
| [`vue/security/restrict-v-html`](./security/restrict-v-html)                                       | Restrict v-html to trusted HTML                    | `vue-doctor/vue` | `error`  | `security`   | suggestion |
| [`vue/reactivity/no-setup-props-destructure`](./reactivity/no-setup-props-destructure)             | Do not destructure setup props                     | `vue-doctor/vue` | `error`  | `reactivity` | suggestion |
| [`vue/watch/no-async-watcheffect-after-await-read`](./watch/no-async-watcheffect-after-await-read) | Do not read watchEffect dependencies after await   | `vue-doctor/vue` | `warn`   | `watchers`   | suggestion |
| [`vue/watch/require-side-effect-cleanup`](./watch/require-side-effect-cleanup)                     | Clean up watcher side effects                      | `vue-doctor/vue` | `warn`   | `watchers`   | suggestion |
| [`vue/watch/require-post-flush-for-dom-read`](./watch/require-post-flush-for-dom-read)             | Use post-flush watchers for DOM reads              | `vue-doctor/vue` | `warn`   | `watchers`   | suggestion |
| [`vue/lifecycle/no-mutation-in-onupdated`](./lifecycle/no-mutation-in-onupdated)                   | Do not mutate state in onUpdated                   | `vue-doctor/vue` | `error`  | `lifecycle`  | suggestion |
| [`vue/lifecycle/require-cleanup`](./lifecycle/require-cleanup)                                     | Clean up lifecycle resources                       | `vue-doctor/vue` | `warn`   | `lifecycle`  | suggestion |
| [`vue/ssr/use-id-for-stable-ids`](./ssr/use-id-for-stable-ids)                                     | Use useId for SSR-stable ids                       | `vue-doctor/vue` | `warn`   | `ssr`        | suggestion |
| [`vue/ssr/no-random-or-local-time-render`](./ssr/no-random-or-local-time-render)                   | Avoid random or local-time SSR render values       | `vue-doctor/vue` | `warn`   | `ssr`        | suggestion |
| [`vue/ssr/data-allow-mismatch-surgical`](./ssr/data-allow-mismatch-surgical)                       | Use data-allow-mismatch only surgically            | `vue-doctor/vue` | `warn`   | `ssr`        | suggestion |

## JSON export

The docs build also writes static JSON files:

- `/rules/vue.json`
- `/rules/nuxt.json`
- `/rules/all.json`

Run:

```bash
vp exec vue-doctor rules --format json
```
