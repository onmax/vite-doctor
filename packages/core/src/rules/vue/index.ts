export { definePropsWatchGetter } from "./define-props-watch-getter.js";
export { noRefAsOperand } from "./no-ref-as-operand.js";
export { noOnWatcherCleanupAfterAwait } from "./no-on-watcher-cleanup-after-await.js";
export { htmlButtonHasType } from "./html-button-has-type.js";
export { preferUseTemplateRef } from "./prefer-use-template-ref.js";
export { preferTrueAttributeShorthand } from "./prefer-true-attribute-shorthand.js";
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
export { preferDefineModel } from "./prefer-define-model.js";
export { preferPropsDestructureDefaults } from "./prefer-props-destructure-defaults.js";
export { preferTypeProps } from "./prefer-type-props.js";
export { preferComposableRefReturn } from "./prefer-composable-ref-return.js";
export { preferSameNamePropShorthand } from "./prefer-same-name-prop-shorthand.js";
export { noUnusedTranslations, noUntranslatedText } from "./i18n.js";

import { definePropsWatchGetter } from "./define-props-watch-getter.js";
import { noRefAsOperand } from "./no-ref-as-operand.js";
import { noOnWatcherCleanupAfterAwait } from "./no-on-watcher-cleanup-after-await.js";
import { htmlButtonHasType } from "./html-button-has-type.js";
import { preferUseTemplateRef } from "./prefer-use-template-ref.js";
import { preferTrueAttributeShorthand } from "./prefer-true-attribute-shorthand.js";
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
import { preferDefineModel } from "./prefer-define-model.js";
import { preferPropsDestructureDefaults } from "./prefer-props-destructure-defaults.js";
import { preferTypeProps } from "./prefer-type-props.js";
import { preferComposableRefReturn } from "./prefer-composable-ref-return.js";
import { preferSameNamePropShorthand } from "./prefer-same-name-prop-shorthand.js";
import { noUnusedTranslations, noUntranslatedText } from "./i18n.js";
import type { RulePack } from "../../primitives.js";

const rules = [
  definePropsWatchGetter,
  noRefAsOperand,
  noOnWatcherCleanupAfterAwait,
  htmlButtonHasType,
  preferUseTemplateRef,
  preferTrueAttributeShorthand,
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
  preferDefineModel,
  preferPropsDestructureDefaults,
  preferTypeProps,
  preferComposableRefReturn,
  preferSameNamePropShorthand,
  noUnusedTranslations,
  noUntranslatedText,
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
