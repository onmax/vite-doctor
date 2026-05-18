import { defineCollection, defineCollectionSource, defineContentConfig, z } from "@nuxt/content";
import { diagnosticsCollectionSource, rulesCollectionSource } from "./rules/source.js";

const docsSchema = z.object({
  links: z
    .array(
      z.object({
        label: z.string(),
        icon: z.string(),
        to: z.string(),
        target: z.string().optional(),
      }),
    )
    .optional(),
});

export default defineContentConfig({
  collections: {
    rules: defineCollection({
      type: "page",
      source: defineCollectionSource(rulesCollectionSource),
      schema: z.object({
        ruleId: z.string(),
        why: z.string(),
        recommendedReplacement: z.string(),
        pack: z.string(),
        severity: z.enum(["error", "warn", "info"]),
        category: z.string(),
        fix: z.enum(["safe", "suggestion", "no"]),
        framework: z.enum(["vue", "vite", "nuxt", "nitro"]),
        source: z.string(),
        sourceUrl: z.string(),
        docsUrl: z.string().optional(),
      }),
    }),
    diagnostics: defineCollection({
      type: "page",
      source: defineCollectionSource(diagnosticsCollectionSource),
      schema: z.object({
        code: z.string(),
        why: z.string(),
        fix: z.string(),
        ruleId: z.string(),
        pack: z.string(),
        severity: z.enum(["error", "warn", "info"]),
        category: z.string(),
        framework: z.enum(["vue", "vite", "nuxt", "nitro"]),
        source: z.string(),
        sourceUrl: z.string(),
      }),
    }),
    landing: defineCollection({
      type: "page",
      source: {
        cwd: "content",
        include: "index.md",
      },
    }),
    docs: defineCollection({
      type: "page",
      source: {
        cwd: "content",
        include: "**",
        prefix: "/",
        exclude: ["index.md"],
      },
      schema: docsSchema,
    }),
  },
});
