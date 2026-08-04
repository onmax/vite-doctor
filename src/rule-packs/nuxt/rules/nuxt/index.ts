export { noExplicitAutoImport } from "./no-explicit-auto-import.js";
export { noConflictingUseFetchImport } from "./no-conflicting-use-fetch-import.js";
export { noAutoImportCollision } from "./no-auto-import-collision.js";
export { noRawFetchInSetup } from "./no-raw-fetch-in-setup.js";
export { asyncDataNoMutationMethods } from "./async-data-no-mutation-methods.js";
export { noManualActionUseFetch } from "./no-manual-action-usefetch.js";
export { asyncDataHandlerPure } from "./async-data-handler-pure.js";
export { previewModeGlobalRefresh } from "./preview-mode-global-refresh.js";
export { noGlobalRefreshWithoutJustification } from "./no-global-refresh-without-justification.js";
export { asyncDataExplicitKeyForRefreshable } from "./async-data-explicit-key-for-refreshable.js";
export { postFetchRequiresReadonlyMarker } from "./post-fetch-requires-readonly-marker.js";
export { noMutationToastInUseFetchCallback } from "./no-mutation-toast-in-usefetch-callback.js";
export { noAwaitInsideCustomWrapper } from "./no-await-inside-custom-wrapper.js";
export { preferNuxtUseRoute } from "./prefer-nuxt-use-route.js";
export { noUseRouteInMiddleware } from "./no-use-route-in-middleware.js";
export { returnNavigateToInMiddleware } from "./return-navigate-to-in-middleware.js";
export { noRouterNavigationInSetup } from "./no-router-navigation-in-setup.js";
export { noSecretInPublicConfig } from "./no-secret-in-public-config.js";
export { noBrowserSideEffectsInSetup } from "./no-browser-side-effects-in-setup.js";
export { noBrowserGlobalInUniversalCode } from "./no-browser-global-in-universal-code.js";
export { noClientConditionalInTemplate } from "./no-client-conditional-in-template.js";
export { preferUseCookieForInitialClientState } from "./prefer-use-cookie-for-initial-client-state.js";
export { noTimeDependentRenderWithoutNuxtTimeOrClientOnly } from "./no-time-dependent-render-without-nuxt-time-or-client-only.js";
export { noRouteMiddlewareApiSecurity } from "./no-route-middleware-api-security.js";
export { preferNuxtPageOverRouterView } from "./prefer-nuxt-page-over-router-view.js";
export { preferNuxtLink } from "./prefer-nuxt-link.js";
export { noRouteObjectPageKey } from "./no-route-object-page-key.js";
export { noHashSensitiveRouteFullpathInSsrMarkup } from "./no-hash-sensitive-route-fullpath-in-ssr-markup.js";
export { noLegacyProcessClientServer } from "./no-legacy-process-client-server.js";
export { noIgnoredCompatibilityConfig } from "./no-ignored-compatibility-config.js";
export { preferAppDirectoryPlacement } from "./prefer-app-directory-placement.js";
export { noNestedAutoimportAssumption } from "./no-nested-autoimport-assumption.js";
export { noVueOrNitroContextInShared } from "./no-vue-or-nitro-context-in-shared.js";
export { noNestedSharedAutoimportAssumption } from "./no-nested-shared-autoimport-assumption.js";
export { noSubdirPluginAutoRegistrationAssumption } from "./no-subdir-plugin-auto-registration-assumption.js";
export { noNonSerializableUseState } from "./no-non-serializable-use-state.js";
export { requireStableAsyncDataKey } from "./require-stable-async-data-key.js";
export { preferExplicitUseStateKeyInExportedComposables } from "./prefer-explicit-use-state-key-in-exported-composables.js";
export { noComposableAfterAwait } from "./no-composable-after-await.js";
export { forwardAuthHeadersSsr } from "./forward-auth-headers-ssr.js";
export { noPlainEnvInAppCode } from "./no-plain-env-in-app-code.js";
export { preferCreateUseFetch } from "./prefer-create-use-fetch.js";
export { createUseFetchMustBeExportedInScannedDir } from "./create-use-fetch-must-be-exported-in-scanned-dir.js";
export { keyedComposableRegistrationRequired } from "./keyed-composable-registration-required.js";
export { preferSeoComposables } from "./prefer-seo-composables.js";
export { noUnsafeUseHeadScript } from "./no-unsafe-use-head-script.js";
export { preferUseHeadSafeForUntrustedValues } from "./prefer-use-head-safe-for-untrusted-values.js";

import { noExplicitAutoImport } from "./no-explicit-auto-import.js";
import { noConflictingUseFetchImport } from "./no-conflicting-use-fetch-import.js";
import { noAutoImportCollision } from "./no-auto-import-collision.js";
import { noRawFetchInSetup } from "./no-raw-fetch-in-setup.js";
import { asyncDataNoMutationMethods } from "./async-data-no-mutation-methods.js";
import { noManualActionUseFetch } from "./no-manual-action-usefetch.js";
import { asyncDataHandlerPure } from "./async-data-handler-pure.js";
import { previewModeGlobalRefresh } from "./preview-mode-global-refresh.js";
import { noGlobalRefreshWithoutJustification } from "./no-global-refresh-without-justification.js";
import { asyncDataExplicitKeyForRefreshable } from "./async-data-explicit-key-for-refreshable.js";
import { postFetchRequiresReadonlyMarker } from "./post-fetch-requires-readonly-marker.js";
import { noMutationToastInUseFetchCallback } from "./no-mutation-toast-in-usefetch-callback.js";
import { noAwaitInsideCustomWrapper } from "./no-await-inside-custom-wrapper.js";
import { preferNuxtUseRoute } from "./prefer-nuxt-use-route.js";
import { noUseRouteInMiddleware } from "./no-use-route-in-middleware.js";
import { returnNavigateToInMiddleware } from "./return-navigate-to-in-middleware.js";
import { noRouterNavigationInSetup } from "./no-router-navigation-in-setup.js";
import { noSecretInPublicConfig } from "./no-secret-in-public-config.js";
import { noBrowserSideEffectsInSetup } from "./no-browser-side-effects-in-setup.js";
import { noBrowserGlobalInUniversalCode } from "./no-browser-global-in-universal-code.js";
import { noClientConditionalInTemplate } from "./no-client-conditional-in-template.js";
import { preferUseCookieForInitialClientState } from "./prefer-use-cookie-for-initial-client-state.js";
import { noTimeDependentRenderWithoutNuxtTimeOrClientOnly } from "./no-time-dependent-render-without-nuxt-time-or-client-only.js";
import { noRouteMiddlewareApiSecurity } from "./no-route-middleware-api-security.js";
import { preferNuxtPageOverRouterView } from "./prefer-nuxt-page-over-router-view.js";
import { preferNuxtLink } from "./prefer-nuxt-link.js";
import { noRouteObjectPageKey } from "./no-route-object-page-key.js";
import { noHashSensitiveRouteFullpathInSsrMarkup } from "./no-hash-sensitive-route-fullpath-in-ssr-markup.js";
import { noLegacyProcessClientServer } from "./no-legacy-process-client-server.js";
import { noIgnoredCompatibilityConfig } from "./no-ignored-compatibility-config.js";
import { preferAppDirectoryPlacement } from "./prefer-app-directory-placement.js";
import { noNestedAutoimportAssumption } from "./no-nested-autoimport-assumption.js";
import { noVueOrNitroContextInShared } from "./no-vue-or-nitro-context-in-shared.js";
import { noNestedSharedAutoimportAssumption } from "./no-nested-shared-autoimport-assumption.js";
import { noSubdirPluginAutoRegistrationAssumption } from "./no-subdir-plugin-auto-registration-assumption.js";
import { noNonSerializableUseState } from "./no-non-serializable-use-state.js";
import { requireStableAsyncDataKey } from "./require-stable-async-data-key.js";
import { preferExplicitUseStateKeyInExportedComposables } from "./prefer-explicit-use-state-key-in-exported-composables.js";
import { noComposableAfterAwait } from "./no-composable-after-await.js";
import { forwardAuthHeadersSsr } from "./forward-auth-headers-ssr.js";
import { noPlainEnvInAppCode } from "./no-plain-env-in-app-code.js";
import { preferCreateUseFetch } from "./prefer-create-use-fetch.js";
import { createUseFetchMustBeExportedInScannedDir } from "./create-use-fetch-must-be-exported-in-scanned-dir.js";
import { keyedComposableRegistrationRequired } from "./keyed-composable-registration-required.js";
import { preferSeoComposables } from "./prefer-seo-composables.js";
import { noUnsafeUseHeadScript } from "./no-unsafe-use-head-script.js";
import { preferUseHeadSafeForUntrustedValues } from "./prefer-use-head-safe-for-untrusted-values.js";
import { defineRulePack } from "../../../../core/index.js";

const rules = [
  noExplicitAutoImport,
  noConflictingUseFetchImport,
  noAutoImportCollision,
  noRawFetchInSetup,
  asyncDataNoMutationMethods,
  noManualActionUseFetch,
  asyncDataHandlerPure,
  previewModeGlobalRefresh,
  noGlobalRefreshWithoutJustification,
  asyncDataExplicitKeyForRefreshable,
  postFetchRequiresReadonlyMarker,
  noMutationToastInUseFetchCallback,
  noAwaitInsideCustomWrapper,
  preferNuxtUseRoute,
  noUseRouteInMiddleware,
  returnNavigateToInMiddleware,
  noRouterNavigationInSetup,
  noSecretInPublicConfig,
  noBrowserSideEffectsInSetup,
  noBrowserGlobalInUniversalCode,
  noClientConditionalInTemplate,
  preferUseCookieForInitialClientState,
  noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
  noRouteMiddlewareApiSecurity,
  preferNuxtPageOverRouterView,
  preferNuxtLink,
  noRouteObjectPageKey,
  noHashSensitiveRouteFullpathInSsrMarkup,
  noLegacyProcessClientServer,
  noIgnoredCompatibilityConfig,
  preferAppDirectoryPlacement,
  noNestedAutoimportAssumption,
  noVueOrNitroContextInShared,
  noNestedSharedAutoimportAssumption,
  noSubdirPluginAutoRegistrationAssumption,
  noNonSerializableUseState,
  requireStableAsyncDataKey,
  preferExplicitUseStateKeyInExportedComposables,
  noComposableAfterAwait,
  forwardAuthHeadersSsr,
  noPlainEnvInAppCode,
  preferCreateUseFetch,
  createUseFetchMustBeExportedInScannedDir,
  keyedComposableRegistrationRequired,
  preferSeoComposables,
  noUnsafeUseHeadScript,
  preferUseHeadSafeForUntrustedValues,
];

const nuxtRulePack = defineRulePack({
  name: "vite-doctor/nuxt",
  version: "0.0.0",
  rules,
  presets: {
    recommended: rules.map((rule) => rule.meta.id),
    strict: rules.map((rule) => rule.meta.id),
  },
});

export default nuxtRulePack;
