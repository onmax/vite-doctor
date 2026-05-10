import { defineCollection, defineContentConfig, z } from "@nuxt/content";

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
