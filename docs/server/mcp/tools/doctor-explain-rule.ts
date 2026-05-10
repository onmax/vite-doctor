import { z } from "zod";
import rulesReport from "../../../public/rules/all.json" with { type: "json" };

export default {
  name: "doctor_explain_rule",
  title: "Explain Nuxt Doctor Rule",
  description: "Returns published metadata for a Nuxt Doctor rule id.",
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
    const rule = rulesReport.rules.find((rule) => rule.id === ruleId) ?? null;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ rule }, null, 2) }],
    };
  },
};
