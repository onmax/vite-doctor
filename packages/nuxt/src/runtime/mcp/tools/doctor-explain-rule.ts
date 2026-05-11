import { explainRule } from "@vue-doctor/core";
import { mcpToolContracts } from "../contract.js";
import { getNuxtDoctorMcpContext } from "../context.js";
import { jsonToolResult } from "../results.js";
import { nuxtRulePacks } from "../../../rules/index.js";

const contract = mcpToolContracts.explainRule;

export default {
  name: contract.name,
  title: contract.title,
  description: contract.runtimeDescription,
  annotations: contract.annotations,
  inputSchema: contract.inputSchema,
  async handler({ ruleId }: { ruleId: string }) {
    const extraRulePacks = await getNuxtDoctorMcpContext().getRulePacks();
    return jsonToolResult(JSON.parse(explainRule(nuxtRulePacks(extraRulePacks), ruleId, "json")));
  },
};
