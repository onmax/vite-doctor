import { noCircularSetupStateRead } from "./no-circular-setup-state-read.js";
import { storeNameMatchesId } from "./store-name-matches-id.js";
import { uniqueStoreId } from "./unique-store-id.js";

export { noCircularSetupStateRead } from "./no-circular-setup-state-read.js";
export { storeNameMatchesId } from "./store-name-matches-id.js";
export { uniqueStoreId } from "./unique-store-id.js";

export const piniaRules = [uniqueStoreId, storeNameMatchesId, noCircularSetupStateRead];
