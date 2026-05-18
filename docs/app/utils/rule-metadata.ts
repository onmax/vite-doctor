export type Framework = "vue" | "vite" | "nuxt" | "nitro";
export type FrameworkFilter = Framework | "all";
export type Severity = "error" | "warn" | "info";
export type FixKind = "safe" | "suggestion" | "no";

export const FRAMEWORK_META: Record<Framework, { label: string; pack: string; icon: string }> = {
  vue: {
    label: "Vue",
    pack: "vite-doctor/vue",
    icon: "i-logos-vue",
  },
  vite: {
    label: "Vite",
    pack: "vite-doctor/vite",
    icon: "i-logos-vitejs",
  },
  nuxt: {
    label: "Nuxt",
    pack: "vite-doctor/nuxt",
    icon: "i-logos-nuxt-icon",
  },
  nitro: {
    label: "Nitro",
    pack: "vite-doctor/nitro",
    icon: "i-unjs-nitro",
  },
};

export const FRAMEWORKS = Object.keys(FRAMEWORK_META) as Framework[];

const CATEGORY_LABELS: Record<string, string> = {
  "app-config": "App config",
  architecture: "Architecture",
  assets: "Assets",
  auth: "Authentication",
  "browser-api": "Browser APIs",
  cache: "Caching",
  composables: "Composables",
  computed: "Computed",
  content: "Content",
  context: "Context",
  configuration: "Configuration",
  fetch: "Data fetching",
  fetching: "Data fetching",
  hydration: "Hydration & SSR",
  hmr: "HMR",
  images: "Images",
  imports: "Imports",
  layers: "Layers",
  lifecycle: "Lifecycle",
  links: "Links",
  middleware: "Middleware",
  plugin: "Plugins",
  plugins: "Plugins",
  project: "Project",
  reactivity: "Reactivity",
  request: "Request",
  routing: "Routing",
  runtime: "Runtime config",
  "runtime-config": "Runtime config",
  scripts: "Scripts",
  security: "Security",
  seo: "SEO",
  server: "Server",
  shared: "Shared",
  ssr: "SSR safety",
  state: "State",
  style: "Style",
  template: "Template",
  ui: "UI",
  worker: "Workers",
  workers: "Workers",
  watch: "Watchers",
  watchers: "Watchers",
};

export function categoryLabel(slug: string) {
  return CATEGORY_LABELS[slug] ?? slug.replace(/-/g, " ");
}

export function packLabel(pack: string) {
  return pack.replace(/^vite-doctor\//, "");
}

export function frameworkOfPack(pack: string): Framework {
  if (pack === "vite-doctor/nitro") return "nitro";
  if (pack === "vite-doctor/vue") return "vue";
  if (pack === "vite-doctor/vite") return "vite";
  return "nuxt";
}

export function ruleNameParts(ruleId: string) {
  return ruleId.split(/([:/])/g).filter(Boolean);
}

export function ruleNamePartClass(part: string, index: number, parts: string[] = []) {
  if (part === "/" || part === ":") return "text-neutral-400 dark:text-neutral-600";
  if (index === 0) return "text-indigo-600 dark:text-indigo-400";
  if (index < parts.length - 1) return categoryNameClass(part);
  return "text-neutral-800 dark:text-neutral-100";
}

export function categoryNameClass(category: string) {
  return (
    {
      auth: "text-purple-600 dark:text-purple-400",
      cache: "text-orange-600 dark:text-orange-400",
      context: "text-violet-600 dark:text-violet-400",
      fetch: "text-sky-600 dark:text-sky-400",
      hydration: "text-cyan-600 dark:text-cyan-400",
      imports: "text-teal-600 dark:text-teal-400",
      request: "text-emerald-600 dark:text-emerald-400",
      runtime: "text-amber-600 dark:text-amber-400",
      security: "text-rose-600 dark:text-rose-400",
      server: "text-emerald-600 dark:text-emerald-400",
      state: "text-blue-600 dark:text-blue-400",
      ui: "text-pink-600 dark:text-pink-400",
    }[category] ?? "text-teal-600 dark:text-teal-400"
  );
}

export function severityIcon(severity: Severity) {
  return {
    error: "i-lucide-circle-alert",
    warn: "i-lucide-triangle-alert",
    info: "i-lucide-info",
  }[severity];
}

export function severityClass(severity: Severity) {
  return {
    error: "text-rose-600 dark:text-rose-400",
    warn: "text-amber-600 dark:text-amber-400",
    info: "text-sky-600 dark:text-sky-400",
  }[severity];
}

export function severityBadgeColor(severity: Severity | string) {
  if (severity === "error") return "error";
  if (severity === "warn") return "warning";
  return "info";
}

export function fixLabel(fix: FixKind | string | undefined) {
  if (fix === "safe") return "Auto-fix";
  if (fix === "suggestion") return "Suggestion";
  return "No fix";
}

export function fixIcon(fix: FixKind) {
  if (fix === "safe") return "i-lucide-wand-sparkles";
  if (fix === "suggestion") return "i-lucide-plug";
  return "i-lucide-plug-zap";
}

export function fixClass(fix: FixKind) {
  if (fix === "safe") return "text-emerald-600 dark:text-emerald-400";
  if (fix === "suggestion") return "text-teal-600 dark:text-teal-400";
  return "text-neutral-300 dark:text-neutral-700";
}

export function fixBadgeColor(fix: FixKind | string | undefined) {
  if (fix === "safe") return "success";
  if (fix === "suggestion") return "primary";
  return "neutral";
}
