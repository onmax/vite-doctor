import { createValidatedInputRule } from "./request-helpers.js";

export const preferValidatedQuery = createValidatedInputRule({
  id: "nitro/request/prefer-validated-query",
  title: "Use getValidatedQuery for validated query strings",
  description:
    "When a Nitro handler validates query input, read and validate it through the H3 utility.",
  rawUtilities: ["getQuery"],
  validatedUtility: "getValidatedQuery",
  docsUrl: "https://h3.dev/utils/request#getvalidatedqueryevent-validate",
  message: "This query object is read raw and validated separately.",
  suggestion:
    "Use getValidatedQuery(event, validator) so query parsing and validation stay coupled.",
});
