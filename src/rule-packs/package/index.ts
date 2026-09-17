import { defineRulePack } from "../../core/index.js";
import { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";

export { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";

export const packageRulePack = defineRulePack({
  name: "vite-doctor/package",
  version: "0.0.0",
  activation: false,
  rules: [noRequiredOptionalPeer],
  presets: { recommended: [noRequiredOptionalPeer.meta.id] },
});
