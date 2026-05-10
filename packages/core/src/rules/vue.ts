import { createRule, type DoctorRule, type RuleContext, type RulePack } from "../primitives.js";
import { Linter } from "eslint";
import vuePlugin from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import tsParser from "@typescript-eslint/parser";

type AnyNode = any;

const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
]);

const delegatedMessages: Record<string, string> = {
  "vue/reactivity/no-prop-mutation":
    "Props are read-only. Emit an update event or copy the value into local state instead.",
  "vue/reactivity/no-ref-as-operand": "Refs used as script operands must be unwrapped with .value.",
  "vue/computed/no-side-effects":
    "Computed getters must be pure. Move mutations, DOM writes, or network work into an action, watcher, or lifecycle hook.",
  "vue/computed/no-async":
    "Async computed getters do not model loading, errors, or cancellation well. Use useFetch(), useAsyncData(), or an explicit async action.",
  "vue/watch/no-after-await":
    "Watchers registered after await may not be owner-bound. Register them before the first await in setup/composables.",
  "vue/template/no-v-if-with-v-for":
    "v-if and v-for on the same element create ambiguous filtering and rendering behavior. Filter with computed state before rendering.",
};

const delegatedSuggestions: Record<string, string> = {
  "vue/reactivity/no-prop-mutation":
    "Replace the mutation with emit('update:...') or derived local state.",
  "vue/reactivity/no-ref-as-operand": "Use .value in script expressions.",
  "vue/template/no-v-if-with-v-for": "Filter the source list before rendering.",
};

export const noPropMutation = createEslintVueRule({
  doctorId: "vue/reactivity/no-prop-mutation",
  eslintId: "vue/no-mutating-props",
  meta: {
    id: "vue/reactivity/no-prop-mutation",
    title: "Do not mutate props",
    category: "reactivity",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});

export const definePropsWatchGetter = createRule({
  meta: {
    id: "vue/reactivity/defineprops-watch-getter",
    title: "Watch destructured props with a getter",
    category: "reactivity",
    severity: "error",
    fixable: "safe",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    const destructured = new Set<string>();
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type === "VariableDeclarator" &&
          node.id?.type === "ObjectPattern" &&
          ctx.helpers.isCall(node.init, "defineProps")
        ) {
          for (const property of node.id.properties ?? []) {
            for (const local of bindingNames(property.value ?? property.argument ?? property.key)) {
              destructured.add(local);
            }
          }
        }
        if (
          ctx.helpers.isCall(node, "watch") &&
          node.arguments?.[0]?.type === "Identifier" &&
          destructured.has(node.arguments[0].name)
        ) {
          const id = node.arguments[0];
          ctx.report({
            ruleId: "vue/reactivity/defineprops-watch-getter",
            severity: "error",
            category: "reactivity",
            file: ctx.file.path,
            range: ctx.range(id),
            message: `watch(${id.name}, ...) passes the current prop value. Use a getter so Vue tracks the destructured prop.`,
            suggestion: `Use watch(() => ${id.name}, ...).`,
            fix: {
              kind: "safe",
              edits: [{ range: { start: id.start, end: id.end }, text: `() => ${id.name}` }],
            },
          });
        }
      },
    };
  },
});

export const noRefAsOperand = createEslintVueRule({
  doctorId: "vue/reactivity/no-ref-as-operand",
  eslintId: "vue/no-ref-as-operand",
  meta: {
    id: "vue/reactivity/no-ref-as-operand",
    title: "Use .value when refs are operands",
    category: "reactivity",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});

export const computedNoSideEffects = createEslintVueRule({
  doctorId: "vue/computed/no-side-effects",
  eslintId: "vue/no-side-effects-in-computed-properties",
  meta: {
    id: "vue/computed/no-side-effects",
    title: "Computed getters should be pure",
    category: "computed",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});

export const computedNoAsync = createEslintVueRule({
  doctorId: "vue/computed/no-async",
  eslintId: "vue/no-async-in-computed-properties",
  meta: {
    id: "vue/computed/no-async",
    title: "Do not use async computed getters",
    category: "computed",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});

export const noAfterAwait = createEslintVueRule({
  doctorId: "vue/watch/no-after-await",
  eslintId: "vue/no-watch-after-await",
  meta: {
    id: "vue/watch/no-after-await",
    title: "Register watchers and lifecycle hooks before await",
    category: "watchers",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
});

export const noOnWatcherCleanupAfterAwait = createRule({
  meta: {
    id: "vue/watch/no-onwatchercleanup-after-await",
    title: "Call onWatcherCleanup synchronously",
    category: "watchers",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "onWatcherCleanup") && isAfterAwaitInWatcherCallback(node)) {
          report(
            ctx,
            node,
            "vue/watch/no-onwatchercleanup-after-await",
            "error",
            "watchers",
            "onWatcherCleanup() must be called synchronously before the first await in the watcher callback.",
          );
        }
      },
    };
  },
});

export const requireVForKey = createRule({
  meta: {
    id: "vue/template/require-v-for-key",
    title: "Require stable keys on v-for",
    category: "template",
    severity: "error",
    fixable: "suggestion",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement") return;
        if (
          ctx.helpers.hasVueDirective(node, "for") &&
          !ctx.helpers.hasVueDirective(node, "bind", "key") &&
          !ctx.helpers.hasVueAttribute(node, "key")
        ) {
          report(
            ctx,
            node,
            "vue/template/require-v-for-key",
            "error",
            "template",
            "v-for lists need a stable key so Vue can preserve component and DOM identity during updates.",
            "Add :key using a stable item id.",
          );
        }
      },
    };
  },
});

export const noVIfWithVFor = createEslintVueRule({
  doctorId: "vue/template/no-v-if-with-v-for",
  eslintId: "vue/no-use-v-if-with-v-for",
  meta: {
    id: "vue/template/no-v-if-with-v-for",
    title: "Do not combine v-if and v-for on the same element",
    category: "template",
    severity: "error",
    fixable: "suggestion",
    requires: { template: true, vue: true },
  },
});

export const preferUseTemplateRef = createRule({
  meta: {
    id: "vue/template/prefer-use-template-ref",
    title: "Prefer useTemplateRef for template refs",
    category: "template",
    severity: "info",
    fixable: "suggestion",
    requires: { sfc: true, template: true, script: true, vue: true },
  },
  create(ctx) {
    const refs = new Set<string>();
    return {
      SFC(sfc) {
        for (const match of sfc.source.matchAll(/\bref=["']([^"']+)["']/g)) {
          refs.add(match[1]);
        }
      },
      TemplateNode(node: AnyNode) {
        if (node.type === "VElement") {
          const ref = ctx.helpers.getStaticVueAttributeValue(node, "ref");
          if (ref) refs.add(ref);
        }
      },
      ScriptNode(node: AnyNode) {
        if (
          node.type === "VariableDeclarator" &&
          node.id?.type === "Identifier" &&
          refs.has(node.id.name) &&
          ctx.helpers.isCall(node.init, "ref")
        ) {
          report(
            ctx,
            node,
            "vue/template/prefer-use-template-ref",
            "info",
            "template",
            "Vue 3.5 supports useTemplateRef() for template refs, which keeps the ref name tied to the template.",
            `Use useTemplateRef('${node.id.name}').`,
          );
        }
      },
    };
  },
});

export const noBrowserApiInSetup = createRule({
  meta: {
    id: "vue/ssr/no-browser-api-in-setup",
    title: "Do not read browser APIs in SSR setup paths",
    category: "ssr",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (ctx.project.framework === "nuxt") return;
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type === "Identifier" &&
          BROWSER_GLOBALS.has(node.name) &&
          !ctx.file.relativePath.includes(".client.") &&
          !ctx.helpers.isTypeOnlyContext(node) &&
          !ctx.helpers.isTypeofOperand(node) &&
          !ctx.helpers.hasLocalBindingBefore(node, ctx.file.text) &&
          !ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
        ) {
          report(
            ctx,
            node,
            "vue/ssr/no-browser-api-in-setup",
            "error",
            "ssr",
            `${node.name} is a browser-only API. Access it inside onMounted(), a client-only plugin, or a guarded client branch.`,
          );
        }
      },
    };
  },
});

export const restrictVHtml = createRule({
  meta: {
    id: "vue/security/restrict-v-html",
    title: "Restrict v-html to trusted HTML",
    category: "security",
    severity: "error",
    fixable: "suggestion",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type === "VElement" && ctx.helpers.hasVueDirective(node, "html")) {
          report(
            ctx,
            node,
            "vue/security/restrict-v-html",
            "error",
            "security",
            "v-html can execute untrusted markup. Only render sanitized or trusted HTML here.",
          );
        }
      },
    };
  },
});

export const noSetupPropsDestructure = createRule({
  meta: {
    id: "vue/reactivity/no-setup-props-destructure",
    title: "Do not destructure setup props",
    description: "Classic setup(props) props lose reactivity when destructured directly.",
    why: "The props proxy is reactive, but local destructured bindings are snapshots.",
    recommendedReplacement:
      "Use props.foo, toRefs(props), or <script setup> reactive props destructuring.",
    category: "reactivity",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "VariableDeclarator" || node.id?.type !== "ObjectPattern") return;
        if (node.init?.name !== "props") return;
        if (!/setup\s*\(\s*props\b/.test(ctx.file.text.slice(0, node.start))) return;
        report(
          ctx,
          node,
          "vue/reactivity/no-setup-props-destructure",
          "error",
          "reactivity",
          "Destructuring setup(props) creates non-reactive local values.",
          "Use props.foo, toRefs(props), or migrate to <script setup> reactive props destructuring.",
        );
      },
    };
  },
});

export const noAsyncWatchEffectAfterAwaitRead = createRule({
  meta: {
    id: "vue/watch/no-async-watcheffect-after-await-read",
    title: "Do not read watchEffect dependencies after await",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "watchEffect")) return;
        const callback = node.arguments?.[0];
        if (!callback?.async || callback.body?.start == null || callback.body?.end == null) return;
        const body = ctx.file.text.slice(callback.body.start, callback.body.end);
        if (!/\bawait\b[\s\S]*\b[A-Za-z_$][\w$]*(?:\.value|\.)/.test(body)) return;
        report(
          ctx,
          node,
          "vue/watch/no-async-watcheffect-after-await-read",
          "warn",
          "watchers",
          "watchEffect only tracks dependencies read before the first await.",
          "Read dependencies before awaiting or use watch() with an explicit source.",
        );
      },
    };
  },
});

export const requireWatcherCleanup = createRule({
  meta: {
    id: "vue/watch/require-side-effect-cleanup",
    title: "Clean up watcher side effects",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "watch") && !ctx.helpers.isCall(node, "watchEffect")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (
          !/(addEventListener|setInterval|setTimeout|new\s+(ResizeObserver|IntersectionObserver|WebSocket))/.test(
            snippet,
          )
        )
          return;
        if (
          /(onCleanup|onWatcherCleanup|onScopeDispose|removeEventListener|clearInterval|clearTimeout|disconnect|close)\s*\(/.test(
            snippet,
          )
        )
          return;
        report(
          ctx,
          node,
          "vue/watch/require-side-effect-cleanup",
          "warn",
          "watchers",
          "This watcher creates a side effect without registering cleanup.",
          "Use onWatcherCleanup(), the watcher onCleanup argument, or onScopeDispose().",
        );
      },
    };
  },
});

export const requirePostFlushForDomWatch = createRule({
  meta: {
    id: "vue/watch/require-post-flush-for-dom-read",
    title: "Use post-flush watchers for DOM reads",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "watch")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (
          !/\b(document|window|getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight)\b/.test(
            snippet,
          )
        )
          return;
        if (/flush\s*:\s*['"]post['"]/.test(snippet)) return;
        report(
          ctx,
          node,
          "vue/watch/require-post-flush-for-dom-read",
          "warn",
          "watchers",
          "This watcher reads DOM state before Vue has flushed owner DOM updates.",
          "Pass { flush: 'post' } or use watchPostEffect().",
        );
      },
    };
  },
});

export const noMutationInOnUpdated = createRule({
  meta: {
    id: "vue/lifecycle/no-mutation-in-onupdated",
    title: "Do not mutate state in onUpdated",
    category: "lifecycle",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "onUpdated")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/(\.value\s*=|\+\+|--|\.push\s*\(|\.splice\s*\(|=)/.test(snippet)) return;
        report(
          ctx,
          node,
          "vue/lifecycle/no-mutation-in-onupdated",
          "error",
          "lifecycle",
          "Mutating reactive state in onUpdated can create update loops.",
          "Move the mutation to the event or watcher that caused the update.",
        );
      },
    };
  },
});

export const requireLifecycleCleanup = createRule({
  meta: {
    id: "vue/lifecycle/require-cleanup",
    title: "Clean up lifecycle resources",
    category: "lifecycle",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    let hasCleanup = false;
    return {
      ScriptNode(node: AnyNode) {
        if (
          ctx.helpers.isCall(node, "onUnmounted") ||
          ctx.helpers.isCall(node, "onBeforeUnmount") ||
          ctx.helpers.isCall(node, "onScopeDispose")
        )
          hasCleanup = true;
        if (node.type !== "Program") return;
        if (
          !/(setInterval|addEventListener|new\s+(ResizeObserver|IntersectionObserver|WebSocket))/.test(
            ctx.file.text,
          )
        )
          return;
        if (
          /(clearInterval|removeEventListener|disconnect|close)\s*\(/.test(ctx.file.text) ||
          hasCleanup
        )
          return;
        report(
          ctx,
          node,
          "vue/lifecycle/require-cleanup",
          "warn",
          "lifecycle",
          "This component creates a long-lived browser resource without lifecycle cleanup.",
          "Register cleanup with onUnmounted() or onScopeDispose().",
        );
      },
    };
  },
});

export const preferUseIdForStableIds = createRule({
  meta: {
    id: "vue/ssr/use-id-for-stable-ids",
    title: "Use useId for SSR-stable ids",
    category: "ssr",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "Math.random" && name !== "Date.now") return;
        const nearby = ctx.file.text.slice(Math.max(0, node.start - 80), node.end + 80);
        if (!/\bid\b|for=|aria-|htmlFor/i.test(nearby)) return;
        report(
          ctx,
          node,
          "vue/ssr/use-id-for-stable-ids",
          "warn",
          "ssr",
          "Generated ids rendered during SSR must match during hydration.",
          "Use Vue's useId() for stable SSR-safe ids.",
        );
      },
    };
  },
});

export const noRandomOrLocalTimeRender = createRule({
  meta: {
    id: "vue/ssr/no-random-or-local-time-render",
    title: "Avoid random or local-time SSR render values",
    category: "ssr",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (
          name !== "Math.random" &&
          name !== "Date.now" &&
          !(node.type === "NewExpression" && node.callee?.name === "Date")
        )
          return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        report(
          ctx,
          node,
          "vue/ssr/no-random-or-local-time-render",
          "warn",
          "ssr",
          "Random or local-time values rendered during SSR can differ during hydration.",
          "Create stable server state, defer to mounted client code, or isolate with data-allow-mismatch.",
        );
      },
    };
  },
});

export const dataAllowMismatchSurgical = createRule({
  meta: {
    id: "vue/ssr/data-allow-mismatch-surgical",
    title: "Use data-allow-mismatch only surgically",
    category: "ssr",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || !ctx.helpers.hasVueAttribute(node, "data-allow-mismatch"))
          return;
        const start = node.range?.[0] ?? node.start ?? 0;
        const end = node.range?.[1] ?? node.end ?? start;
        const snippet = ctx.file.text.slice(Math.max(0, start - 120), end + 80);
        if (/doctor-allow-mismatch|allow-mismatch-reason|hydration mismatch reason/i.test(snippet))
          return;
        report(
          ctx,
          node,
          "vue/ssr/data-allow-mismatch-surgical",
          "warn",
          "ssr",
          "data-allow-mismatch should be a narrow hydration escape hatch with an explicit reason.",
          "Add a nearby reason comment or fix the underlying SSR/client divergence.",
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [
  noPropMutation,
  definePropsWatchGetter,
  noRefAsOperand,
  computedNoSideEffects,
  computedNoAsync,
  noAfterAwait,
  noOnWatcherCleanupAfterAwait,
  noSetupPropsDestructure,
  noAsyncWatchEffectAfterAwaitRead,
  requireWatcherCleanup,
  requirePostFlushForDomWatch,
  noMutationInOnUpdated,
  requireLifecycleCleanup,
  requireVForKey,
  noVIfWithVFor,
  preferUseTemplateRef,
  preferUseIdForStableIds,
  noRandomOrLocalTimeRender,
  dataAllowMismatchSurgical,
  noBrowserApiInSetup,
  restrictVHtml,
];

export const vueRulePack: RulePack = {
  name: "vue-doctor/vue",
  version: "0.0.0",
  rules,
  presets: {
    recommended: rules.map((rule) => rule.meta.id),
    strict: rules.map((rule) => rule.meta.id),
  },
};

export default vueRulePack;

function report(
  ctx: RuleContext,
  node: AnyNode,
  ruleId: string,
  severity: any,
  category: string,
  message: string,
  suggestion?: string,
) {
  ctx.helpers.report(ctx, node, {
    ruleId,
    severity,
    category,
    message,
    suggestion,
  });
}

function bindingNames(pattern: AnyNode): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "ObjectPattern")
    return (pattern.properties ?? []).flatMap((property: AnyNode) =>
      bindingNames(property.value ?? property.argument ?? property.key),
    );
  if (pattern.type === "ArrayPattern")
    return (pattern.elements ?? []).flatMap((element: AnyNode) => bindingNames(element));
  return [];
}

function isAfterAwaitInWatcherCallback(node: AnyNode): boolean {
  const callback = nearestFunctionAncestor(node);
  if (!callback || !isWatcherCallback(callback)) return false;
  let foundCleanup = false;
  let seenAwait = false;
  walkScriptLocal(callback.body ?? callback, (current) => {
    if (current === node) {
      foundCleanup = true;
      return;
    }
    if (!foundCleanup && current.type === "AwaitExpression") seenAwait = true;
  });
  return seenAwait;
}

function isWatcherCallback(functionNode: AnyNode): boolean {
  const call = functionNode.__doctorParent;
  if (call?.type !== "CallExpression") return false;
  const name = call.callee?.name ?? call.callee?.property?.name;
  return ["watch", "watchEffect", "watchPostEffect", "watchSyncEffect"].includes(name);
}

function nearestFunctionAncestor(node: AnyNode): AnyNode {
  let current = node?.__doctorParent;
  while (current) {
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        current.type,
      )
    )
      return current;
    current = current.__doctorParent;
  }
  return null;
}

function walkScriptLocal(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkScriptLocal(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkScriptLocal(child, visit);
    } else if (value && typeof value === "object") {
      walkScriptLocal(value, visit);
    }
  }
}

function createEslintVueRule(options: {
  doctorId: string;
  eslintId: string;
  meta: DoctorRule["meta"];
}): DoctorRule {
  return createRule({
    meta: options.meta,
    create(ctx) {
      if (!ctx.file.isVueSfc) return;
      return {
        SFC() {
          const linter = new Linter({ configType: "flat" });
          const messages = linter.verify(
            ctx.file.text,
            [
              {
                name: "vue-doctor/eslint-plugin-vue",
                files: ["**/*.vue"],
                languageOptions: {
                  parser: vueParser as any,
                  ecmaVersion: "latest",
                  sourceType: "module",
                  parserOptions: {
                    parser: tsParser,
                    ecmaVersion: "latest",
                    sourceType: "module",
                  },
                },
                plugins: { vue: vuePlugin as any },
                rules: { [options.eslintId]: "error" },
              },
            ],
            { filename: ctx.file.relativePath },
          );

          for (const message of messages) {
            if (message.ruleId !== options.eslintId) continue;
            ctx.report({
              ruleId: options.doctorId,
              severity: options.meta.severity,
              category: options.meta.category,
              file: ctx.file.path,
              range: rangeFromLintMessage(ctx.file.text, message),
              message: delegatedMessages[options.doctorId] ?? message.message,
              suggestion: delegatedSuggestions[options.doctorId] ?? message.message,
              fix: message.fix
                ? {
                    kind: "suggestion",
                    message:
                      "eslint-plugin-vue can suggest a fix, but Vue Doctor does not classify it as safe.",
                    edits: [
                      {
                        range: { start: message.fix.range[0], end: message.fix.range[1] },
                        text: message.fix.text,
                      },
                    ],
                  }
                : null,
              tags: ["eslint-plugin-vue"],
            });
          }
        },
      };
    },
  });
}

function rangeFromLintMessage(source: string, message: AnyNode) {
  const start = offsetFromLineColumn(source, message.line, message.column);
  const end =
    message.endLine && message.endColumn
      ? offsetFromLineColumn(source, message.endLine, message.endColumn)
      : start;
  return { start, end, line: message.line, column: message.column };
}

function offsetFromLineColumn(source: string, line: number, column: number) {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < source.length) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return source.length;
    offset = next + 1;
    currentLine++;
  }
  return Math.min(source.length, offset + column - 1);
}
