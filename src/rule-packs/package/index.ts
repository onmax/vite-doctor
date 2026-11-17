import { defineRulePack } from "../../core/index.js";
import { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
import { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";
import { optionalPeerImportInTry } from "./rules/optional-peer-import-in-try.js";

export { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";
export { noRequiredOptionalPeer } from "./rules/no-required-optional-peer.js";
export { optionalPeerImportInTry } from "./rules/optional-peer-import-in-try.js";

export const packageRulePack = defineRulePack({
  name: "vite-doctor/package",
  version: "0.0.0",
  activation: false,
  rules: [noPhantomDependencies, noRequiredOptionalPeer, optionalPeerImportInTry],
  presets: {
    recommended: [
      noPhantomDependencies.meta.id,
      noRequiredOptionalPeer.meta.id,
      optionalPeerImportInTry.meta.id,
    ],
  },
});
