import {
  createRule,
  defineDoctorDiagnostics,
  defineDoctorExtension,
  defineRulePack,
} from "../../../src/extension.ts";

export const vhubDiagnostics = defineDoctorDiagnostics(
  [{ code: "VHUB0001", ruleId: "vitehub/no-legacy-kv-import" }],
  { docsBase: "https://vitehub.example/doctor" },
);

export const noLegacyKvImport = createRule({
  meta: {
    id: "vitehub/no-legacy-kv-import",
    title: "Use the current KV entrypoint",
    category: "correctness",
    severity: "warn",
  },
  create(ctx) {
    return {
      ImportDeclaration(node: any) {
        if (node.source?.value !== "@vite-hub/kv/legacy") return;
        ctx.report(
          vhubDiagnostics.diagnostics.VHUB0001({
            why: "`@vite-hub/kv/legacy` is removed in the next major release.",
            fix: "Import from `@vite-hub/kv` instead.",
          }),
          { range: ctx.range(node) },
        );
      },
    };
  },
});

export const vitehubRulePack = defineRulePack({
  name: "vitehub",
  version: "1.0.0",
  rules: [noLegacyKvImport],
  diagnostics: vhubDiagnostics,
  presets: { recommended: ["vitehub/no-legacy-kv-import"] },
});

export default defineDoctorExtension({ name: "@vite-hub/kv", rulePacks: [vitehubRulePack] });
