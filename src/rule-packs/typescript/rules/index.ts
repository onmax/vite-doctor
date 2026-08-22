export { noCallerChosenResultType } from "./no-caller-chosen-result-type.js";
export { noChainedTypeAssertions } from "./no-chained-type-assertions.js";
export { noConditionalEmptyObjectSpread } from "./no-conditional-empty-object-spread.js";
export { noObjectParameters } from "./no-object-parameters.js";
export { noRuntimeTypeof } from "./no-runtime-typeof.js";
export { noUnknownTypeAliases } from "./no-unknown-type-aliases.js";
export { noUnvalidatedDeserialization } from "./no-unvalidated-deserialization.js";
export { requireSafetyCommentForTypeAssertion } from "./require-safety-comment-for-type-assertion.js";

import { defineRulePack } from "../../../core/index.js";
import { noCallerChosenResultType } from "./no-caller-chosen-result-type.js";
import { noChainedTypeAssertions } from "./no-chained-type-assertions.js";
import { noConditionalEmptyObjectSpread } from "./no-conditional-empty-object-spread.js";
import { noObjectParameters } from "./no-object-parameters.js";
import { noRuntimeTypeof } from "./no-runtime-typeof.js";
import { noUnknownTypeAliases } from "./no-unknown-type-aliases.js";
import { noUnvalidatedDeserialization } from "./no-unvalidated-deserialization.js";
import { requireSafetyCommentForTypeAssertion } from "./require-safety-comment-for-type-assertion.js";

const recommendedRules = [
  noCallerChosenResultType,
  noChainedTypeAssertions,
  noObjectParameters,
  noUnknownTypeAliases,
  noUnvalidatedDeserialization,
];

const strictRules = [
  ...recommendedRules,
  noConditionalEmptyObjectSpread,
  noRuntimeTypeof,
  requireSafetyCommentForTypeAssertion,
];

const typescriptRulePack = defineRulePack({
  name: "vite-doctor/typescript",
  version: "0.0.0",
  activation: {
    languages: ["typescript"],
  },
  rules: strictRules,
  presets: {
    recommended: recommendedRules.map((rule) => rule.meta.id),
    strict: strictRules.map((rule) => rule.meta.id),
  },
});

export default typescriptRulePack;
