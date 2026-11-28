import { createValidatedInputRule } from "./request-helpers.js";

export const preferValidatedQuery = createValidatedInputRule({
  id: "h3/request/prefer-validated-query",
  title: "Use getValidatedQuery for validated query strings",
  description:
    "Consider reading and validating query input through the H3 utility when it preserves behavior.",
  rawUtilities: ["getQuery"],
  confidence: "heuristic-medium",
  validatedUtility: "getValidatedQuery",
  docsUrl: "https://h3.dev/utils/request#getvalidatedqueryevent-validate",
  message: "This query object is read raw and validated separately.",
});
