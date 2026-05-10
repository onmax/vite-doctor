---
title: "Rules"
description: "Vue 3.5 diagnostics in the core rule pack."
---

Vue rules cover reactivity, computed values, watchers, lifecycle cleanup, template correctness, SSR safety, and template security.

These pages are generated from rule metadata in `packages/core/src/rules/vue.ts`.

The same metadata is exported as JSON under `/rules/` in the docs site.

## Rule metadata

| Rule                                              | Title                                              | Severity | Category     | Fix        | Description                                                            | Why                                                                         | Prefer / replacement                                                                |
| ------------------------------------------------- | -------------------------------------------------- | -------- | ------------ | ---------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `vue/reactivity/no-prop-mutation`                 | Do not mutate props                                | `error`  | `reactivity` | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/reactivity/defineprops-watch-getter`         | Watch destructured props with a getter             | `error`  | `reactivity` | safe       |                                                                        |                                                                             |                                                                                     |
| `vue/reactivity/no-ref-as-operand`                | Use .value when refs are operands                  | `error`  | `reactivity` | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/computed/no-side-effects`                    | Computed getters should be pure                    | `error`  | `computed`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/computed/no-async`                           | Do not use async computed getters                  | `error`  | `computed`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/watch/no-after-await`                        | Register watchers and lifecycle hooks before await | `error`  | `watchers`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/watch/no-onwatchercleanup-after-await`       | Call onWatcherCleanup synchronously                | `error`  | `watchers`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/template/require-v-for-key`                  | Require stable keys on v-for                       | `error`  | `template`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/template/no-v-if-with-v-for`                 | Do not combine v-if and v-for on the same element  | `error`  | `template`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/template/prefer-use-template-ref`            | Prefer useTemplateRef for template refs            | `info`   | `template`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/ssr/no-browser-api-in-setup`                 | Do not read browser APIs in SSR setup paths        | `error`  | `ssr`        | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/security/restrict-v-html`                    | Restrict v-html to trusted HTML                    | `error`  | `security`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/reactivity/no-setup-props-destructure`       | Do not destructure setup props                     | `error`  | `reactivity` | suggestion | Classic setup(props) props lose reactivity when destructured directly. | The props proxy is reactive, but local destructured bindings are snapshots. | Use props.foo, toRefs(props), or &lt;script setup&gt; reactive props destructuring. |
| `vue/watch/no-async-watcheffect-after-await-read` | Do not read watchEffect dependencies after await   | `warn`   | `watchers`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/watch/require-side-effect-cleanup`           | Clean up watcher side effects                      | `warn`   | `watchers`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/watch/require-post-flush-for-dom-read`       | Use post-flush watchers for DOM reads              | `warn`   | `watchers`   | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/lifecycle/no-mutation-in-onupdated`          | Do not mutate state in onUpdated                   | `error`  | `lifecycle`  | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/lifecycle/require-cleanup`                   | Clean up lifecycle resources                       | `warn`   | `lifecycle`  | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/ssr/use-id-for-stable-ids`                   | Use useId for SSR-stable ids                       | `warn`   | `ssr`        | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/ssr/no-random-or-local-time-render`          | Avoid random or local-time SSR render values       | `warn`   | `ssr`        | suggestion |                                                                        |                                                                             |                                                                                     |
| `vue/ssr/data-allow-mismatch-surgical`            | Use data-allow-mismatch only surgically            | `warn`   | `ssr`        | suggestion |                                                                        |                                                                             |                                                                                     |

## Rule packs

### vue-doctor/vue

- [`vue/reactivity/no-prop-mutation`](./reactivity/no-prop-mutation) — Do not mutate props
- [`vue/reactivity/defineprops-watch-getter`](./reactivity/defineprops-watch-getter) — Watch destructured props with a getter
- [`vue/reactivity/no-ref-as-operand`](./reactivity/no-ref-as-operand) — Use .value when refs are operands
- [`vue/computed/no-side-effects`](./computed/no-side-effects) — Computed getters should be pure
- [`vue/computed/no-async`](./computed/no-async) — Do not use async computed getters
- [`vue/watch/no-after-await`](./watch/no-after-await) — Register watchers and lifecycle hooks before await
- [`vue/watch/no-onwatchercleanup-after-await`](./watch/no-onwatchercleanup-after-await) — Call onWatcherCleanup synchronously
- [`vue/template/require-v-for-key`](./template/require-v-for-key) — Require stable keys on v-for
- [`vue/template/no-v-if-with-v-for`](./template/no-v-if-with-v-for) — Do not combine v-if and v-for on the same element
- [`vue/template/prefer-use-template-ref`](./template/prefer-use-template-ref) — Prefer useTemplateRef for template refs
- [`vue/ssr/no-browser-api-in-setup`](./ssr/no-browser-api-in-setup) — Do not read browser APIs in SSR setup paths
- [`vue/security/restrict-v-html`](./security/restrict-v-html) — Restrict v-html to trusted HTML
- [`vue/reactivity/no-setup-props-destructure`](./reactivity/no-setup-props-destructure) — Do not destructure setup props
- [`vue/watch/no-async-watcheffect-after-await-read`](./watch/no-async-watcheffect-after-await-read) — Do not read watchEffect dependencies after await
- [`vue/watch/require-side-effect-cleanup`](./watch/require-side-effect-cleanup) — Clean up watcher side effects
- [`vue/watch/require-post-flush-for-dom-read`](./watch/require-post-flush-for-dom-read) — Use post-flush watchers for DOM reads
- [`vue/lifecycle/no-mutation-in-onupdated`](./lifecycle/no-mutation-in-onupdated) — Do not mutate state in onUpdated
- [`vue/lifecycle/require-cleanup`](./lifecycle/require-cleanup) — Clean up lifecycle resources
- [`vue/ssr/use-id-for-stable-ids`](./ssr/use-id-for-stable-ids) — Use useId for SSR-stable ids
- [`vue/ssr/no-random-or-local-time-render`](./ssr/no-random-or-local-time-render) — Avoid random or local-time SSR render values
- [`vue/ssr/data-allow-mismatch-surgical`](./ssr/data-allow-mismatch-surgical) — Use data-allow-mismatch only surgically

## JSON export

The docs build also writes static JSON files:

- `/rules/vue.json`
- `/rules/nuxt.json`
- `/rules/all.json`

Run:

```bash
vp exec vue-doctor rules --format json
```
