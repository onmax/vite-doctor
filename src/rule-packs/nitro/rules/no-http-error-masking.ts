import { createRule, report, walkScriptLocal, type AnyNode } from "./shared.js";

const ruleId = "nitro/h3/no-http-error-masking";

export const noHttpErrorMasking = createRule({
  meta: {
    id: "nitro/h3/no-http-error-masking",
    description: "Report local intentional 4xx H3 errors replaced by HTTP 500 in a catch.",
    why: "Replacing an intentional client error with HTTP 500 hides the response contract from callers.",
    recommendedReplacement: "Rethrow H3 errors before converting unexpected failures to HTTP 500.",
    examples: [
      {
        title: "Preserve intentional H3 errors",
        language: "ts",
        invalid:
          "try { throw createError({ statusCode: 401 }) } catch { throw createError({ statusCode: 500 }) }",
        valid:
          "try { throw createError({ statusCode: 401 }) } catch (error) { if (isError(error)) throw error; throw createError({ statusCode: 500 }) }",
      },
    ],
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
        if (node.type !== "TryStatement" || !node.handler) return;
        const status = outcomes(node.block).find(
          (value) => typeof value === "number" && value >= 400 && value < 500,
        );
        if (status === undefined) return;
        const errorName = stableCatchBinding(node.handler);
        if (!outcomes(node.handler.body, errorName).includes(500)) return;
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

type Outcome = number | "normal" | "exit" | "throw";

function outcomes(node: AnyNode, errorName?: string): Outcome[] {
  if (!node) return ["normal"];
  if (node.type === "BlockStatement") {
    let paths: Outcome[] = ["normal"];
    for (const statement of node.body) {
      if (!paths.includes("normal")) break;
      paths = [...paths.filter((path) => path !== "normal"), ...outcomes(statement, errorName)];
    }
    return paths;
  }
  if (node.type === "ThrowStatement") return [httpStatus(node.argument) ?? "throw"];
  if (node.type === "ReturnStatement") return ["exit"];
  if (node.type === "IfStatement") {
    const test = node.test;
    const isCaughtH3Error =
      errorName &&
      test.type === "CallExpression" &&
      test.callee?.name === "isError" &&
      test.arguments?.length === 1 &&
      test.arguments[0]?.type === "Identifier" &&
      test.arguments[0].name === errorName;
    if (isCaughtH3Error || (test.type === "Literal" && test.value === true))
      return outcomes(node.consequent, errorName);
    if (test.type === "Literal" && test.value === false) return outcomes(node.alternate, errorName);
    return [...outcomes(node.consequent, errorName), ...outcomes(node.alternate, errorName)];
  }
  if (node.type === "TryStatement") {
    let paths = outcomes(node.block, errorName);
    if (node.handler) {
      paths = paths.flatMap((path) =>
        typeof path === "number" || path === "throw" ? outcomes(node.handler.body) : [path],
      );
    }
    if (node.finalizer) {
      const finalPaths = outcomes(node.finalizer, errorName);
      paths = paths.flatMap((path) =>
        finalPaths.map((finalPath) => (finalPath === "normal" ? path : finalPath)),
      );
    }
    return paths;
  }
  return ["normal"];
}

function httpStatus(node: AnyNode): number | undefined {
  if (node?.type !== "CallExpression" || node.callee?.name !== "createError") return;
  const options = node.arguments?.[0];
  if (options?.type !== "ObjectExpression") return;
  for (const property of options.properties ?? []) {
    const key = property.key?.name ?? property.key?.value;
    if ((key === "statusCode" || key === "status") && typeof property.value?.value === "number")
      return property.value.value;
  }
}

function stableCatchBinding(handler: AnyNode): string | undefined {
  if (handler.param?.type !== "Identifier") return;
  const name = handler.param.name;
  let stable = true;
  walkScriptLocal(handler.body, (node) => {
    if (
      (node.type === "VariableDeclarator" && node.id?.name === name) ||
      (node.type === "AssignmentExpression" && node.left?.name === name) ||
      (node.type === "UpdateExpression" && node.argument?.name === name) ||
      (node.type === "CatchClause" && node.param?.name === name)
    )
      stable = false;
  });
  return stable ? name : undefined;
}
