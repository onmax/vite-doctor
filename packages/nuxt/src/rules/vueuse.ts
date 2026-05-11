import { createRule, type DoctorRule, type RulePack } from "@vue-doctor/core";

type AnyNode = any;

const VUEUSE_BROWSER_COMPOSABLES = new Set([
  "useEventListener",
  "useIntersectionObserver",
  "useResizeObserver",
  "useMutationObserver",
  "useTimeoutFn",
  "useIntervalFn",
  "useRafFn",
  "useStorage",
  "useSessionStorage",
  "useScroll",
  "useElementBounding",
  "useWindowSize",
]);

const VUEUSE_TIMER_REPLACEMENTS: Record<string, string> = {
  setTimeout: "useTimeoutFn",
  "window.setTimeout": "useTimeoutFn",
  setInterval: "useIntervalFn",
  "window.setInterval": "useIntervalFn",
  requestAnimationFrame: "useRafFn",
  "window.requestAnimationFrame": "useRafFn",
};

const VUEUSE_OBSERVER_REPLACEMENTS: Record<string, string> = {
  IntersectionObserver: "useIntersectionObserver",
  ResizeObserver: "useResizeObserver",
  MutationObserver: "useMutationObserver",
};

export const preferUseWindowSize = createRule({
  meta: {
    id: "vueuse/prefer-usewindow-size",
    title: "Use useWindowSize for reactive viewport size",
    category: "hydration",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getNodeName(node);
        if (name !== "window.innerWidth" && name !== "window.innerHeight") return;
        if (ctx.helpers.isTypeOnlyContext(node)) return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-usewindow-size",
          severity: "info",
          category: "hydration",
          message: "Raw window size reads are not reactive and are browser-only.",
          suggestion: "Use VueUse useWindowSize() when @vueuse/core is installed.",
        });
      },
    };
  },
});

export const preferUseBreakpoints = createRule({
  meta: {
    id: "vueuse/prefer-usebreakpoints",
    title: "Use useBreakpoints for responsive state",
    category: "hydration",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getNodeName(node);
        if (name !== "window.matchMedia" && name !== "matchMedia") return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-usebreakpoints",
          severity: "info",
          category: "hydration",
          message: "Raw media query reads are browser-only and not semantic app state.",
          suggestion: "Use VueUse useBreakpoints() for responsive state.",
        });
      },
    };
  },
});

export const preferUseClipboard = createRule({
  meta: {
    id: "vueuse/prefer-useclipboard",
    title: "Use useClipboard for clipboard access",
    category: "browser-api",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.getCalleeName(node) !== "navigator.clipboard.writeText") return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-useclipboard",
          severity: "info",
          category: "browser-api",
          message: "Raw clipboard access is easier to model through a composable.",
          suggestion: "Use VueUse useClipboard() in event-driven client code.",
        });
      },
    };
  },
});

export const preferUseEventListener = createRule({
  meta: {
    id: "vueuse/prefer-useevent-listener",
    title: "Use useEventListener for DOM events",
    category: "browser-api",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!shouldCheckVueUsePreference(ctx, node)) return;
        const callee = getCalleeName(node);
        const name = getNodeName(node);
        if (
          callee !== "addEventListener" &&
          callee !== "window.addEventListener" &&
          callee !== "document.addEventListener" &&
          !isEventListenerCalleeNode(name, node)
        )
          return;
        if (isWithinVueUseComposable(node)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-useevent-listener",
          severity: "info",
          category: "browser-api",
          message: `${callee || name} requires manual lifecycle cleanup.`,
          suggestion: "Use VueUse useEventListener() to bind and clean up DOM events.",
        });
      },
    };
  },
});

export const preferUseObservers = createRule({
  meta: {
    id: "vueuse/prefer-use-observers",
    title: "Use VueUse observer composables",
    category: "browser-api",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!shouldCheckVueUsePreference(ctx, node)) return;
        if (node.type !== "NewExpression") return;
        const observer = ctx.helpers.getNodeName(node.callee);
        const replacement = observer ? VUEUSE_OBSERVER_REPLACEMENTS[observer] : null;
        if (!replacement || isWithinVueUseComposable(node)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-use-observers",
          severity: "info",
          category: "browser-api",
          message: `${observer} requires manual lifecycle cleanup.`,
          suggestion: `Use VueUse ${replacement}() for reactive observer cleanup.`,
        });
      },
    };
  },
});

export const preferUseTimers = createRule({
  meta: {
    id: "vueuse/prefer-use-timers",
    title: "Use VueUse timer composables",
    category: "lifecycle",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!shouldCheckVueUsePreference(ctx, node)) return;
        const callee = ctx.helpers.getCalleeName(node);
        const replacement = callee ? VUEUSE_TIMER_REPLACEMENTS[callee] : null;
        if (!replacement || isWithinVueUseComposable(node)) return;
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-use-timers",
          severity: "info",
          category: "lifecycle",
          message: `${callee} is easier to clean up through a composable.`,
          suggestion: `Use VueUse ${replacement}() for lifecycle-aware timing.`,
        });
      },
    };
  },
});

export const preferUseStorage = createRule({
  meta: {
    id: "vueuse/prefer-use-storage",
    title: "Use VueUse storage composables",
    category: "browser-api",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!shouldCheckVueUsePreference(ctx, node)) return;
        const name = ctx.helpers.getNodeName(node);
        if (name !== "localStorage" && name !== "sessionStorage") return;
        if (ctx.helpers.isTypeofOperand?.(node) || isWithinVueUseComposable(node)) return;
        const replacement = name === "sessionStorage" ? "useSessionStorage" : "useStorage";
        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-use-storage",
          severity: "info",
          category: "browser-api",
          message: `${name} is browser-only and imperative.`,
          suggestion: `Use VueUse ${replacement}() for reactive client storage state.`,
        });
      },
    };
  },
});

export const preferUseScrollAndElement = createRule({
  meta: {
    id: "vueuse/prefer-use-scroll-and-element",
    title: "Use VueUse scroll and element composables",
    category: "browser-api",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!shouldCheckVueUsePreference(ctx, node)) return;
        if (isWithinVueUseComposable(node)) return;

        const name = ctx.helpers.getNodeName(node);
        const callee = ctx.helpers.getCalleeName(node);
        let replacement: string | null = null;

        if (name === "window.scrollX" || name === "window.scrollY") replacement = "useScroll";
        if (
          callee === "window.scrollTo" ||
          callee === "window.scrollBy" ||
          callee === "scrollTo" ||
          callee === "scrollBy"
        )
          replacement = "useScroll";
        if (
          callee === "getBoundingClientRect" ||
          callee === "Element.getBoundingClientRect" ||
          callee?.endsWith(".getBoundingClientRect")
        )
          replacement = "useElementBounding";
        if (!replacement) return;

        ctx.helpers.report(ctx, node, {
          ruleId: "vueuse/prefer-use-scroll-and-element",
          severity: "info",
          category: "browser-api",
          message: `${callee || name} is browser-only and imperative.`,
          suggestion: `Use VueUse ${replacement}() for reactive browser state.`,
        });
      },
    };
  },
});

export const noVueUseNuxtAutoImportCollision = createRule({
  meta: {
    id: "vueuse/no-nuxt-auto-import-collision",
    title: "Avoid VueUse names that collide with Nuxt auto-imports",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const colliding = new Set(["useFetch", "useCookie", "useHead", "useStorage", "useImage"]);
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "@vueuse/core" && node.source?.value !== "@vueuse/nuxt") return;
        for (const specifier of node.specifiers ?? []) {
          const name = specifier.imported?.name;
          if (!colliding.has(name)) continue;
          ctx.helpers.report(ctx, specifier, {
            ruleId: "vueuse/no-nuxt-auto-import-collision",
            severity: "warn",
            category: "imports",
            message: `${name} collides with a Nuxt built-in name.`,
            suggestion: `Alias the VueUse import, or prefer Nuxt's ${name} when you need Nuxt runtime semantics.`,
          });
        }
      },
    };
  },
});

export const rules: DoctorRule[] = [
  preferUseWindowSize,
  preferUseBreakpoints,
  preferUseClipboard,
  preferUseEventListener,
  preferUseObservers,
  preferUseTimers,
  preferUseStorage,
  preferUseScrollAndElement,
  noVueUseNuxtAutoImportCollision,
];

export const vueUseRulePack: RulePack = {
  name: "nuxt-doctor/vueuse",
  version: "0.0.0",
  activation: { nuxt: ">=4", packages: ["@vueuse/core"] },
  rules,
  presets: { recommended: rules.map((rule) => rule.meta.id) },
};

export default vueUseRulePack;

function shouldCheckVueUsePreference(ctx: any, node: AnyNode) {
  if (ctx.helpers.isTypeOnlyContext(node)) return false;
  if (isSkippedNuxtVueUsePath(ctx.file.relativePath, ctx.file.text)) return false;
  return true;
}

function isSkippedNuxtVueUsePath(relativePath: string, text: string) {
  if (
    relativePath.includes(".client.") ||
    /\.(md|mdc|markdown)$/.test(relativePath) ||
    /^(content|server|app\/server|shared\/types|generated|app\/generated|cli|packages|connector|docs)\//.test(
      relativePath,
    )
  )
    return true;
  if (/^\s*\/\/\s*@generated/m.test(text)) return true;
  return false;
}

function isWithinVueUseComposable(node: AnyNode) {
  let current = node;
  while (current) {
    if (current.type === "CallExpression" && VUEUSE_BROWSER_COMPOSABLES.has(getCalleeName(current)))
      return true;
    current = current.__doctorParent ?? current.parent;
  }
  return false;
}

function getCalleeName(node: AnyNode) {
  return getNodeName(node?.callee);
}

function getNodeName(node: AnyNode): string {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  if (node.type === "StaticMemberExpression" || node.type === "MemberExpression") {
    const object = getNodeName(node.object);
    const property = getNodeName(node.property);
    return object && property ? `${object}.${property}` : object || property;
  }
  return "";
}

function isEventListenerCalleeNode(name: string | null, node: AnyNode) {
  if (
    name !== "addEventListener" &&
    name !== "window.addEventListener" &&
    name !== "document.addEventListener"
  )
    return false;
  const parent = node.__doctorParent ?? node.parent;
  return parent?.type === "CallExpression" && parent.callee === node;
}
