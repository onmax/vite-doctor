---
title: "Rules"
description: "Nuxt 4 diagnostics in the Nuxt and ecosystem rule packs."
---

Nuxt rules cover auto-imports, fetching, routing, Nuxt context, Nitro/server boundaries, runtime config, hydration, middleware security, state serialization, content, Docus, and optional module overlays.

These pages are generated from rule metadata in `packages/nuxt/src/rules`.

The same metadata is exported as JSON under `/rules/` in the docs site.

## Rule metadata

| Rule                                                                     | Title                                                       | Severity  | Category         | Fix        | Description | Why | Prefer / replacement |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- | --------- | ---------------- | ---------- | ----------- | --- | -------------------- |
| `nuxt/imports/no-explicit-auto-import`                                   | Avoid explicit imports of Nuxt auto-imports                 | `info`    | `imports`        | safe       |             |     |                      |
| `nuxt/imports/no-conflicting-usefetch-import`                            | Do not shadow Nuxt useFetch                                 | `error`   | `imports`        | safe       |             |     |                      |
| `nuxt/imports/no-auto-import-collision`                                  | Avoid auto-import name collisions                           | `warn`    | `imports`        | suggestion |             |     |                      |
| `nuxt/fetch/no-raw-fetch-in-setup`                                       | Use Nuxt data fetching primitives for SSR render data       | `warn`    | `fetching`       | no         |             |     |                      |
| `nuxt/fetch/no-await-inside-custom-wrapper`                              | Do not await inside custom useFetch/useAsyncData wrappers   | `error`   | `fetching`       | suggestion |             |     |                      |
| `nuxt/routing/prefer-nuxt-useroute`                                      | Use Nuxt's useRoute in Nuxt app code                        | `error`   | `routing`        | safe       |             |     |                      |
| `nuxt/routing/no-useroute-in-middleware`                                 | Use middleware to/from arguments instead of useRoute        | `error`   | `routing`        | suggestion |             |     |                      |
| `nuxt/routing/return-navigateto-in-middleware`                           | Return navigateTo in route middleware                       | `error`   | `routing`        | safe       |             |     |                      |
| `nuxt/routing/no-router-navigation-in-setup`                             | Do not navigate with router.push/replace during setup       | `warn`    | `routing`        | suggestion |             |     |                      |
| `nuxt/context/no-usenuxtapp-in-nitro`                                    | Do not use useNuxtApp in Nitro routes                       | `error`   | `server`         | suggestion |             |     |                      |
| `nuxt/context/no-navigateto-in-nitro`                                    | Do not use navigateTo in Nitro routes                       | `error`   | `server`         | suggestion |             |     |                      |
| `nuxt/runtime/no-secret-in-public-config`                                | Do not expose secrets in runtimeConfig.public               | `error`   | `runtime-config` | suggestion |             |     |                      |
| `nuxt/hydration/no-browser-side-effects-in-setup`                        | Avoid browser side effects in universal setup               | `error`   | `hydration`      | suggestion |             |     |                      |
| `nuxt/hydration/no-browser-global-in-universal-code`                     | Avoid browser globals in universal code                     | `error`   | `hydration`      | suggestion |             |     |                      |
| `nuxt/hydration/no-client-conditional-in-template`                       | Avoid client-only conditionals in SSR templates             | `warn`    | `hydration`      | suggestion |             |     |                      |
| `nuxt/hydration/prefer-usecookie-for-initial-client-state`               | Use useCookie for SSR-visible browser preference state      | `warn`    | `hydration`      | suggestion |             |     |                      |
| `nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly` | Use NuxtTime or ClientOnly for time-dependent rendering     | `warn`    | `hydration`      | suggestion |             |     |                      |
| `nuxt/middleware/no-route-middleware-api-security`                       | Route middleware does not secure API routes                 | `blocker` | `middleware`     | suggestion |             |     |                      |
| `nuxt/routing/prefer-nuxtpage-over-routerview`                           | Use NuxtPage instead of RouterView                          | `error`   | `routing`        | safe       |             |     |                      |
| `nuxt/routing/no-route-object-page-key`                                  | Do not use route objects as NuxtPage page keys              | `warn`    | `routing`        | suggestion |             |     |                      |
| `nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup`            | Avoid route.fullPath in SSR markup                          | `warn`    | `routing`        | suggestion |             |     |                      |
| `nuxt/context/no-legacy-process-client-server`                           | Use import.meta client/server flags                         | `warn`    | `context`        | safe       |             |     |                      |
| `nuxt/project/prefer-app-directory-placement`                            | Place app directories under app/                            | `info`    | `architecture`   | suggestion |             |     |                      |
| `nuxt/composables/no-nested-autoimport-assumption`                       | Nested composables are not auto-imported by default         | `warn`    | `imports`        | suggestion |             |     |                      |
| `nuxt/shared/no-vue-or-nitro-context-in-shared`                          | Keep shared code runtime-neutral                            | `error`   | `architecture`   | suggestion |             |     |                      |
| `nuxt/shared/no-nested-shared-autoimport-assumption`                     | Only shared utils and types are auto-imported               | `warn`    | `imports`        | suggestion |             |     |                      |
| `nuxt/plugins/no-subdir-auto-registration-assumption`                    | Nested plugins are not auto-registered by default           | `warn`    | `plugins`        | suggestion |             |     |                      |
| `nuxt/state/no-nonserializable-usestate`                                 | useState values must be serializable                        | `error`   | `hydration`      | suggestion |             |     |                      |
| `nuxt/fetch/require-stable-asyncdata-key`                                | Use stable keys for async data payload entries              | `warn`    | `fetching`       | suggestion |             |     |                      |
| `nuxt/state/prefer-explicit-usestate-key-in-exported-composables`        | Use explicit useState keys in exported composables          | `warn`    | `hydration`      | suggestion |             |     |                      |
| `nuxt/context/no-composable-after-await`                                 | Call Nuxt composables before await                          | `error`   | `context`        | suggestion |             |     |                      |
| `nuxt/server/prefer-event-fetch`                                         | Use event.$fetch in Nitro handlers                          | `warn`    | `server`         | suggestion |             |     |                      |
| `nuxt/fetch/forward-auth-headers-ssr`                                    | Forward auth headers for SSR server fetches                 | `warn`    | `fetching`       | suggestion |             |     |                      |
| `nuxt/runtime/no-plain-env-in-app-code`                                  | Use runtimeConfig instead of process.env in app code        | `error`   | `runtime-config` | suggestion |             |     |                      |
| `nuxt/runtime/require-event-runtime-config-in-server`                    | Pass event to useRuntimeConfig in server handlers           | `warn`    | `runtime-config` | suggestion |             |     |                      |
| `nuxt/server/no-client-composables`                                      | Do not use app composables in Nitro server files            | `error`   | `server`         | suggestion |             |     |                      |
| `nuxt/server/no-browser-api`                                             | Do not use browser APIs in Nitro server files               | `error`   | `server`         | suggestion |             |     |                      |
| `nuxt/fetch/prefer-create-use-fetch`                                     | Prefer Nuxt data factories for custom data composables      | `info`    | `fetching`       | suggestion |             |     |                      |
| `nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir`             | Export data factories from scanned composable directories   | `error`   | `fetching`       | suggestion |             |     |                      |
| `nuxt/fetch/keyed-composable-registration-required`                      | Register custom keyed data composables                      | `warn`    | `fetching`       | suggestion |             |     |                      |
| `nuxt/seo/prefer-seo-composables`                                        | Use Nuxt SEO composables for metadata                       | `warn`    | `seo`            | suggestion |             |     |                      |
| `nuxt/security/no-unsafe-usehead-script`                                 | Avoid unsafe scripts in useHead                             | `error`   | `security`       | suggestion |             |     |                      |
| `nuxt/security/prefer-useheadsafe-for-untrusted-values`                  | Use useHeadSafe for untrusted head values                   | `warn`    | `security`       | suggestion |             |     |                      |
| `nuxt-content/links/no-broken-internal-to-link`                          | Do not link to missing content routes                       | `warn`    | `content`        | suggestion |             |     |                      |
| `docus/layers/no-empty-app-vue-shadow`                                   | Do not shadow Docus app.vue with an empty app shell         | `error`   | `layers`         | suggestion |             |     |                      |
| `docus/appconfig/no-unknown-key`                                         | Use app.config keys read by Docus                           | `warn`    | `app-config`     | suggestion |             |     |                      |
| `nuxt-better-auth/require-standard-auth-handler-mount`                   | Mount Better Auth at the standard catch-all route           | `warn`    | `auth`           | suggestion |             |     |                      |
| `nuxt-content/no-querycontent-legacy-api`                                | Use queryCollection instead of queryContent                 | `warn`    | `content`        | suggestion |             |     |                      |
| `nuxt-image/prefer-nuxtimg`                                              | Use NuxtImg for app images                                  | `info`    | `images`         | suggestion |             |     |                      |
| `nuxt-image/require-alt`                                                 | Provide alt text for Nuxt images                            | `error`   | `images`         | suggestion |             |     |                      |
| `nuxt-image/prefer-responsive-dimensions`                                | Provide image dimensions or sizes                           | `warn`    | `images`         | suggestion |             |     |                      |
| `nuxt-image/prefer-nuxtpicture-for-formats`                              | Use NuxtPicture for format negotiation                      | `info`    | `images`         | suggestion |             |     |                      |
| `nuxt-scripts/no-raw-third-party-script-tag`                             | Use Nuxt Scripts for third-party scripts                    | `warn`    | `scripts`        | suggestion |             |     |                      |
| `nuxt-scripts/no-third-party-usehead-script`                             | Use Nuxt Scripts instead of useHead for third-party scripts | `warn`    | `scripts`        | suggestion |             |     |                      |
| `nuxt-scripts/no-third-party-config-script`                              | Use Nuxt Scripts instead of raw app.head scripts            | `warn`    | `scripts`        | suggestion |             |     |                      |
| `nuxt-ui/require-uapp-root`                                              | Use UApp when Nuxt UI app services are used                 | `warn`    | `ui`             | suggestion |             |     |                      |
| `nuxthub/no-personalized-cached-handler`                                 | Do not cache personalized handlers without varying          | `error`   | `cache`          | suggestion |             |     |                      |
| `nuxthub/prefer-cached-event-handler`                                    | Cache expensive public server handlers                      | `info`    | `cache`          | suggestion |             |     |                      |
| `vueuse/prefer-usewindow-size`                                           | Use useWindowSize for reactive viewport size                | `info`    | `hydration`      | suggestion |             |     |                      |
| `vueuse/prefer-usebreakpoints`                                           | Use useBreakpoints for responsive state                     | `info`    | `hydration`      | suggestion |             |     |                      |
| `vueuse/prefer-useclipboard`                                             | Use useClipboard for clipboard access                       | `info`    | `browser-api`    | suggestion |             |     |                      |
| `vueuse/no-nuxt-auto-import-collision`                                   | Avoid VueUse names that collide with Nuxt auto-imports      | `warn`    | `imports`        | suggestion |             |     |                      |

## Rule packs

### nuxt-doctor/nuxt

- [`nuxt/imports/no-explicit-auto-import`](./imports/no-explicit-auto-import) — Avoid explicit imports of Nuxt auto-imports
- [`nuxt/imports/no-conflicting-usefetch-import`](./imports/no-conflicting-usefetch-import) — Do not shadow Nuxt useFetch
- [`nuxt/imports/no-auto-import-collision`](./imports/no-auto-import-collision) — Avoid auto-import name collisions
- [`nuxt/fetch/no-raw-fetch-in-setup`](./fetch/no-raw-fetch-in-setup) — Use Nuxt data fetching primitives for SSR render data
- [`nuxt/fetch/no-await-inside-custom-wrapper`](./fetch/no-await-inside-custom-wrapper) — Do not await inside custom useFetch/useAsyncData wrappers
- [`nuxt/routing/prefer-nuxt-useroute`](./routing/prefer-nuxt-useroute) — Use Nuxt's useRoute in Nuxt app code
- [`nuxt/routing/no-useroute-in-middleware`](./routing/no-useroute-in-middleware) — Use middleware to/from arguments instead of useRoute
- [`nuxt/routing/return-navigateto-in-middleware`](./routing/return-navigateto-in-middleware) — Return navigateTo in route middleware
- [`nuxt/routing/no-router-navigation-in-setup`](./routing/no-router-navigation-in-setup) — Do not navigate with router.push/replace during setup
- [`nuxt/context/no-usenuxtapp-in-nitro`](./context/no-usenuxtapp-in-nitro) — Do not use useNuxtApp in Nitro routes
- [`nuxt/context/no-navigateto-in-nitro`](./context/no-navigateto-in-nitro) — Do not use navigateTo in Nitro routes
- [`nuxt/runtime/no-secret-in-public-config`](./runtime/no-secret-in-public-config) — Do not expose secrets in runtimeConfig.public
- [`nuxt/hydration/no-browser-side-effects-in-setup`](./hydration/no-browser-side-effects-in-setup) — Avoid browser side effects in universal setup
- [`nuxt/hydration/no-browser-global-in-universal-code`](./hydration/no-browser-global-in-universal-code) — Avoid browser globals in universal code
- [`nuxt/hydration/no-client-conditional-in-template`](./hydration/no-client-conditional-in-template) — Avoid client-only conditionals in SSR templates
- [`nuxt/hydration/prefer-usecookie-for-initial-client-state`](./hydration/prefer-usecookie-for-initial-client-state) — Use useCookie for SSR-visible browser preference state
- [`nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly`](./hydration/no-time-dependent-render-without-nuxttime-or-clientonly) — Use NuxtTime or ClientOnly for time-dependent rendering
- [`nuxt/middleware/no-route-middleware-api-security`](./middleware/no-route-middleware-api-security) — Route middleware does not secure API routes
- [`nuxt/routing/prefer-nuxtpage-over-routerview`](./routing/prefer-nuxtpage-over-routerview) — Use NuxtPage instead of RouterView
- [`nuxt/routing/no-route-object-page-key`](./routing/no-route-object-page-key) — Do not use route objects as NuxtPage page keys
- [`nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup`](./routing/no-hash-sensitive-route-fullpath-in-ssr-markup) — Avoid route.fullPath in SSR markup
- [`nuxt/context/no-legacy-process-client-server`](./context/no-legacy-process-client-server) — Use import.meta client/server flags
- [`nuxt/project/prefer-app-directory-placement`](./project/prefer-app-directory-placement) — Place app directories under app/
- [`nuxt/composables/no-nested-autoimport-assumption`](./composables/no-nested-autoimport-assumption) — Nested composables are not auto-imported by default
- [`nuxt/shared/no-vue-or-nitro-context-in-shared`](./shared/no-vue-or-nitro-context-in-shared) — Keep shared code runtime-neutral
- [`nuxt/shared/no-nested-shared-autoimport-assumption`](./shared/no-nested-shared-autoimport-assumption) — Only shared utils and types are auto-imported
- [`nuxt/plugins/no-subdir-auto-registration-assumption`](./plugins/no-subdir-auto-registration-assumption) — Nested plugins are not auto-registered by default
- [`nuxt/state/no-nonserializable-usestate`](./state/no-nonserializable-usestate) — useState values must be serializable
- [`nuxt/fetch/require-stable-asyncdata-key`](./fetch/require-stable-asyncdata-key) — Use stable keys for async data payload entries
- [`nuxt/state/prefer-explicit-usestate-key-in-exported-composables`](./state/prefer-explicit-usestate-key-in-exported-composables) — Use explicit useState keys in exported composables
- [`nuxt/context/no-composable-after-await`](./context/no-composable-after-await) — Call Nuxt composables before await
- [`nuxt/server/prefer-event-fetch`](./server/prefer-event-fetch) — Use event.$fetch in Nitro handlers
- [`nuxt/fetch/forward-auth-headers-ssr`](./fetch/forward-auth-headers-ssr) — Forward auth headers for SSR server fetches
- [`nuxt/runtime/no-plain-env-in-app-code`](./runtime/no-plain-env-in-app-code) — Use runtimeConfig instead of process.env in app code
- [`nuxt/runtime/require-event-runtime-config-in-server`](./runtime/require-event-runtime-config-in-server) — Pass event to useRuntimeConfig in server handlers
- [`nuxt/server/no-client-composables`](./server/no-client-composables) — Do not use app composables in Nitro server files
- [`nuxt/server/no-browser-api`](./server/no-browser-api) — Do not use browser APIs in Nitro server files
- [`nuxt/fetch/prefer-create-use-fetch`](./fetch/prefer-create-use-fetch) — Prefer Nuxt data factories for custom data composables
- [`nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir`](./fetch/create-usefetch-must-be-exported-in-scanned-dir) — Export data factories from scanned composable directories
- [`nuxt/fetch/keyed-composable-registration-required`](./fetch/keyed-composable-registration-required) — Register custom keyed data composables
- [`nuxt/seo/prefer-seo-composables`](./seo/prefer-seo-composables) — Use Nuxt SEO composables for metadata
- [`nuxt/security/no-unsafe-usehead-script`](./security/no-unsafe-usehead-script) — Avoid unsafe scripts in useHead
- [`nuxt/security/prefer-useheadsafe-for-untrusted-values`](./security/prefer-useheadsafe-for-untrusted-values) — Use useHeadSafe for untrusted head values

### nuxt-doctor/docus

- [`nuxt-content/links/no-broken-internal-to-link`](./links/no-broken-internal-to-link) — Do not link to missing content routes
- [`docus/layers/no-empty-app-vue-shadow`](./layers/no-empty-app-vue-shadow) — Do not shadow Docus app.vue with an empty app shell
- [`docus/appconfig/no-unknown-key`](./appconfig/no-unknown-key) — Use app.config keys read by Docus

### nuxt-doctor/nuxt-better-auth

- [`nuxt-better-auth/require-standard-auth-handler-mount`](./auth/require-standard-auth-handler-mount) — Mount Better Auth at the standard catch-all route

### nuxt-doctor/nuxt-content

- [`nuxt-content/no-querycontent-legacy-api`](./content/no-querycontent-legacy-api) — Use queryCollection instead of queryContent

### nuxt-doctor/nuxt-image

- [`nuxt-image/prefer-nuxtimg`](./images/prefer-nuxtimg) — Use NuxtImg for app images
- [`nuxt-image/require-alt`](./images/require-alt) — Provide alt text for Nuxt images
- [`nuxt-image/prefer-responsive-dimensions`](./images/prefer-responsive-dimensions) — Provide image dimensions or sizes
- [`nuxt-image/prefer-nuxtpicture-for-formats`](./images/prefer-nuxtpicture-for-formats) — Use NuxtPicture for format negotiation

### nuxt-doctor/nuxt-scripts

- [`nuxt-scripts/no-raw-third-party-script-tag`](./scripts/no-raw-third-party-script-tag) — Use Nuxt Scripts for third-party scripts
- [`nuxt-scripts/no-third-party-usehead-script`](./scripts/no-third-party-usehead-script) — Use Nuxt Scripts instead of useHead for third-party scripts
- [`nuxt-scripts/no-third-party-config-script`](./scripts/no-third-party-config-script) — Use Nuxt Scripts instead of raw app.head scripts

### nuxt-doctor/nuxt-ui

- [`nuxt-ui/require-uapp-root`](./ui/require-uapp-root) — Use UApp when Nuxt UI app services are used

### nuxt-doctor/nuxthub

- [`nuxthub/no-personalized-cached-handler`](./cache/no-personalized-cached-handler) — Do not cache personalized handlers without varying
- [`nuxthub/prefer-cached-event-handler`](./cache/prefer-cached-event-handler) — Cache expensive public server handlers

### nuxt-doctor/vueuse

- [`vueuse/prefer-usewindow-size`](./hydration/prefer-usewindow-size) — Use useWindowSize for reactive viewport size
- [`vueuse/prefer-usebreakpoints`](./hydration/prefer-usebreakpoints) — Use useBreakpoints for responsive state
- [`vueuse/prefer-useclipboard`](./browser-api/prefer-useclipboard) — Use useClipboard for clipboard access
- [`vueuse/no-nuxt-auto-import-collision`](./imports/no-nuxt-auto-import-collision) — Avoid VueUse names that collide with Nuxt auto-imports

## JSON export

The docs build also writes static JSON files:

- `/rules/vue.json`
- `/rules/nuxt.json`
- `/rules/all.json`

Run:

```bash
vp exec nuxt-doctor rules --format json
```
