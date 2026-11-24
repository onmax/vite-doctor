import { defineRulePack } from "../../core/index.js";
import { noConditionAfterDefault } from "./rules/no-condition-after-default.js";
import { noDuplicateSingleton } from "./rules/no-duplicate-singleton.js";
import { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
import { noPinnedSingleton } from "./rules/no-pinned-singleton.js";
import { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";
import { noUnforwardedPeer } from "./rules/no-unforwarded-peer.js";
import { optionalPeerImportInTry } from "./rules/optional-peer-import-in-try.js";

export { noConditionAfterDefault } from "./rules/no-condition-after-default.js";
export { noDuplicateSingleton } from "./rules/no-duplicate-singleton.js";
export { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
export { noPinnedSingleton } from "./rules/no-pinned-singleton.js";
export { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";
export { noUnforwardedPeer } from "./rules/no-unforwarded-peer.js";
export { optionalPeerImportInTry } from "./rules/optional-peer-import-in-try.js";

const rules = [
  noPhantomDependencies,
  noRequiredOptionalPeer,
  optionalPeerImportInTry,
  noPinnedSingleton,
  noUnforwardedPeer,
  noDuplicateSingleton,
  noConditionAfterDefault,
];

export const packageRulePack = defineRulePack({
  name: "vite-doctor/package",
  version: "0.0.0",
  activation: false,
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});
