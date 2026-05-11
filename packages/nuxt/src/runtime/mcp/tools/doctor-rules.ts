import { createRulesReport } from "@vue-doctor/core";
import { mcpToolContracts } from "../contract.js";
import { getNuxtDoctorMcpContext } from "../context.js";
import { jsonToolResult } from "../results.js";
import { nuxtRulePacks } from "../../../rules/index.js";

const contract = mcpToolContracts.rules;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.runtimeDescription,
  annotations: contract.annotations,
  async handler() {
    const extraRulePacks = await getNuxtDoctorMcpContext().getRulePacks();
    return jsonToolResult(JSON.parse(createRulesReport(nuxtRulePacks(extraRulePacks), "json")));
  },
};
