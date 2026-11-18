export { noArrayFilterMap } from "./no-array-filter-map.js";
export { noKnownValueWidening } from "./no-known-value-widening.js";
export { noWidenThenAssert } from "./no-widen-then-assert.js";
export { noReduceAccumulatorCopy } from "./no-reduce-accumulator-copy.js";
export { noCallerChosenResultType } from "./no-caller-chosen-result-type.js";
export { noChainedTypeAssertions } from "./no-chained-type-assertions.js";
export { noCrossRealmPrototypeIdentity } from "./no-cross-realm-prototype-identity.js";
export { noCrossRealmWebInstanceof } from "./no-cross-realm-web-instanceof.js";
export { noInheritedKeyLookup } from "./no-inherited-key-lookup.js";
export { noObjectParameters } from "./no-object-parameters.js";
export { noUnknownTypeAliases } from "./no-unknown-type-aliases.js";
export { noUnvalidatedDeserialization } from "./no-unvalidated-deserialization.js";
export { requireSafetyCommentForTypeAssertion } from "./require-safety-comment-for-type-assertion.js";

import { defineRulePack } from "../../../core/index.js";
import { noCallerChosenResultType } from "./no-caller-chosen-result-type.js";
import { noChainedTypeAssertions } from "./no-chained-type-assertions.js";
import { noCrossRealmPrototypeIdentity } from "./no-cross-realm-prototype-identity.js";
import { noCrossRealmWebInstanceof } from "./no-cross-realm-web-instanceof.js";
import { noInheritedKeyLookup } from "./no-inherited-key-lookup.js";
import { noObjectParameters } from "./no-object-parameters.js";
import { noUnknownTypeAliases } from "./no-unknown-type-aliases.js";
import { noUnvalidatedDeserialization } from "./no-unvalidated-deserialization.js";
import { requireSafetyCommentForTypeAssertion } from "./require-safety-comment-for-type-assertion.js";

import { noArrayFilterMap } from "./no-array-filter-map.js";
import { noKnownValueWidening } from "./no-known-value-widening.js";
import { noWidenThenAssert } from "./no-widen-then-assert.js";
import { noReduceAccumulatorCopy } from "./no-reduce-accumulator-copy.js";

const recommendedRules = [noChainedTypeAssertions, noUnvalidatedDeserialization];

const strictRules = [
  noArrayFilterMap,
  noKnownValueWidening,
  noWidenThenAssert,
  noReduceAccumulatorCopy,
  noCallerChosenResultType,
  ...recommendedRules,
  noCrossRealmWebInstanceof,
  noCrossRealmPrototypeIdentity,
  noInheritedKeyLookup,
  noObjectParameters,
  noUnknownTypeAliases,
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
