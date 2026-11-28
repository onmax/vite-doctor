import { createValidatedInputRule } from "./request-helpers.js";

export const preferValidatedBody = createValidatedInputRule({
  id: "h3/request/prefer-validated-body",
  title: "Use readValidatedBody for validated request bodies",
  description:
    "Consider reading and validating the request body through the H3 utility when it preserves behavior.",
  rawUtilities: ["readBody"],
  confidence: "heuristic-medium",
  validatedUtility: "readValidatedBody",
  docsUrl: "https://h3.dev/utils/request#readvalidatedbodyevent-validate",
  message: "This request body is read raw and validated separately.",
});
