import { createValidatedInputRule } from "./request-helpers.js";

export const preferValidatedRouterParams = createValidatedInputRule({
  id: "nitro/request/prefer-validated-router-params",
  title: "Use getValidatedRouterParams for validated route params",
  description:
    "When a Nitro handler validates route params, read and validate them through the H3 utility.",
  rawUtilities: ["getRouterParams", "getRouterParam"],
  validatedUtility: "getValidatedRouterParams",
  docsUrl: "https://h3.dev/utils/request#getvalidatedrouterparamsevent-validate",
  message: "These route params are read raw and validated separately.",
  suggestion:
    "Use getValidatedRouterParams(event, validator) so route param parsing and validation stay coupled.",
});
