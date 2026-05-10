import { z } from "zod";
import { explainRule } from "@vue-doctor/core";
import { getNuxtDoctorMcpContext } from "../context.js";
import { jsonToolResult } from "../results.js";
import { nuxtRulePacks } from "../../../rules/index.js";

export default {
  name: "doctor_explain_rule",
  title: "Explain Nuxt Doctor Rule",
  description: "Returns remediation context and metadata for a Nuxt Doctor rule id.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    ruleId: z.string().describe("The Nuxt Doctor rule id to explain."),
  },
  async handler({ ruleId }: { ruleId: string }) {
    const extraRulePacks = await getNuxtDoctorMcpContext().getRulePacks();
    return jsonToolResult(JSON.parse(explainRule(nuxtRulePacks(extraRulePacks), ruleId, "json")));
  },
};
