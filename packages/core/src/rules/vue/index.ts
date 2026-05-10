export { noPropMutation } from "./no-prop-mutation.js";
export { definePropsWatchGetter } from "./define-props-watch-getter.js";
export { noRefAsOperand } from "./no-ref-as-operand.js";
export { computedNoSideEffects } from "./computed-no-side-effects.js";
export { computedNoAsync } from "./computed-no-async.js";
export { noAfterAwait } from "./no-after-await.js";
export { noOnWatcherCleanupAfterAwait } from "./no-on-watcher-cleanup-after-await.js";
export { requireVForKey } from "./require-v-for-key.js";
export { noVIfWithVFor } from "./no-v-if-with-v-for.js";
export { preferUseTemplateRef } from "./prefer-use-template-ref.js";
export { noBrowserApiInSetup } from "./no-browser-api-in-setup.js";
export { restrictVHtml } from "./restrict-v-html.js";
export { noSetupPropsDestructure } from "./no-setup-props-destructure.js";
export { noAsyncWatchEffectAfterAwaitRead } from "./no-async-watch-effect-after-await-read.js";
export { requireWatcherCleanup } from "./require-watcher-cleanup.js";
export { requirePostFlushForDomWatch } from "./require-post-flush-for-dom-watch.js";
export { noMutationInOnUpdated } from "./no-mutation-in-on-updated.js";
export { requireLifecycleCleanup } from "./require-lifecycle-cleanup.js";
export { preferUseIdForStableIds } from "./prefer-use-id-for-stable-ids.js";
export { noRandomOrLocalTimeRender } from "./no-random-or-local-time-render.js";
export { dataAllowMismatchSurgical } from "./data-allow-mismatch-surgical.js";

import { noPropMutation } from "./no-prop-mutation.js";
import { definePropsWatchGetter } from "./define-props-watch-getter.js";
import { noRefAsOperand } from "./no-ref-as-operand.js";
import { computedNoSideEffects } from "./computed-no-side-effects.js";
import { computedNoAsync } from "./computed-no-async.js";
import { noAfterAwait } from "./no-after-await.js";
import { noOnWatcherCleanupAfterAwait } from "./no-on-watcher-cleanup-after-await.js";
import { requireVForKey } from "./require-v-for-key.js";
import { noVIfWithVFor } from "./no-v-if-with-v-for.js";
import { preferUseTemplateRef } from "./prefer-use-template-ref.js";
import { noBrowserApiInSetup } from "./no-browser-api-in-setup.js";
import { restrictVHtml } from "./restrict-v-html.js";
import { noSetupPropsDestructure } from "./no-setup-props-destructure.js";
import { noAsyncWatchEffectAfterAwaitRead } from "./no-async-watch-effect-after-await-read.js";
import { requireWatcherCleanup } from "./require-watcher-cleanup.js";
import { requirePostFlushForDomWatch } from "./require-post-flush-for-dom-watch.js";
import { noMutationInOnUpdated } from "./no-mutation-in-on-updated.js";
import { requireLifecycleCleanup } from "./require-lifecycle-cleanup.js";
import { preferUseIdForStableIds } from "./prefer-use-id-for-stable-ids.js";
import { noRandomOrLocalTimeRender } from "./no-random-or-local-time-render.js";
import { dataAllowMismatchSurgical } from "./data-allow-mismatch-surgical.js";
import type { RulePack } from "../../primitives.js";

const rules = [
  noPropMutation,
  definePropsWatchGetter,
  noRefAsOperand,
  computedNoSideEffects,
  computedNoAsync,
  noAfterAwait,
  noOnWatcherCleanupAfterAwait,
  requireVForKey,
  noVIfWithVFor,
  preferUseTemplateRef,
  noBrowserApiInSetup,
  restrictVHtml,
  noSetupPropsDestructure,
  noAsyncWatchEffectAfterAwaitRead,
  requireWatcherCleanup,
  requirePostFlushForDomWatch,
  noMutationInOnUpdated,
  requireLifecycleCleanup,
  preferUseIdForStableIds,
  noRandomOrLocalTimeRender,
  dataAllowMismatchSurgical,
];

const vueRulePack: RulePack = {
  name: "vue-doctor/vue",
  version: "0.0.0",
  rules,
  presets: {
    recommended: rules.map((rule) => rule.meta.id),
    strict: rules.map((rule) => rule.meta.id),
  },
};

export default vueRulePack;
