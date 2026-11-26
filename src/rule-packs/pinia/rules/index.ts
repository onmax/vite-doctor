import { noActionBypass } from "./no-action-bypass.js";
import { noCircularSetupStateRead } from "./no-circular-setup-state-read.js";
import { noModuleScopeStore } from "./no-module-scope-store.js";
import { noStoreDestructure } from "./no-store-destructure.js";
import { noUnreturnedSetupState } from "./no-unreturned-setup-state.js";
import { storeNameMatchesId } from "./store-name-matches-id.js";
import { uniqueStoreId } from "./unique-store-id.js";

export { noActionBypass } from "./no-action-bypass.js";
export { noCircularSetupStateRead } from "./no-circular-setup-state-read.js";
export { noModuleScopeStore } from "./no-module-scope-store.js";
export { noStoreDestructure } from "./no-store-destructure.js";
export { noUnreturnedSetupState } from "./no-unreturned-setup-state.js";
export { storeNameMatchesId } from "./store-name-matches-id.js";
export { uniqueStoreId } from "./unique-store-id.js";

export const piniaRules = [
  uniqueStoreId,
  storeNameMatchesId,
  noCircularSetupStateRead,
  noActionBypass,
  noStoreDestructure,
  noModuleScopeStore,
  noUnreturnedSetupState,
];
