import { defineDoctorDiagnostics } from "../../core/diagnostics.js";

export const vueDiagnosticRegistry = defineDoctorDiagnostics([
  { code: "VUE0001", ruleId: "vue/i18n/no-untranslated-text" },
  { code: "VUE0002", ruleId: "vue/i18n/no-unused-translations" },
  { code: "VUE0003", ruleId: "vue/lifecycle/no-mutation-in-onupdated" },
  { code: "VUE0004", ruleId: "vue/lifecycle/require-cleanup" },
  { code: "VUE0005", ruleId: "vue/reactivity/defineprops-watch-getter" },
  { code: "VUE0006", ruleId: "vue/reactivity/no-ref-as-operand" },
  { code: "VUE0007", ruleId: "vue/reactivity/no-setup-props-destructure" },
  { code: "VUE0008", ruleId: "vue/reactivity/prefer-composable-ref-return" },
  { code: "VUE0009", ruleId: "vue/security/restrict-v-html" },
  { code: "VUE0010", ruleId: "vue/ssr/data-allow-mismatch-surgical" },
  { code: "VUE0011", ruleId: "vue/ssr/no-browser-api-in-setup" },
  { code: "VUE0012", ruleId: "vue/ssr/no-random-or-local-time-render" },
  { code: "VUE0013", ruleId: "vue/ssr/use-id-for-stable-ids" },
  { code: "VUE0014", ruleId: "vue/style/prefer-define-model" },
  { code: "VUE0015", ruleId: "vue/style/prefer-props-destructure-defaults" },
  { code: "VUE0016", ruleId: "vue/style/prefer-type-props" },
  { code: "VUE0017", ruleId: "vue/template/prefer-use-template-ref" },
  { code: "VUE0018", ruleId: "vue/watch/no-async-watcheffect-after-await-read" },
  { code: "VUE0019", ruleId: "vue/watch/no-onwatchercleanup-after-await" },
  { code: "VUE0020", ruleId: "vue/watch/require-post-flush-for-dom-read" },
  { code: "VUE0021", ruleId: "vue/watch/require-side-effect-cleanup" },
  { code: "VUE0022", ruleId: "vue/template/html-button-has-type" },
  { code: "VUE0023", ruleId: "vue/template/prefer-same-name-prop-shorthand" },
  { code: "VUE0024", ruleId: "vue/template/prefer-true-attribute-shorthand" },
]);

export const diagnostics = vueDiagnosticRegistry.diagnostics;
export const diagnosticCodesByRuleId = vueDiagnosticRegistry.codesByRuleId;
