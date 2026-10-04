import { createRule } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

export const noAutoImportCollision = createRule({
  meta: {
    id: "nuxt/imports/no-auto-import-collision",
    title: "Avoid auto-import name collisions",
    category: "imports",
    severity: "warn",
    fixable: "suggestion",
    execution: "manifest",
    docsUrl: "https://nuxt.com/docs/4.x/guide/concepts/auto-imports#directory-based-auto-imports",
    requires: { nuxt: true, crossFile: true },
  },
  create(ctx) {
    return {
      NuxtManifest(manifest) {
        const names = new Map<string, NonNullable<typeof manifest.autoImportEntries>>();
        for (const entry of manifest.autoImportEntries ?? manifest.autoImports.values()) {
          if (entry.type || (entry as { disabled?: boolean }).disabled) continue;
          const key = entry.as ?? entry.name;
          names.set(key, [...(names.get(key) ?? []), entry]);
        }
        for (const [name, entries] of names) {
          const highestPriority = Math.max(...entries.map((entry) => entry.priority ?? 1));
          const unique = [
            ...new Set(
              entries
                .filter((entry) => (entry.priority ?? 1) === highestPriority)
                .map((entry) => entry.from),
            ),
          ];
          if (unique.length > 1) {
            ctx.report(
              diagnostics.NUXT0034({
                why: `Auto-import '${name}' is provided by multiple sources: ${unique.join(", ")}.`,
                fix: "Alias module or app auto-imports to unique names.",
              }),
              {
                ruleId: "nuxt/imports/no-auto-import-collision",
                severity: "warn",
                category: "imports",
                file: ctx.file.path,
              },
            );
          }
        }
      },
    };
  },
});
