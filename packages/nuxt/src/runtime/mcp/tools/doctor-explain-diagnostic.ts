import { createRulesReport } from "@vue-doctor/core";
import { mcpToolContracts } from "../contract.js";
import { getNuxtDoctorMcpContext } from "../context.js";
import { jsonToolResult } from "../results.js";
import { nuxtRulePacks } from "../../../rules/index.js";

const contract = mcpToolContracts.explainDiagnostic;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.runtimeDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler(input: { ruleId: string }) {
    const extraRulePacks = await getNuxtDoctorMcpContext().getRulePacks();
    const rules = JSON.parse(createRulesReport(nuxtRulePacks(extraRulePacks), "json")).rules;
    return jsonToolResult({
      rule: rules.find((rule: any) => rule.id === input.ruleId) ?? null,
      structural:
        input.ruleId.startsWith("workspace/") || input.ruleId.startsWith("nuxt/")
          ? "Diagnostic evidence is available on each report result under evidence/confidence."
          : undefined,
    });
  },
};
