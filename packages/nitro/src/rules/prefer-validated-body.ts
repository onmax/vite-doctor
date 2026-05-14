import { createValidatedInputRule } from "./request-helpers.js";

export const preferValidatedBody = createValidatedInputRule({
  id: "nitro/request/prefer-validated-body",
  title: "Use readValidatedBody for validated request bodies",
  description:
    "When a Nitro handler validates a request body, read and validate it through the H3 utility.",
  rawUtilities: ["readBody"],
  validatedUtility: "readValidatedBody",
  message: "This request body is read raw and validated separately.",
  suggestion:
    "Use readValidatedBody(event, validator) so input parsing and validation stay coupled.",
});
