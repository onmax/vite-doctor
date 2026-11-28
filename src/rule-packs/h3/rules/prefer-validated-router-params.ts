import { createValidatedInputRule } from "./request-helpers.js";

export const preferValidatedRouterParams = createValidatedInputRule({
  id: "h3/request/prefer-validated-router-params",
  title: "Use getValidatedRouterParams for validated route params",
  description:
    "Consider reading and validating the whole route params object through the H3 utility when it preserves behavior.",
  rawUtilities: ["getRouterParams"],
  confidence: "heuristic-medium",
  validatedUtility: "getValidatedRouterParams",
  docsUrl: "https://h3.dev/utils/request#getvalidatedrouterparamsevent-validate",
  message: "These route params are read raw and validated separately.",
});
