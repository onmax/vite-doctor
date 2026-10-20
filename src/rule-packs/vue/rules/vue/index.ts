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
export { preferUseEventListener } from "./prefer-use-event-listener.js";
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
export { requireUsePrefix } from "./require-use-prefix.js";
export { maxProps } from "./max-props.js";
export { noUnusedProps } from "./no-unused-props.js";
export { noIndexKeyOnStatefulList } from "./no-index-key-on-stateful-list.js";
export { noUnusedTranslations, noUntranslatedText } from "./i18n.js";

export { noMutatingProps } from "./no-mutating-props.js";
export { noComputedSideEffects } from "./no-computed-side-effects.js";
export { noVIfWithVFor } from "./no-v-if-with-v-for.js";
export { noDuplicateAttrInheritance } from "./no-duplicate-attr-inheritance.js";
export { noRequiredPropWithDefault } from "./no-required-prop-with-default.js";

export { noWatchUseAttrs } from "./no-watch-use-attrs.js";
export { noReactiveDestructure } from "./no-reactive-destructure.js";
export { preferComputedOverWatchAssign } from "./prefer-computed-over-watch-assign.js";

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
import { preferUseEventListener } from "./prefer-use-event-listener.js";
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
import { requireUsePrefix } from "./require-use-prefix.js";
import { maxProps } from "./max-props.js";
import { noUnusedProps } from "./no-unused-props.js";
import { noIndexKeyOnStatefulList } from "./no-index-key-on-stateful-list.js";
import { noUnusedTranslations, noUntranslatedText } from "./i18n.js";

import { noMutatingProps } from "./no-mutating-props.js";
import { noComputedSideEffects } from "./no-computed-side-effects.js";
import { noVIfWithVFor } from "./no-v-if-with-v-for.js";
import { noDuplicateAttrInheritance } from "./no-duplicate-attr-inheritance.js";
import { noRequiredPropWithDefault } from "./no-required-prop-with-default.js";

import { noWatchUseAttrs } from "./no-watch-use-attrs.js";
import { noReactiveDestructure } from "./no-reactive-destructure.js";
import { preferComputedOverWatchAssign } from "./prefer-computed-over-watch-assign.js";

import { defineRulePack } from "../../../../core/index.js";

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
  preferUseEventListener,
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
  requireUsePrefix,
  noIndexKeyOnStatefulList,
  noUnusedTranslations,
  noUntranslatedText,

  maxProps,
  noUnusedProps,


  noMutatingProps,
  noComputedSideEffects,
  noVIfWithVFor,
  noDuplicateAttrInheritance,
  noRequiredPropWithDefault,
  noWatchUseAttrs,
  noReactiveDestructure,
  preferComputedOverWatchAssign,
];

// Recommended only holds rules whose hits identify a specific defect; style, naming,
// library-migration, and documentation rules need an explicit opt-in through Strict.
const strictOnlyRules = [
  preferUseTemplateRef,
  preferTrueAttributeShorthand,
  preferUseEventListener,
  dataAllowMismatchSurgical,
  preferDefineModel,
  preferPropsDestructureDefaults,
  preferTypeProps,
  preferSameNamePropShorthand,
  requireUsePrefix,
  noUnusedTranslations,
  noUntranslatedText,
  maxProps,
  noUnusedProps,
  preferComputedOverWatchAssign,
];

const vueRulePack = defineRulePack({
  name: "vite-doctor/vue",
  version: "0.0.0",
  activation: { frameworks: ["vue", "nuxt"] },
  rules,
  presets: {
    recommended: rules
      .map((rule) => rule.meta.id)
      .filter((id) => !strictOnlyRules.some((rule) => rule.meta.id === id)),
    strict: rules.map((rule) => rule.meta.id),
  },
});

export default vueRulePack;
