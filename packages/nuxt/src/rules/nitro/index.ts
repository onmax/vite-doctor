import type { RulePack } from "@vue-doctor/core";
import { noUseNuxtAppInNitro } from "../nuxt/no-use-nuxt-app-in-nitro.js";
import { noNavigateToInNitro } from "../nuxt/no-navigate-to-in-nitro.js";
import { preferEventFetch } from "../nuxt/prefer-event-fetch.js";
import { requireEventRuntimeConfigInServer } from "../nuxt/require-event-runtime-config-in-server.js";
import { noClientComposablesInServer } from "../nuxt/no-client-composables-in-server.js";
import { noBrowserApiInServer } from "../nuxt/no-browser-api-in-server.js";
import { preferValidatedBody } from "./prefer-validated-body.js";
import { preferValidatedQuery } from "./prefer-validated-query.js";
import { preferValidatedRouterParams } from "./prefer-validated-router-params.js";
import { preferAssertMethod } from "./prefer-assert-method.js";
import { preferGetRequestIp } from "./prefer-get-request-ip.js";

export {
  noUseNuxtAppInNitro,
  noNavigateToInNitro,
  preferEventFetch,
  requireEventRuntimeConfigInServer,
  noClientComposablesInServer,
  noBrowserApiInServer,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  preferAssertMethod,
  preferGetRequestIp,
};

const rules = [
  noUseNuxtAppInNitro,
  noNavigateToInNitro,
  preferEventFetch,
  requireEventRuntimeConfigInServer,
  noClientComposablesInServer,
  noBrowserApiInServer,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  preferAssertMethod,
  preferGetRequestIp,
];

const nitroRulePack: RulePack = {
  name: "nuxt-doctor/nitro",
  version: "0.0.0",
  rules,
  presets: {
    recommended: rules.map((rule) => rule.meta.id),
    strict: rules.map((rule) => rule.meta.id),
  },
};

export default nitroRulePack;
