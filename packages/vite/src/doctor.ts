import {
  defineDoctorPlugin,
  runDoctor,
  viteRulePack,
  vueRulePack,
  type DoctorPlugin,
  type DoctorRunOptions,
  type DoctorRunResult,
} from "@vue-doctor/core";
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

export function runViteDoctor(options: DoctorRunOptions) {
  return runDoctor({
    ...options,
    framework: options.framework ?? "auto",
    plugins: [...viteDoctorPlugins(), ...(options.plugins ?? [])],
  });
}

export function shouldFailDoctorRun(result: DoctorRunResult, maxWarnings?: number) {
  return (
    result.summary.blocker > 0 ||
    result.summary.error > 0 ||
    (maxWarnings !== undefined && result.summary.warn > maxWarnings)
  );
}
