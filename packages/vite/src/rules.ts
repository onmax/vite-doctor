import { defineDoctorPlugin, viteRulePack, vueRulePack, type DoctorPlugin } from "@vue-doctor/core";
import { nuxtRulePacks } from "nuxt-doctor/rules";

export function viteDoctorRulePacks() {
  return [viteRulePack, vueRulePack, ...nuxtRulePacks()];
}

export function viteDoctorPlugins(): DoctorPlugin[] {
  return [
    defineDoctorPlugin({ name: "vite-doctor/builtin-vite", rulePacks: [viteRulePack] }),
    defineDoctorPlugin({ name: "vite-doctor/builtin-vue", rulePacks: [vueRulePack] }),
    defineDoctorPlugin({
      name: "vite-doctor/builtin-nuxt",
      rulePacks: nuxtRulePacks(),
    }),
  ];
}
