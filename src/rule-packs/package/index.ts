import { defineRulePack } from "../../core/index.js";
import { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
import { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";

export { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
export { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";

export const packageRulePack = defineRulePack({
  name: "vite-doctor/package",
  version: "0.0.0",
  activation: false,
  rules: [noPhantomDependencies, noRequiredOptionalPeer],
  presets: { recommended: [noPhantomDependencies.meta.id, noRequiredOptionalPeer.meta.id] },
});
