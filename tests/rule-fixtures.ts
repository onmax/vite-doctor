import { afterAll } from "vite-plus/test";
import type { DoctorRule, DoctorRunResult } from "../src/core/index.ts";
import { createProjectFixture } from "../src/core/testkit.ts";

const vueSfcProject = createProjectFixture({ framework: "vue" });
const nuxtAppProject = createProjectFixture({ framework: "nuxt", files: { "app/.gitkeep": "" } });
afterAll(() => Promise.all([vueSfcProject.dispose(), nuxtAppProject.dispose()]));

export function runVueSfcRuleFixture(rule: DoctorRule, source: string): Promise<DoctorRunResult> {
  return vueSfcProject.run({ rule, files: { "app.vue": source } });
}

/** The file must stay inside the Nuxt `app/` directory and must not be a server file. */
export function runNuxtAppRuleFixture(
  rule: DoctorRule,
  source: string,
  file = "app/pages/index.vue",
): Promise<DoctorRunResult> {
  return nuxtAppProject.run({ rule, files: { [file]: source } });
}
