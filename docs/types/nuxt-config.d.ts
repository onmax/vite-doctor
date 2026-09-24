import "nuxt/schema";

declare module "nuxt/schema" {
  interface NuxtConfig {
    icon?: {
      clientBundle?: { icons?: string[] };
    };
    content?: {
      database?: { type: "sqlite"; filename: string };
      _localDatabase?: { type: "sqlite"; filename: string };
    };
    nitro?: {
      preset?: string;
      sourceMap?: boolean;
      prerender?: { concurrency?: number; routes?: string[] };
      cloudflare?: { nodeCompat?: boolean };
    };
    routeRules?: Record<string, { prerender?: boolean; headers?: Record<string, string> }>;
    future?: { compatibilityVersion?: 4 | 5 };
    optimization?: { keyedComposables?: Array<{ name: string; argumentLength: number }> };
  }
}
