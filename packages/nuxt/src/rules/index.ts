import { defineDoctorExtension, type DoctorExtension, type RulePack } from "@vue-doctor/core";
import { nitroRulePack } from "nitro-doctor";
import { vueRulePack } from "vue-doctor";
import nuxtRulePack from "./nuxt.js";
import nuxtContentRulePack from "./nuxt-content.js";
import nuxtUiRulePack from "./nuxt-ui.js";
import nuxtScriptsRulePack from "./nuxt-scripts.js";
import vueUseRulePack from "./vueuse.js";
import nuxtBetterAuthRulePack from "./nuxt-better-auth.js";
import nuxtImageRulePack from "./nuxt-image.js";
import nuxtHubRulePack from "./nuxthub.js";
import docusRulePack from "./docus.js";

export {
  nitroRulePack,
  nuxtRulePack,
  nuxtContentRulePack,
  nuxtUiRulePack,
  nuxtScriptsRulePack,
  vueUseRulePack,
  nuxtBetterAuthRulePack,
  nuxtImageRulePack,
  nuxtHubRulePack,
  docusRulePack,
};

export function nuxtRulePacks(extraRulePacks: RulePack[] = []): RulePack[] {
  return [
    appSourceRulePack(nitroRulePack),
    appSourceRulePack(nuxtRulePack),
    appSourceRulePack(nuxtContentRulePack),
    appSourceRulePack(nuxtUiRulePack),
    appSourceRulePack(nuxtScriptsRulePack),
    appSourceRulePack(vueUseRulePack),
    appSourceRulePack(nuxtImageRulePack),
    appSourceRulePack(nuxtHubRulePack),
    appSourceRulePack(nuxtBetterAuthRulePack),
    appSourceRulePack(docusRulePack),
    ...extraRulePacks,
  ];
}

export function nuxtDoctorExtensions(extraRulePacks: RulePack[] = []): DoctorExtension[] {
  return [
    defineDoctorExtension({ name: "vite-doctor/builtin-vue", rulePacks: [vueRulePack] }),
    defineDoctorExtension({
      name: "vite-doctor/builtin-nuxt",
      rulePacks: nuxtRulePacks(extraRulePacks),
    }),
  ];
}

function appSourceRulePack(pack: RulePack): RulePack {
  return {
    ...pack,
    rules: pack.rules.map((rule) => ({
      ...rule,
      meta: { ...rule.meta, sourceKinds: rule.meta.sourceKinds ?? ["app", "layer"] },
    })),
  };
}
