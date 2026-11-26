import { defineRulePack } from "../../../core/index.js";
import { noUseNuxtAppInNitro } from "./no-use-nuxt-app-in-nitro.js";
import { noNavigateToInNitro } from "./no-navigate-to-in-nitro.js";
import { requireEventRuntimeConfigInServer } from "./require-event-runtime-config-in-server.js";
import { noEventRuntimeConfigInServer } from "./no-event-runtime-config-in-server.js";
import { noV2Imports } from "./no-v2-imports.js";
import { noClientComposablesInServer } from "./no-client-composables-in-server.js";
import { noBrowserApiInServer } from "./no-browser-api-in-server.js";
import { preferRouteMethodSuffix } from "./prefer-route-method-suffix.js";
import { requireDefaultHandler } from "./require-default-handler.js";
import { preferServerUtils } from "./prefer-server-utils.js";
import { noUnguardedAlsEnterWith } from "./no-unguarded-als-enter-with.js";
import { noModuleScopeResponseCache } from "./no-module-scope-response-cache.js";
import { requireAbsoluteGeneratedPaths } from "./require-absolute-generated-paths.js";
import { noProcessEnvInServer } from "./no-process-env-in-server.js";
import { preferNitroH3Import } from "./prefer-nitro-h3-import.js";
import { declareNitroDependency } from "./declare-nitro-dependency.js";
import { requireVariesForHeaderRead } from "./require-varies-for-header-read.js";
import { noImplicitMiddlewareResponse } from "./no-implicit-middleware-response.js";
import { noShadowedFileHandler } from "./no-shadowed-file-handler.js";
import { noRuntimeConfigInResponse } from "./no-runtime-config-in-response.js";
import { requireWaitUntilForBackgroundWork } from "./require-waituntil-for-background-work.js";
import { noUndeclaredStorageMount } from "./no-undeclared-storage-mount.js";
import { noRequestDataInModuleState } from "./no-request-data-in-module-state.js";

export {
  noUseNuxtAppInNitro,
  noNavigateToInNitro,
  requireEventRuntimeConfigInServer,
  noEventRuntimeConfigInServer,
  noV2Imports,
  noClientComposablesInServer,
  noBrowserApiInServer,
  preferRouteMethodSuffix,
  requireDefaultHandler,
  preferServerUtils,
  noUnguardedAlsEnterWith,
  noModuleScopeResponseCache,
  requireAbsoluteGeneratedPaths,
  noProcessEnvInServer,
  preferNitroH3Import,
  declareNitroDependency,
  requireVariesForHeaderRead,
  noImplicitMiddlewareResponse,
  noShadowedFileHandler,
  noRuntimeConfigInResponse,
  requireWaitUntilForBackgroundWork,
  noUndeclaredStorageMount,
  noRequestDataInModuleState,
};

const rules = [
  noUseNuxtAppInNitro,
  noNavigateToInNitro,
  requireEventRuntimeConfigInServer,
  noEventRuntimeConfigInServer,
  noV2Imports,
  noClientComposablesInServer,
  noBrowserApiInServer,
  preferRouteMethodSuffix,
  requireDefaultHandler,
  noUnguardedAlsEnterWith,
  requireAbsoluteGeneratedPaths,
  noProcessEnvInServer,
  preferNitroH3Import,
  declareNitroDependency,
  requireVariesForHeaderRead,
  noImplicitMiddlewareResponse,
  noShadowedFileHandler,
  noRuntimeConfigInResponse,
  requireWaitUntilForBackgroundWork,
  noRequestDataInModuleState,
];

const strictOnlyRules = [preferServerUtils, noModuleScopeResponseCache, noUndeclaredStorageMount];

const nitroRulePack = defineRulePack({
  name: "vite-doctor/nitro",
  version: "0.0.0",
  activation: { frameworks: ["nitro", "nuxt"] },
  rules: [...rules, ...strictOnlyRules],
  presets: {
    recommended: rules.map((rule) => rule.meta.id),
    strict: [...rules, ...strictOnlyRules].map((rule) => rule.meta.id),
  },
});

export default nitroRulePack;
