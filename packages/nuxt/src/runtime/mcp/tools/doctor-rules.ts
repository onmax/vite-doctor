import { createRulesReport } from "@vue-doctor/core";
import { getNuxtDoctorMcpContext } from "../context.js";
import { jsonToolResult } from "../results.js";
import { nuxtRulePacks } from "../../../rules/index.js";

export default {
  name: "doctor_rules",
  title: "Nuxt Doctor Rules",
  description:
    "Lists Nuxt Doctor rule metadata, including rule packs added by the current Nuxt app.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler() {
    const extraRulePacks = await getNuxtDoctorMcpContext().getRulePacks();
    return jsonToolResult(JSON.parse(createRulesReport(nuxtRulePacks(extraRulePacks), "json")));
  },
};
