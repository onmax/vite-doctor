import { defineRulePack } from "../../core/index.js";
import { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";

export { noPhantomDependencies } from "./rules/no-phantom-dependencies.js";

export const packageRulePack = defineRulePack({
  name: "vite-doctor/package",
  version: "0.0.0",
  activation: false,
  rules: [noPhantomDependencies],
  presets: { recommended: [noPhantomDependencies.meta.id] },
});
