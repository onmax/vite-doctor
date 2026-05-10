import { createRule, type DoctorRule, type RuleContext, type RulePack } from "@vue-doctor/core";
import { relative } from "pathe";

type AnyNode = any;

const NUXT_AUTO_IMPORTS = new Set([
  "useFetch",
  "useAsyncData",
  "useRoute",
  "useRouter",
  "useRuntimeConfig",
  "useNuxtApp",
  "navigateTo",
  "definePageMeta",
  "defineNuxtRouteMiddleware",
  "useState",
]);
const BROWSER_SIDE_EFFECTS = new Set([
  "localStorage.setItem",
  "sessionStorage.setItem",
  "document.write",
  "document.title",
]);
const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "ResizeObserver",
  "IntersectionObserver",
]);
const NUXT_APP_DIRS = new Set([
  "assets",
  "components",
  "composables",
  "layouts",
  "middleware",
  "pages",
  "plugins",
  "utils",
]);

export const noExplicitAutoImport = createRule({
  meta: {
    id: "nuxt/imports/no-explicit-auto-import",
    title: "Avoid explicit imports of Nuxt auto-imports",
    category: "imports",
    severity: "info",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "#imports") return;
        const specifiers =
          node.specifiers?.filter((specifier: AnyNode) =>
            NUXT_AUTO_IMPORTS.has(specifier.imported?.name),
          ) ?? [];
        if (!specifiers.length) return;
        const all = specifiers.length === node.specifiers.length;
        ctx.report({
          ruleId: "nuxt/imports/no-explicit-auto-import",
          severity: "info",
          category: "imports",
          file: ctx.file.path,
          range: ctx.range(node),
          message:
            "This imports symbols that Nuxt already auto-imports. Keeping code auto-imported is the Nuxt default; configure this rule off if your team prefers explicit #imports.",
          suggestion: "Remove the explicit #imports import when all specifiers are auto-imported.",
          fix: all
            ? {
                kind: "safe",
                edits: [
                  {
                    range: {
                      start: node.start,
                      end: includeTrailingNewline(ctx.file.text, node.end),
                    },
                    text: "",
                  },
                ],
              }
            : null,
        });
      },
    };
  },
});

export const noConflictingUseFetchImport = createRule({
  meta: {
    id: "nuxt/imports/no-conflicting-usefetch-import",
    title: "Do not shadow Nuxt useFetch",
    category: "imports",
    severity: "error",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value === "#imports" || node.source?.value === "nuxt/app") return;
        for (const specifier of node.specifiers ?? []) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported?.name === "useFetch" &&
            specifier.local?.name === "useFetch"
          ) {
            ctx.report({
              ruleId: "nuxt/imports/no-conflicting-usefetch-import",
              severity: "error",
              category: "imports",
              file: ctx.file.path,
              range: ctx.range(specifier),
              message:
                "This imports useFetch from a non-Nuxt source and can shadow Nuxt's SSR-aware useFetch(). Rename it or use Nuxt's auto-import.",
              suggestion: "Rename imported useFetch to useVueUseFetch.",
              fix: {
                kind: "safe",
                message: "Rename imported useFetch to useVueUseFetch.",
                edits: [
                  {
                    range: { start: specifier.local.start, end: specifier.local.end },
                    text: "useVueUseFetch",
                  },
                ],
              },
            });
          }
        }
      },
    };
  },
});

export const noAutoImportCollision = createRule({
  meta: {
    id: "nuxt/imports/no-auto-import-collision",
    title: "Avoid auto-import name collisions",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    return {
      NuxtManifest(manifest) {
        const names = new Map<string, string[]>();
        for (const entry of manifest.autoImports.values()) {
          const key = entry.as ?? entry.name;
          names.set(key, [...(names.get(key) ?? []), entry.from]);
        }
        for (const [name, sources] of names) {
          const unique = [...new Set(sources)];
          if (unique.length > 1) {
            ctx.report({
              ruleId: "nuxt/imports/no-auto-import-collision",
              severity: "warn",
              category: "imports",
              file: ctx.file.path,
              message: `Auto-import '${name}' is provided by multiple sources: ${unique.join(", ")}.`,
              suggestion: "Alias module or app auto-imports to unique names.",
            });
          }
        }
      },
    };
  },
});

export const noRawFetchInSetup = createRule({
  meta: {
    id: "nuxt/fetch/no-raw-fetch-in-setup",
    title: "Use Nuxt data fetching primitives for SSR render data",
    category: "fetching",
    severity: "warn",
    fixable: false,
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    const appSurface =
      ctx.file.isVueSfc &&
      (ctx.file.inAppDir("pages") ||
        ctx.file.inAppDir("components") ||
        ctx.file.inAppDir("layouts"));
    if (!appSurface) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "AwaitExpression") return;
        const call = node.argument;
        const name = ctx.helpers.getCalleeName(call);
        if (name === "$fetch" || name === "fetch" || name === "axios.get") {
          report(
            ctx,
            call,
            "nuxt/fetch/no-raw-fetch-in-setup",
            "warn",
            "fetching",
            "This fetch runs in setup for SSR-rendered data. Use useFetch() or useAsyncData() to avoid duplicate fetching and hydration issues.",
            "Replace with await useFetch(...) or await useAsyncData(key, () => $fetch(...)).",
          );
        }
      },
    };
  },
});

export const noAwaitInsideCustomWrapper = createRule({
  meta: {
    id: "nuxt/fetch/no-await-inside-custom-wrapper",
    title: "Do not await inside custom useFetch/useAsyncData wrappers",
    category: "fetching",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (
          node.type === "AwaitExpression" &&
          ["useFetch", "useAsyncData"].includes(ctx.helpers.getCalleeName(node.argument) ?? "")
        ) {
          const text = ctx.file.text.slice(Math.max(0, node.start - 80), node.start);
          if (/function\s+use[A-Z]\w+|const\s+use[A-Z]\w+\s*=/.test(text)) {
            report(
              ctx,
              node,
              "nuxt/fetch/no-await-inside-custom-wrapper",
              "error",
              "fetching",
              "Custom wrappers around useFetch/useAsyncData should return the composable directly. Awaiting inside the wrapper can break Nuxt async context behavior.",
            );
          }
        }
      },
    };
  },
});

export const preferNuxtUseRoute = createRule({
  meta: {
    id: "nuxt/routing/prefer-nuxt-useroute",
    title: "Use Nuxt's useRoute in Nuxt app code",
    category: "routing",
    severity: "error",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ImportDeclaration(node: AnyNode) {
        if (node.source?.value !== "vue-router") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.imported?.name === "useRoute") {
            ctx.report({
              ruleId: "nuxt/routing/prefer-nuxt-useroute",
              severity: "error",
              category: "routing",
              file: ctx.file.path,
              range: ctx.range(specifier),
              message:
                "Nuxt wraps useRoute() so route state updates after page content changes. Do not import useRoute from vue-router in Nuxt app code.",
              suggestion: "Use Nuxt's auto-imported useRoute().",
            });
          }
        }
      },
    };
  },
});

export const noUseRouteInMiddleware = createRule({
  meta: {
    id: "nuxt/routing/no-useroute-in-middleware",
    title: "Use middleware to/from arguments instead of useRoute",
    category: "routing",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !ctx.file.relativePath.includes("/middleware/") &&
      !ctx.file.relativePath.startsWith("middleware/") &&
      !ctx.file.relativePath.startsWith("app/middleware/")
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "useRoute")) {
          report(
            ctx,
            node,
            "nuxt/routing/no-useroute-in-middleware",
            "error",
            "routing",
            "Route middleware receives to/from route arguments. useRoute() can point at the previous route in this context.",
          );
        }
      },
    };
  },
});

export const returnNavigateToInMiddleware = createRule({
  meta: {
    id: "nuxt/routing/return-navigateto-in-middleware",
    title: "Return navigateTo in route middleware",
    category: "routing",
    severity: "error",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !ctx.file.relativePath.includes("/middleware/") &&
      !ctx.file.relativePath.startsWith("middleware/") &&
      !ctx.file.relativePath.startsWith("app/middleware/")
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "navigateTo")) return;
        const fixStart =
          node.__doctorParent?.type === "AwaitExpression" ? node.__doctorParent.start : node.start;
        const before = ctx.file.text.slice(Math.max(0, fixStart - 20), fixStart);
        if (!/\breturn\s+$/.test(before)) {
          ctx.report({
            ruleId: "nuxt/routing/return-navigateto-in-middleware",
            severity: "error",
            category: "routing",
            file: ctx.file.path,
            range: ctx.range(node),
            message:
              "Route middleware must return navigateTo() so Nuxt can stop or redirect the navigation.",
            suggestion: "Add return before navigateTo().",
            fix: {
              kind: "safe",
              edits: [{ range: { start: fixStart, end: fixStart }, text: "return " }],
            },
          });
        }
      },
    };
  },
});

export const noRouterNavigationInSetup = createRule({
  meta: {
    id: "nuxt/routing/no-router-navigation-in-setup",
    title: "Do not navigate with router.push/replace during setup",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!["router.push", "router.replace"].includes(ctx.helpers.getCalleeName(node) ?? ""))
          return;
        if (ctx.file.isVueSfc && !ctx.helpers.isLikelyEventHandler(ctx.file.text, node.start)) {
          report(
            ctx,
            node,
            "nuxt/routing/no-router-navigation-in-setup",
            "warn",
            "routing",
            `${ctx.helpers.getCalleeName(node)}() appears to run during setup. Trigger navigation from a client event/lifecycle guard, route middleware, or use navigateTo() in universal contexts.`,
          );
        }
      },
    };
  },
});

export const noUseNuxtAppInNitro = createRule({
  meta: {
    id: "nuxt/context/no-usenuxtapp-in-nitro",
    title: "Do not use useNuxtApp in Nitro routes",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "useNuxtApp"))
          report(
            ctx,
            node,
            "nuxt/context/no-usenuxtapp-in-nitro",
            "error",
            "server",
            "useNuxtApp() is an app runtime composable and is not available in Nitro handlers. Use event-aware server utilities instead.",
          );
      },
    };
  },
});

export const noNavigateToInNitro = createRule({
  meta: {
    id: "nuxt/context/no-navigateto-in-nitro",
    title: "Do not use navigateTo in Nitro routes",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.isCall(node, "navigateTo"))
          report(
            ctx,
            node,
            "nuxt/context/no-navigateto-in-nitro",
            "error",
            "server",
            "navigateTo() is for Nuxt app navigation. Use sendRedirect(event, path) in Nitro handlers.",
          );
      },
    };
  },
});

export const noSecretInPublicConfig = createRule({
  meta: {
    id: "nuxt/runtime/no-secret-in-public-config",
    title: "Do not expose secrets in runtimeConfig.public",
    category: "runtime-config",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/nuxt\.config\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Property") return;
        const key = node.key?.name ?? node.key?.value;
        if (typeof key === "string" && /(secret|token|password|private|key)$/i.test(key)) {
          const nearby = ctx.file.text.slice(Math.max(0, node.start - 120), node.start);
          if (nearby.includes("public")) {
            report(
              ctx,
              node,
              "nuxt/runtime/no-secret-in-public-config",
              "error",
              "runtime-config",
              `runtimeConfig.public.${key} looks sensitive and will be exposed to the client. Move it to private runtimeConfig.`,
            );
          }
        }
      },
    };
  },
});

export const noBrowserSideEffectsInSetup = createRule({
  meta: {
    id: "nuxt/hydration/no-browser-side-effects-in-setup",
    title: "Avoid browser side effects in universal setup",
    category: "hydration",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || ctx.file.relativePath.includes(".client.")) return;
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name && BROWSER_SIDE_EFFECTS.has(name)) {
          if (ctx.helpers.isTypeOnlyContext(node)) return;
          if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
          report(
            ctx,
            node,
            "nuxt/hydration/no-browser-side-effects-in-setup",
            "error",
            "hydration",
            `${name} is a browser-only side effect in universal code. Move it to onMounted() or a client-only plugin.`,
          );
        }
      },
    };
  },
});

export const noBrowserGlobalInUniversalCode = createRule({
  meta: {
    id: "nuxt/hydration/no-browser-global-in-universal-code",
    title: "Avoid browser globals in universal code",
    category: "hydration",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath)
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || !BROWSER_GLOBALS.has(node.name)) return;
        if (
          isObjectPropertyKey(node) ||
          ctx.helpers.isTypeOnlyContext(node) ||
          ctx.helpers.isTypeofOperand(node) ||
          ctx.helpers.hasLocalBindingBefore(node, ctx.file.text) ||
          isKnownGuardedBrowserGlobal(ctx.file.text, node.start) ||
          ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
        )
          return;
        report(
          ctx,
          node,
          "nuxt/hydration/no-browser-global-in-universal-code",
          "error",
          "hydration",
          `${node.name} is browser-only and this file can run during SSR.`,
          replacementForBrowserGlobal(node.name),
        );
      },
    };
  },
});

export const noClientConditionalInTemplate = createRule({
  meta: {
    id: "nuxt/hydration/no-client-conditional-in-template",
    title: "Avoid client-only conditionals in SSR templates",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath)
    )
      return;
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement") return;
        const expressions = templateExpressions(node, ctx.file.text);
        if (
          !expressions.some((text) =>
            /\b(import\.meta\.client|process\.client|window|document|navigator)\b/.test(text),
          )
        )
          return;
        report(
          ctx,
          node,
          "nuxt/hydration/no-client-conditional-in-template",
          "warn",
          "hydration",
          "This template branches on client-only state during SSR and can hydrate to different markup.",
          "Prefer CSS breakpoints, <ClientOnly>, or initialize SSR-safe state before rendering.",
        );
      },
    };
  },
});

export const preferUseCookieForInitialClientState = createRule({
  meta: {
    id: "nuxt/hydration/prefer-usecookie-for-initial-client-state",
    title: "Use useCookie for SSR-visible browser preference state",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (
          !ctx.helpers.isCall(node) ||
          !["localStorage.getItem", "sessionStorage.getItem"].includes(
            ctx.helpers.getCalleeName(node) ?? "",
          )
        )
          return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        report(
          ctx,
          node,
          "nuxt/hydration/prefer-usecookie-for-initial-client-state",
          "warn",
          "hydration",
          "Reading browser storage for initial render state can mismatch SSR markup.",
          "Use useCookie() for user preference state that affects initial SSR-rendered UI.",
        );
      },
    };
  },
});

export const noTimeDependentRenderWithoutNuxtTimeOrClientOnly = createRule({
  meta: {
    id: "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
    title: "Use NuxtTime or ClientOnly for time-dependent rendering",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (
      !isNuxtRuntimeFile(ctx) ||
      isClientOnlyPath(ctx.file.relativePath) ||
      ctx.helpers.isNuxtServerFile(ctx.file.relativePath) ||
      /<\s*(NuxtTime|ClientOnly)\b/.test(ctx.file.text)
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "Date.now" && name !== "Math.random" && !isNewDate(node)) return;
        if (ctx.helpers.isTypeOnlyContext(node)) return;
        if (ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)) return;
        report(
          ctx,
          node,
          "nuxt/hydration/no-time-dependent-render-without-nuxttime-or-clientonly",
          "warn",
          "hydration",
          "Time-dependent values rendered during SSR can differ by the time the client hydrates.",
          "Use <NuxtTime>, useState() with a stable value, or <ClientOnly> for client-only time output.",
        );
      },
    };
  },
});

export const noRouteMiddlewareApiSecurity = createRule({
  meta: {
    id: "nuxt/middleware/no-route-middleware-api-security",
    title: "Route middleware does not secure API routes",
    category: "middleware",
    severity: "blocker",
    fixable: "suggestion",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    const hasServerHandlers =
      [...(ctx.project.nuxt?.serverDirs.api ?? []), ...(ctx.project.nuxt?.serverDirs.routes ?? [])]
        .length > 0;
    if (!hasServerHandlers) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const isMiddlewareFile =
          ctx.file.relativePath.startsWith("middleware/") ||
          ctx.file.relativePath.startsWith("app/middleware/") ||
          ctx.file.relativePath.includes("/middleware/");
        const hasRouteMiddleware =
          isMiddlewareFile || /defineNuxtRouteMiddleware|middleware\/.*auth/i.test(ctx.file.text);
        if (
          hasRouteMiddleware &&
          !/requireAuth|authorize|authGuard|protectRoute|getUserSession/i.test(ctx.file.text)
        ) {
          ctx.report({
            ruleId: "nuxt/middleware/no-route-middleware-api-security",
            severity: "blocker",
            category: "middleware",
            file: ctx.file.path,
            message:
              "Route middleware only protects app navigation. API/server routes need their own server-side auth checks.",
            suggestion: "Add auth checks inside server/api or server/routes handlers.",
          });
        }
      },
    };
  },
});

export const preferNuxtPageOverRouterView = createRule({
  meta: {
    id: "nuxt/routing/prefer-nuxtpage-over-routerview",
    title: "Use NuxtPage instead of RouterView",
    category: "routing",
    severity: "error",
    fixable: "safe",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || getElementName(node) !== "RouterView") return;
        ctx.report({
          ruleId: "nuxt/routing/prefer-nuxtpage-over-routerview",
          severity: "error",
          category: "routing",
          file: ctx.file.path,
          range: ctx.range(node),
          message: "<RouterView> bypasses NuxtPage behavior. Use <NuxtPage> in Nuxt app shells.",
          suggestion: "Replace <RouterView> with <NuxtPage>.",
          fix: simpleTagRenameFix(ctx.file.text, node, "NuxtPage"),
        });
      },
    };
  },
});

export const noRouteObjectPageKey = createRule({
  meta: {
    id: "nuxt/routing/no-route-object-page-key",
    title: "Do not use route objects as NuxtPage page keys",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    const reportNode = (node: AnyNode) =>
      report(
        ctx,
        node,
        "nuxt/routing/no-route-object-page-key",
        "warn",
        "routing",
        "Using the route object as a NuxtPage page key can diverge from Nuxt's Suspense-backed page lifecycle.",
        "Use a stable string key derived from route params or explicit page metadata.",
      );
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement" || getElementName(node) !== "NuxtPage") return;
        const snippet = sourceForNode(node, ctx.file.text);
        const pageKey =
          getDirectiveExpression(node, "bind", "page-key", ctx.file.text) ??
          getStaticAttr(node, "page-key");
        if (!/\bpage-key\b/.test(snippet) || !/\b(\$route|route)\b/.test(pageKey ?? snippet))
          return;
        reportNode(node);
      },
    };
  },
});

export const noHashSensitiveRouteFullpathInSsrMarkup = createRule({
  meta: {
    id: "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup",
    title: "Avoid route.fullPath in SSR markup",
    category: "routing",
    severity: "warn",
    fixable: "suggestion",
    requires: { template: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      TemplateNode(node: AnyNode) {
        if (node.type !== "VElement") return;
        if (
          !templateExpressions(node, ctx.file.text).some((text) =>
            /\b(\$route|route)\.fullPath\b/.test(text),
          )
        )
          return;
        report(
          ctx,
          node,
          "nuxt/routing/no-hash-sensitive-route-fullpath-in-ssr-markup",
          "warn",
          "routing",
          "route.fullPath can include URL fragments that are unavailable during SSR and can cause hydration drift.",
          "Use path, params, or query values that are available on both server and client.",
        );
      },
    };
  },
});

export const noLegacyProcessClientServer = createRule({
  meta: {
    id: "nuxt/context/no-legacy-process-client-server",
    title: "Use import.meta client/server flags",
    category: "context",
    severity: "warn",
    fixable: "safe",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getNodeName(node);
        if (name !== "process.client" && name !== "process.server") return;
        const replacement = name === "process.client" ? "import.meta.client" : "import.meta.server";
        ctx.report({
          ruleId: "nuxt/context/no-legacy-process-client-server",
          severity: "warn",
          category: "context",
          file: ctx.file.path,
          range: ctx.range(node),
          message: `${name} is a legacy Nuxt runtime flag in Nuxt 4 code.`,
          suggestion: `Use ${replacement}.`,
          fix: {
            kind: "safe",
            edits: [{ range: { start: node.start, end: node.end }, text: replacement }],
          },
        });
      },
    };
  },
});

export const preferAppDirectoryPlacement = createRule({
  meta: {
    id: "nuxt/project/prefer-app-directory-placement",
    title: "Place app directories under app/",
    category: "architecture",
    severity: "info",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    const [first] = ctx.file.relativePath.split("/");
    if (!first || !NUXT_APP_DIRS.has(first)) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report({
        ruleId: "nuxt/project/prefer-app-directory-placement",
        severity: "info",
        category: "architecture",
        file: ctx.file.path,
        message: `Nuxt 4 projects should place ${first}/ under app/${first}/.`,
        suggestion: `Move ${ctx.file.relativePath} under app/${ctx.file.relativePath}.`,
      });
    };
    return {
      SFC: reportOnce,
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});

export const noNestedAutoimportAssumption = createRule({
  meta: {
    id: "nuxt/composables/no-nested-autoimport-assumption",
    title: "Nested composables are not auto-imported by default",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (!/^app\/composables\/[^/]+\/.+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (isExplicitlyScannedByNuxt(ctx, "imports")) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report({
        ruleId: "nuxt/composables/no-nested-autoimport-assumption",
        severity: "warn",
        category: "imports",
        file: ctx.file.path,
        message: ctx.project.nuxt?.manifest?.hasManifest
          ? "This nested composable is not included in Nuxt's configured auto-import scan roots."
          : "Nuxt auto-imports top-level composables by default, not arbitrary nested files.",
        suggestion:
          "Move the composable to app/composables/, export it from an index file, or configure imports.dirs explicitly.",
      });
    };
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});

export const noVueOrNitroContextInShared = createRule({
  meta: {
    id: "nuxt/shared/no-vue-or-nitro-context-in-shared",
    title: "Keep shared code runtime-neutral",
    category: "architecture",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.file.relativePath.startsWith("shared/")) return;
    return {
      ImportDeclaration(node: AnyNode) {
        const source = String(node.source?.value ?? "");
        if (
          !["vue", "nuxt/app", "#app", "h3", "nitropack"].includes(source) &&
          !source.startsWith("#imports")
        )
          return;
        report(
          ctx,
          node,
          "nuxt/shared/no-vue-or-nitro-context-in-shared",
          "error",
          "architecture",
          "shared/ code should be usable by both the Vue app and Nitro server without app/runtime context.",
          "Move Vue composables to app/composables/, Nitro utilities to server/utils/, or keep shared/ pure.",
        );
      },
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (!name || !NUXT_AUTO_IMPORTS.has(name)) return;
        report(
          ctx,
          node,
          "nuxt/shared/no-vue-or-nitro-context-in-shared",
          "error",
          "architecture",
          "shared/ code should not call Nuxt app composables or Nitro context helpers.",
          "Move context-aware logic into app/ or server/ and keep shared/ utilities pure.",
        );
      },
    };
  },
});

export const noNestedSharedAutoimportAssumption = createRule({
  meta: {
    id: "nuxt/shared/no-nested-shared-autoimport-assumption",
    title: "Only shared utils and types are auto-imported",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (!/^shared\/(utils|types)\/[^/]+\/.+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (isExplicitlyScannedByNuxt(ctx, "shared")) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report({
        ruleId: "nuxt/shared/no-nested-shared-autoimport-assumption",
        severity: "warn",
        category: "imports",
        file: ctx.file.path,
        message: ctx.project.nuxt?.manifest?.hasManifest
          ? "This nested shared export is not included in Nuxt's configured shared scan roots."
          : "Nuxt only auto-imports shared/utils and shared/types entries by default, not arbitrary nested files.",
        suggestion:
          "Move the export to a top-level shared/utils or shared/types file, or import it explicitly.",
      });
    };
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});

export const noSubdirPluginAutoRegistrationAssumption = createRule({
  meta: {
    id: "nuxt/plugins/no-subdir-auto-registration-assumption",
    title: "Nested plugins are not auto-registered by default",
    category: "plugins",
    severity: "warn",
    fixable: "suggestion",
    requires: { nuxt: true },
  },
  create(ctx) {
    if (!/^app\/plugins\/[^/]+\/.+\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (/^app\/plugins\/[^/]+\/index\.[cm]?[jt]s$/.test(ctx.file.relativePath)) return;
    if (isExplicitPlugin(ctx)) return;
    let reported = false;
    const reportOnce = () => {
      if (reported) return;
      reported = true;
      ctx.report({
        ruleId: "nuxt/plugins/no-subdir-auto-registration-assumption",
        severity: "warn",
        category: "plugins",
        file: ctx.file.path,
        message: ctx.project.nuxt?.manifest?.hasManifest
          ? "This nested plugin is not included in Nuxt's configured plugin registration list."
          : "Nuxt auto-registers top-level plugin files and index files, not arbitrary nested plugin files.",
        suggestion:
          "Move this plugin to app/plugins/, rename it to an index file, or register it explicitly.",
      });
    };
    return {
      ScriptNode(node: AnyNode) {
        if (node.type === "Program") reportOnce();
      },
    };
  },
});

export const noNonSerializableUseState = createRule({
  meta: {
    id: "nuxt/state/no-nonserializable-usestate",
    title: "useState values must be serializable",
    category: "hydration",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useState")) return;
        const init = node.arguments?.[1];
        const text = init ? ctx.file.text.slice(init.start, init.end) : "";
        if (/new\s+(WebSocket|Map|Set|Date|RegExp)|=>\s*\([^)]*\)\s*=>|function\s*\(/.test(text)) {
          report(
            ctx,
            node,
            "nuxt/state/no-nonserializable-usestate",
            "error",
            "hydration",
            "useState() is serialized between server and client. Do not store functions, sockets, classes, Map/Set, or other non-serializable values.",
          );
        }
      },
    };
  },
});

export const requireStableAsyncDataKey = createRule({
  meta: {
    id: "nuxt/fetch/require-stable-asyncdata-key",
    title: "Use stable keys for async data payload entries",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useAsyncData") && !ctx.helpers.isCall(node, "useFetch"))
          return;
        const first = node.arguments?.[0];
        if (!first) return;
        if (first.type === "ArrowFunctionExpression" || first.type === "FunctionExpression") {
          report(
            ctx,
            node,
            "nuxt/fetch/require-stable-asyncdata-key",
            "warn",
            "fetching",
            "This keyed composable relies on a generated location key.",
            "Pass an explicit stable key before the data handler when data may be shared, prerendered, or wrapped.",
          );
          return;
        }
        if (!isStableKeyNode(first)) {
          report(
            ctx,
            first,
            "nuxt/fetch/require-stable-asyncdata-key",
            "warn",
            "fetching",
            "This async data key is dynamic and may not resolve to the same payload entry across builds or prerenders.",
            "Use a stable string key derived from route params or explicit inputs.",
          );
        }
      },
    };
  },
});

export const preferExplicitUseStateKeyInExportedComposables = createRule({
  meta: {
    id: "nuxt/state/prefer-explicit-usestate-key-in-exported-composables",
    title: "Use explicit useState keys in exported composables",
    category: "hydration",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/(^|\/)(composables|utils|shared)\//.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useState")) return;
        if (typeof node.arguments?.[0]?.value === "string") return;
        if (!isInsideExportedFunction(ctx.file.text, node.start)) return;
        report(
          ctx,
          node,
          "nuxt/state/prefer-explicit-usestate-key-in-exported-composables",
          "warn",
          "hydration",
          "Exported composables should not rely on generated useState keys because callsite location can change.",
          "Pass an explicit stable key as the first useState() argument.",
        );
      },
    };
  },
});

export const noComposableAfterAwait = createRule({
  meta: {
    id: "nuxt/context/no-composable-after-await",
    title: "Call Nuxt composables before await",
    category: "context",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx)) return;
    const composables = new Set([...NUXT_AUTO_IMPORTS, "useSeoMeta", "useHead", "useHeadSafe"]);
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (!name || !composables.has(name) || !hasPriorAwaitInSameExecutionScope(node)) return;
        report(
          ctx,
          node,
          "nuxt/context/no-composable-after-await",
          "error",
          "context",
          `${name}() is called after await in Nuxt context and may lose async context.`,
          "Call Nuxt composables before the first await or use Nuxt's compiler-aware data factories.",
        );
      },
    };
  },
});

export const preferEventFetch = createRule({
  meta: {
    id: "nuxt/server/prefer-event-fetch",
    title: "Use event.$fetch in Nitro handlers",
    category: "server",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "$fetch")) return;
        report(
          ctx,
          node,
          "nuxt/server/prefer-event-fetch",
          "warn",
          "server",
          "$fetch() in Nitro handlers does not automatically carry request event context.",
          "Use event.$fetch() when proxying to other server routes.",
        );
      },
    };
  },
});

export const forwardAuthHeadersSsr = createRule({
  meta: {
    id: "nuxt/fetch/forward-auth-headers-ssr",
    title: "Forward auth headers for SSR server fetches",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || isClientOnlyPath(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "$fetch")) return;
        const first = node.arguments?.[0];
        const url =
          first?.value ?? (first?.start != null ? ctx.file.text.slice(first.start, first.end) : "");
        if (!String(url).startsWith("/api/")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (/useRequestFetch|useFetch|headers\s*:|cookie/i.test(snippet)) return;
        report(
          ctx,
          node,
          "nuxt/fetch/forward-auth-headers-ssr",
          "warn",
          "fetching",
          "SSR $fetch() to an internal API route may omit request cookies and auth headers.",
          "Use useFetch(), useRequestFetch(), or forward selected headers explicitly.",
        );
      },
    };
  },
});

export const noPlainEnvInAppCode = createRule({
  meta: {
    id: "nuxt/runtime/no-plain-env-in-app-code",
    title: "Use runtimeConfig instead of process.env in app code",
    category: "runtime-config",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!isNuxtRuntimeFile(ctx) || ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (ctx.helpers.getNodeName(node) !== "process.env") return;
        report(
          ctx,
          node,
          "nuxt/runtime/no-plain-env-in-app-code",
          "error",
          "runtime-config",
          "process.env is not the public runtime contract for Nuxt app code.",
          "Expose values through runtimeConfig.public and read them with useRuntimeConfig().",
        );
      },
    };
  },
});

export const requireEventRuntimeConfigInServer = createRule({
  meta: {
    id: "nuxt/runtime/require-event-runtime-config-in-server",
    title: "Pass event to useRuntimeConfig in server handlers",
    category: "runtime-config",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useRuntimeConfig")) return;
        if (node.arguments?.length) return;
        report(
          ctx,
          node,
          "nuxt/runtime/require-event-runtime-config-in-server",
          "warn",
          "runtime-config",
          "Server handlers should read runtime config with the request event.",
          "Use useRuntimeConfig(event).",
        );
      },
    };
  },
});

export const noClientComposablesInServer = createRule({
  meta: {
    id: "nuxt/server/no-client-composables",
    title: "Do not use app composables in Nitro server files",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    const clientComposables = new Set([
      "useRoute",
      "useRouter",
      "useState",
      "useFetch",
      "useAsyncData",
      "useHead",
      "useSeoMeta",
    ]);
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (!name || !clientComposables.has(name)) return;
        report(
          ctx,
          node,
          "nuxt/server/no-client-composables",
          "error",
          "server",
          `${name}() is a Nuxt app composable and is not available in Nitro server files.`,
          "Use event-aware Nitro utilities in server handlers.",
        );
      },
    };
  },
});

export const noBrowserApiInServer = createRule({
  meta: {
    id: "nuxt/server/no-browser-api",
    title: "Do not use browser APIs in Nitro server files",
    category: "server",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Identifier" || !BROWSER_GLOBALS.has(node.name)) return;
        if (
          ctx.helpers.isTypeOnlyContext(node) ||
          ctx.helpers.hasLocalBindingBefore(node, ctx.file.text)
        )
          return;
        report(
          ctx,
          node,
          "nuxt/server/no-browser-api",
          "error",
          "server",
          `${node.name} is not available in Nitro server runtime.`,
          "Use request/event data, server utilities, or move browser work to app client code.",
        );
      },
    };
  },
});

export const preferCreateUseFetch = createRule({
  meta: {
    id: "nuxt/fetch/prefer-create-use-fetch",
    title: "Prefer Nuxt data factories for custom data composables",
    category: "fetching",
    severity: "info",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!/(^|\/)(composables|utils)\//.test(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useFetch") && !ctx.helpers.isCall(node, "useAsyncData"))
          return;
        if (!isInsideExportedFunction(ctx.file.text, node.start)) return;
        report(
          ctx,
          node,
          "nuxt/fetch/prefer-create-use-fetch",
          "info",
          "fetching",
          "Exported custom data composables should use Nuxt's compiler-aware data factories.",
          "Use createUseFetch() or createUseAsyncData() for reusable keyed data composables.",
        );
      },
    };
  },
});

export const createUseFetchMustBeExportedInScannedDir = createRule({
  meta: {
    id: "nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir",
    title: "Export data factories from scanned composable directories",
    category: "fetching",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "createUseFetch" && name !== "createUseAsyncData") return;
        const exported = /export\s+(const|function)\s+use[A-Z]\w+/.test(
          ctx.file.text.slice(Math.max(0, node.start - 120), node.start),
        );
        const scanned =
          ctx.file.relativePath.startsWith("app/composables/") &&
          !/^app\/composables\/[^/]+\/.+/.test(ctx.file.relativePath);
        if (exported && scanned) return;
        report(
          ctx,
          node,
          "nuxt/fetch/create-usefetch-must-be-exported-in-scanned-dir",
          "error",
          "fetching",
          "Nuxt data factories need to be exported from scanned composable files for compiler key injection.",
          "Export the factory from a top-level app/composables file or configure imports.dirs.",
        );
      },
    };
  },
});

export const keyedComposableRegistrationRequired = createRule({
  meta: {
    id: "nuxt/fetch/keyed-composable-registration-required",
    title: "Register custom keyed data composables",
    category: "fetching",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = ctx.helpers.getCalleeName(node);
        if (name !== "createUseFetch" && name !== "createUseAsyncData") return;
        const decl = ctx.file.text.slice(Math.max(0, node.start - 120), node.start);
        const match = decl.match(/use[A-Z]\w+/);
        const composable = match?.[0];
        if (composable && ctx.project.nuxt?.manifest?.keyedComposables.includes(composable)) return;
        report(
          ctx,
          node,
          "nuxt/fetch/keyed-composable-registration-required",
          "warn",
          "fetching",
          "Custom data factory composables should be registered for key injection.",
          "Add the composable name to Nuxt keyed composables configuration when it is not auto-detected.",
        );
      },
    };
  },
});

export const preferSeoComposables = createRule({
  meta: {
    id: "nuxt/seo/prefer-seo-composables",
    title: "Use Nuxt SEO composables for metadata",
    category: "seo",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/\b(title|description|ogTitle|ogDescription|meta)\b/.test(snippet)) return;
        report(
          ctx,
          node,
          "nuxt/seo/prefer-seo-composables",
          "warn",
          "seo",
          "SEO metadata is safer and better typed through Nuxt SEO composables.",
          "Use useSeoMeta() for SEO metadata and useHeadSafe() for untrusted values.",
        );
      },
    };
  },
});

export const noUnsafeUseHeadScript = createRule({
  meta: {
    id: "nuxt/security/no-unsafe-usehead-script",
    title: "Avoid unsafe scripts in useHead",
    category: "security",
    severity: "error",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/script\s*:|innerHTML|children\s*:/.test(snippet)) return;
        report(
          ctx,
          node,
          "nuxt/security/no-unsafe-usehead-script",
          "error",
          "security",
          "Scripts injected through useHead can bypass safer metadata restrictions.",
          "Use Nuxt Scripts for third-party scripts or useHeadSafe() for constrained head values.",
        );
      },
    };
  },
});

export const preferUseHeadSafeForUntrustedValues = createRule({
  meta: {
    id: "nuxt/security/prefer-useheadsafe-for-untrusted-values",
    title: "Use useHeadSafe for untrusted head values",
    category: "security",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "useHead")) return;
        const snippet = ctx.file.text.slice(node.start, node.end);
        if (!/(route\.|params|query|user|content|markdown|html)/i.test(snippet)) return;
        report(
          ctx,
          node,
          "nuxt/security/prefer-useheadsafe-for-untrusted-values",
          "warn",
          "security",
          "Head values derived from route, content, or user data should be constrained.",
          "Use useHeadSafe() or sanitize the value before passing it to useHead().",
        );
      },
    };
  },
});

export const rules: DoctorRule[] = [
  noExplicitAutoImport,
  noConflictingUseFetchImport,
  noAutoImportCollision,
  noRawFetchInSetup,
  noAwaitInsideCustomWrapper,
  preferCreateUseFetch,
  createUseFetchMustBeExportedInScannedDir,
  keyedComposableRegistrationRequired,
  preferNuxtUseRoute,
  noUseRouteInMiddleware,
  returnNavigateToInMiddleware,
  noRouterNavigationInSetup,
  noUseNuxtAppInNitro,
  noNavigateToInNitro,
  noComposableAfterAwait,
  preferEventFetch,
  forwardAuthHeadersSsr,
  noSecretInPublicConfig,
  noPlainEnvInAppCode,
  requireEventRuntimeConfigInServer,
  noClientComposablesInServer,
  noBrowserApiInServer,
  noBrowserSideEffectsInSetup,
  noBrowserGlobalInUniversalCode,
  noClientConditionalInTemplate,
  preferUseCookieForInitialClientState,
  noTimeDependentRenderWithoutNuxtTimeOrClientOnly,
  noRouteMiddlewareApiSecurity,
  preferNuxtPageOverRouterView,
  noRouteObjectPageKey,
  noHashSensitiveRouteFullpathInSsrMarkup,
  noLegacyProcessClientServer,
  preferAppDirectoryPlacement,
  noNestedAutoimportAssumption,
  noVueOrNitroContextInShared,
  noNestedSharedAutoimportAssumption,
  noSubdirPluginAutoRegistrationAssumption,
  noNonSerializableUseState,
  requireStableAsyncDataKey,
  preferExplicitUseStateKeyInExportedComposables,
  preferSeoComposables,
  noUnsafeUseHeadScript,
  preferUseHeadSafeForUntrustedValues,
];

export const nuxtRulePack: RulePack = {
  name: "nuxt-doctor/nuxt",
  version: "0.0.0",
  rules,
  presets: {
    nuxt: rules.map((rule) => rule.meta.id),
    "nuxt-strict": rules.map((rule) => rule.meta.id),
    "opinionated-navigation": ["nuxt/routing/no-router-navigation-in-setup"],
  },
};

export default nuxtRulePack;

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

function hasPriorAwaitInSameExecutionScope(node: AnyNode): boolean {
  const scope = nearestFunctionOrProgram(node);
  if (!scope) return false;
  let seenTarget = false;
  let seenAwait = false;
  walkScriptLocal(scope.body ?? scope, (current) => {
    if (current === node) {
      seenTarget = true;
      return;
    }
    if (!seenTarget && current.type === "AwaitExpression") seenAwait = true;
  });
  return seenAwait;
}

function nearestFunctionOrProgram(node: AnyNode): AnyNode {
  let current = node;
  while (current) {
    if (
      ["Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
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

function includeTrailingNewline(text: string, end: number) {
  return text[end] === "\r" && text[end + 1] === "\n"
    ? end + 2
    : text[end] === "\n"
      ? end + 1
      : end;
}

function isClientOnlyPath(path: string) {
  return /\.client\.[cm]?[jt]sx?$/.test(path) || path.includes(".client.vue");
}

function isNuxtRuntimeFile(ctx: any) {
  if (ctx.file.sourceKind === "module") return false;
  const roots = ctx.project.nuxt?.appRoots;
  if (!roots?.length) return true;
  const relativeRoots = roots
    .map((root: string) => toPosixPath(relative(ctx.project.root, root)))
    .filter((root: string) => root && root !== ".");
  if (!relativeRoots.length) return true;
  const relativePath = toPosixPath(ctx.file.relativePath);
  return relativeRoots.some(
    (root: string) => relativePath === root || relativePath.startsWith(`${root}/`),
  );
}

function toPosixPath(path: string) {
  return path.replace(/\\/g, "/");
}

function isObjectPropertyKey(node: AnyNode) {
  const parent = node.parent ?? node.__doctorParent;
  return (
    (parent?.type === "Property" &&
      ((parent.key === node && !parent.computed) || parent.shorthand)) ||
    (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent?.type === "StaticMemberExpression" && parent.property === node)
  );
}

function isKnownGuardedBrowserGlobal(text: string, offset: number) {
  const before = text.slice(Math.max(0, offset - 80), offset);
  return /import\.meta\.client|process\.client|typeof\s+(window|document|localStorage|sessionStorage|navigator)\s*!==?\s*["']undefined["']/.test(
    before,
  );
}

function replacementForBrowserGlobal(name: string) {
  if (name === "localStorage" || name === "sessionStorage")
    return "Use useCookie() for SSR-visible preference state, or read browser storage inside onMounted().";
  if (name === "window" || name === "document")
    return "Use <ClientOnly>, onMounted(), or a .client plugin for browser-only DOM work.";
  return "Guard this with import.meta.client or move it to client-only code.";
}

function templateExpressions(node: AnyNode, source: string): string[] {
  const values: string[] = [];
  for (const attr of node.startTag?.attributes ?? []) {
    const expression = attr.value?.expression;
    if (expression?.start != null && expression?.end != null)
      values.push(String(expression.raw ?? source.slice(expression.start, expression.end)));
  }
  if (node.type === "VExpressionContainer" && node.expression)
    values.push(
      String(
        node.expression.raw ??
          (node.expression.start != null && node.expression.end != null
            ? source.slice(node.expression.start, node.expression.end)
            : ""),
      ),
    );
  const nodeSource = sourceForNode(node, source);
  if (nodeSource) values.push(nodeSource);
  return values;
}

function sourceForNode(node: AnyNode, source: string) {
  const start = node.start ?? node.range?.[0];
  const end = node.end ?? node.range?.[1];
  return typeof start === "number" && typeof end === "number" ? source.slice(start, end) : "";
}

function getElementName(node: AnyNode) {
  return node.rawName ?? node.name;
}

function getDirectiveExpression(node: AnyNode, name: string, argument: string, source: string) {
  const attr = (node.startTag?.attributes ?? []).find(
    (item: AnyNode) =>
      item.directive && item.key?.name?.name === name && item.key?.argument?.name === argument,
  );
  const expression = attr?.value?.expression;
  if (!expression) return null;
  const start = expression.start ?? expression.range?.[0];
  const end = expression.end ?? expression.range?.[1];
  return expression.raw ?? (start != null && end != null ? source.slice(start, end) : null);
}

function getStaticAttr(node: AnyNode, name: string) {
  const attr = (node.startTag?.attributes ?? []).find(
    (item: AnyNode) => !item.directive && item.key?.name === name,
  );
  return attr?.value?.value ?? null;
}

function simpleTagRenameFix(text: string, node: AnyNode, replacement: string) {
  const start = node.start;
  const end = node.end;
  if (typeof start !== "number" || typeof end !== "number") return null;
  const snippet = text.slice(start, end);
  const replaced = snippet
    .replaceAll("RouterView", replacement)
    .replaceAll("router-view", replacement);
  return {
    kind: "safe" as const,
    edits: [{ range: { start, end }, text: replaced }],
  };
}

function isNewDate(node: AnyNode) {
  return node.type === "NewExpression" && node.callee?.name === "Date";
}

function isStableKeyNode(node: AnyNode) {
  return node.type === "Literal" || node.type === "TemplateLiteral";
}

function isInsideExportedFunction(text: string, offset: number) {
  const before = text.slice(Math.max(0, offset - 260), offset);
  return /export\s+(async\s+)?function\s+use[A-Z]\w+|export\s+const\s+use[A-Z]\w+\s*=/.test(before);
}

function isExplicitlyScannedByNuxt(ctx: RuleContext, kind: "imports" | "shared") {
  const manifest = ctx.project.nuxt?.manifest;
  if (!manifest?.hasManifest) return false;
  const roots = kind === "imports" ? manifest.importsDirs : manifest.sharedScanRoots;
  const relativePath = toPosixPath(relative(ctx.project.root, ctx.file.path));
  return roots
    .map((root) => toPosixPath(relative(ctx.project.root, root)))
    .filter(Boolean)
    .filter((root) =>
      kind === "imports"
        ? root !== "app/composables" && root !== "composables"
        : root !== "shared/utils" && root !== "shared/types",
    )
    .some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}

function isExplicitPlugin(ctx: RuleContext) {
  const manifest = ctx.project.nuxt?.manifest;
  if (!manifest?.hasManifest) return false;
  return manifest.pluginFiles.some((file) => resolveSameFile(file, ctx.file.path));
}

function resolveSameFile(a: string, b: string) {
  return toPosixPath(a) === toPosixPath(b);
}
