import { expect, test } from "vite-plus/test";
import { nitroRulePack } from "../../src/rule-packs/nitro/index.js";
import nuxtRulePack from "../../src/rule-packs/nuxt/rules/nuxt/index.js";
import { getRuleDocuments, rulesCollectionSource } from "./source.js";

test("Strict-only Nitro rule pages run the rule through the Strict Preset", async () => {
  const recommended = new Set(nitroRulePack.presets.recommended);
  const strictOnly = (nitroRulePack.presets.strict ?? []).filter((id) => !recommended.has(id));
  expect(strictOnly).toContain("nitro/structure/prefer-server-utils");

  for (const rule of getRuleDocuments().filter((item) => item.framework === "nitro")) {
    const markdown = await rulesCollectionSource.getItem(rule.key);
    const command = strictOnly.includes(rule.id)
      ? `pnpm vite-doctor . --framework nitro --extends auto,nitro/strict --rules ${rule.id}`
      : `pnpm vite-doctor . --framework nitro --rules ${rule.id}`;
    expect(markdown, rule.id).toContain(command);
  }
});

test("Strict-only Nuxt rule commands survive combined preset discovery", async () => {
  const recommended = new Set(nuxtRulePack.presets.recommended);
  const strictOnly = (nuxtRulePack.presets.strict ?? []).filter((id) => !recommended.has(id));
  expect(strictOnly).toContain("nuxt/structure/no-stateless-composable");
  for (const rule of getRuleDocuments().filter((item) => strictOnly.includes(item.id))) {
    const markdown = await rulesCollectionSource.getItem(rule.key);
    expect(markdown, rule.id).toContain(
      `pnpm nuxt doctor --extends auto,nuxt/strict --rules ${rule.id}`,
    );
  }
});
