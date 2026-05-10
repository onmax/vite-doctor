import type { DoctorRunOptions } from "@vue-doctor/core";
import { runDoctor } from "@vue-doctor/core";
import { nuxtDoctorPlugins } from "../../rules/index.js";
import type { NuxtDoctorMcpContext } from "./context.js";

export async function runNuxtDoctorMcpReport(
  context: NuxtDoctorMcpContext,
  options: Pick<
    DoctorRunOptions,
    "rules" | "severity" | "changed" | "since" | "baseline" | "newOnly" | "types" | "profile"
  > = {},
) {
  const extraRulePacks = await context.getRulePacks();
  return runDoctor({
    ...options,
    root: context.rootDir,
    framework: "nuxt",
    plugins: nuxtDoctorPlugins(extraRulePacks),
  });
}
