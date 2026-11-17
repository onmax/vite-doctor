import { defineRulePack } from "../../core/index.js";
import { noDuplicateSingleton } from "./rules/no-duplicate-singleton.js";
import { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
import { noPinnedSingleton } from "./rules/no-pinned-singleton.js";
import { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";
import { noUnforwardedPeer } from "./rules/no-unforwarded-peer.js";

export { noDuplicateSingleton } from "./rules/no-duplicate-singleton.js";
export { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
export { noPinnedSingleton } from "./rules/no-pinned-singleton.js";
export { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";
export { noUnforwardedPeer } from "./rules/no-unforwarded-peer.js";

const rules = [
  noPhantomDependencies,
  noRequiredOptionalPeer,
  noPinnedSingleton,
  noUnforwardedPeer,
  noDuplicateSingleton,
];

export const packageRulePack = defineRulePack({
  name: "vite-doctor/package",
  version: "0.0.0",
  activation: false,
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
});
