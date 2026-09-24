import { createRule, report, walkScriptLocal, type AnyNode } from "./shared.js";

const ruleId = "nitro/h3/no-http-error-masking";

export const noHttpErrorMasking = createRule({
  meta: {
    id: ruleId,
    title: "Preserve intentional HTTP errors in Nitro handlers",
    category: "request",
    severity: "warn",
    docsUrl: "https://h3.dev/guide/api/error",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!ctx.helpers.isNuxtServerFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "TryStatement" || !node.handler?.param) return;
        const status = intentionalHttpErrorStatus(node.block);
        if (status === null || status >= 500) return;
        if (!masksErrorAsServerFailure(node.handler.body, node.handler.param.name)) return;
        report(
          ctx,
          node.handler,
          ruleId,
          "warn",
          "request",
          `This catch turns an intentional HTTP ${status} error into a generic server failure.`,
          "Preserve H3 errors before converting unexpected failures to HTTP 500.",
        );
      },
    };
  },
});

function intentionalHttpErrorStatus(block: AnyNode): number | null {
  let status: number | null = null;
  walkScriptLocal(block, (node) => {
    if (node.type !== "ThrowStatement" || node.argument?.type !== "CallExpression") return;
    if (node.argument.callee?.name !== "createError") return;
    const options = node.argument.arguments?.[0];
    if (options?.type !== "ObjectExpression") return;
    for (const property of options.properties ?? []) {
      const key = property.key?.name ?? property.key?.value;
      if (key !== "statusCode" && key !== "status") continue;
      const value = property.value?.value;
      if (typeof value === "number" && value >= 400 && value < 500) status = value;
    }
  });
  return status;
}

function masksErrorAsServerFailure(block: AnyNode, errorName: string): boolean {
  if (!errorName) return false;
  let masks = false;
  let preserves = false;
  walkScriptLocal(block, (node) => {
    if (node.type === "ThrowStatement" && node.argument?.name === errorName) preserves = true;
    if (node.type !== "ThrowStatement" || node.argument?.type !== "CallExpression") return;
    if (node.argument.callee?.name !== "createError") return;
    const options = node.argument.arguments?.[0];
    if (options?.type !== "ObjectExpression") return;
    for (const property of options.properties ?? []) {
      const key = property.key?.name ?? property.key?.value;
      if ((key === "statusCode" || key === "status") && property.value?.value === 500) masks = true;
    }
  });
  return masks && !preserves;
}
