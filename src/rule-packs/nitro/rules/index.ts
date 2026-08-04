import { defineRulePack } from "../../../core/index.js";
import { noUseNuxtAppInNitro } from "./no-use-nuxt-app-in-nitro.js";
import { noNavigateToInNitro } from "./no-navigate-to-in-nitro.js";
import { requireEventRuntimeConfigInServer } from "./require-event-runtime-config-in-server.js";
import { noEventRuntimeConfigInServer } from "./no-event-runtime-config-in-server.js";
import { noV2Imports } from "./no-v2-imports.js";
import { noRemovedH3Send } from "./no-removed-h3-send.js";
import { preferH3RedirectResponse } from "./prefer-h3-redirect-response.js";
import { noClientComposablesInServer } from "./no-client-composables-in-server.js";
import { noBrowserApiInServer } from "./no-browser-api-in-server.js";
import { preferValidatedBody } from "./prefer-validated-body.js";
import { preferValidatedQuery } from "./prefer-validated-query.js";
import { preferValidatedRouterParams } from "./prefer-validated-router-params.js";
import { preferAssertMethod } from "./prefer-assert-method.js";
import { preferRouteMethodSuffix } from "./prefer-route-method-suffix.js";
import { preferGetRequestIp } from "./prefer-get-request-ip.js";

export {
  noUseNuxtAppInNitro,
  noNavigateToInNitro,
  requireEventRuntimeConfigInServer,
  noEventRuntimeConfigInServer,
  noV2Imports,
  noRemovedH3Send,
  preferH3RedirectResponse,
  noClientComposablesInServer,
  noBrowserApiInServer,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  preferAssertMethod,
  preferRouteMethodSuffix,
  preferGetRequestIp,
};

const rules = [
  noUseNuxtAppInNitro,
  noNavigateToInNitro,
  requireEventRuntimeConfigInServer,
  noEventRuntimeConfigInServer,
  noV2Imports,
  noRemovedH3Send,
  preferH3RedirectResponse,
  noClientComposablesInServer,
  noBrowserApiInServer,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  preferAssertMethod,
  preferRouteMethodSuffix,
  preferGetRequestIp,
];

const nitroRulePack = defineRulePack({
  name: "vite-doctor/nitro",
  version: "0.0.0",
  rules,
  presets: {
    recommended: rules.map((rule) => rule.meta.id),
    strict: rules.map((rule) => rule.meta.id),
  },
});

export default nitroRulePack;
