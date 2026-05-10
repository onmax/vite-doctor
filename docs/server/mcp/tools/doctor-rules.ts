import rulesReport from "../../../public/rules/all.json" with { type: "json" };

export default {
  name: "doctor_rules",
  title: "Nuxt Doctor Rules",
  description: "Lists Nuxt Doctor rule metadata published with the docs site.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler() {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rulesReport, null, 2) }],
    };
  },
};
