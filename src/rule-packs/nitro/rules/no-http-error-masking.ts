import { createRule, report, walkScriptLocal, type AnyNode } from "./shared.js";
import { isNitroRouteFile } from "./request-helpers.js";

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
    if (
      !ctx.helpers.isNuxtServerFile(ctx.file.relativePath) &&
      !isNitroRouteFile(ctx.file.relativePath)
    )
      return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "TryStatement" || !node.handler) return;
        const conditions = stableConditions(node);
        const initial: Path = { outcome: "normal", conditions: new Map() };
        const candidate = outcomes(node.block, initial, new Map(), conditions).find((path) => {
          if (typeof path.outcome !== "number" || path.outcome < 400 || path.outcome >= 500)
            return false;
          const caught = catchOutcomes(node.handler, path, new Map(), conditions);
          return caught.some(
            (result) =>
              result.outcome === 500 &&
              (!node.finalizer ||
                outcomes(node.finalizer, result, new Map(), conditions).some(
                  (final) => final.outcome === "normal",
                )),
          );
        });
        if (!candidate) return;
        const status = candidate.outcome;
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

interface Path {
  outcome: Outcome;
  conditions: ReadonlyMap<string, boolean>;
}

type Bindings = ReadonlyMap<string, Outcome>;

function outcomes(node: AnyNode, path: Path, bindings: Bindings, conditions: Set<string>): Path[] {
  const normal = { ...path, outcome: "normal" as const };
  if (!node) return [normal];
  if (node.type === "BlockStatement") {
    let paths: Path[] = [normal];
    for (const statement of node.body) {
      const next = paths.flatMap((current) =>
        current.outcome === "normal"
          ? outcomes(statement, current, bindings, conditions)
          : [current],
      );
      paths = [
        ...new Map(
          next.map((current) => [
            JSON.stringify([
              current.outcome,
              [...current.conditions].sort(([a], [b]) => a.localeCompare(b)),
            ]),
            current,
          ]),
        ).values(),
      ];
    }
    return paths;
  }
  if (node.type === "ThrowStatement") {
    const outcome =
      httpStatus(node.argument) ??
      (node.argument?.type === "Identifier" ? bindings.get(node.argument.name) : undefined) ??
      "throw";
    return [{ ...path, outcome }];
  }
  if (node.type === "ReturnStatement") return [{ ...path, outcome: "exit" }];
  if (node.type === "IfStatement") {
    const test = node.test;
    const caught =
      test.type === "CallExpression" &&
      test.callee?.name === "isError" &&
      test.arguments?.length === 1 &&
      test.arguments[0]?.type === "Identifier"
        ? bindings.get(test.arguments[0].name)
        : undefined;
    if (typeof caught === "number" || (test.type === "Literal" && test.value === true))
      return outcomes(node.consequent, normal, bindings, conditions);
    if (test.type === "Literal" && test.value === false)
      return outcomes(node.alternate, normal, bindings, conditions);
    const negated = test.type === "UnaryExpression" && test.operator === "!";
    const identifier = negated ? test.argument : test;
    const name =
      identifier.type === "Identifier" && conditions.has(identifier.name)
        ? identifier.name
        : undefined;
    return [true, false].flatMap((branch) => {
      const value = negated ? !branch : branch;
      if (name && path.conditions.has(name) && path.conditions.get(name) !== value) return [];
      const next = name
        ? { ...normal, conditions: new Map(path.conditions).set(name, value) }
        : normal;
      return outcomes(branch ? node.consequent : node.alternate, next, bindings, conditions);
    });
  }
  if (node.type === "TryStatement") {
    let paths = outcomes(node.block, normal, bindings, conditions);
    if (node.handler) {
      paths = paths.flatMap((current) =>
        typeof current.outcome === "number" || current.outcome === "throw"
          ? catchOutcomes(node.handler, current, bindings, conditions)
          : [current],
      );
    }
    if (node.finalizer) {
      paths = paths.flatMap((current) =>
        outcomes(node.finalizer, current, bindings, conditions).map((final) =>
          final.outcome === "normal" ? { ...final, outcome: current.outcome } : final,
        ),
      );
    }
    return paths;
  }
  return [normal];
}

function catchOutcomes(
  handler: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
): Path[] {
  const caught = new Map(bindings);
  if (handler.param?.type === "Identifier") caught.delete(handler.param.name);
  const name = stableCatchBinding(handler);
  if (name) caught.set(name, path.outcome);
  return outcomes(handler.body, path, caught, conditions);
}

function stableConditions(node: AnyNode): Set<string> {
  const uses = new Map<string, number>();
  const unstable = new Set<string>();
  walkScriptLocal(node, (child) => {
    if (child.type === "IfStatement") {
      const test =
        child.test.type === "UnaryExpression" && child.test.operator === "!"
          ? child.test.argument
          : child.test;
      if (test.type === "Identifier") uses.set(test.name, (uses.get(test.name) ?? 0) + 1);
    }
    if (child.type === "VariableDeclarator" || child.type === "CatchClause") {
      walkScriptLocal(child.id ?? child.param, (binding) => {
        if (binding.type === "Identifier") unstable.add(binding.name);
      });
    }
    if (child.type === "AssignmentExpression" || child.type === "UpdateExpression") {
      walkScriptLocal(child.left ?? child.argument, (target) => {
        if (target.type === "Identifier") unstable.add(target.name);
      });
    }
  });
  return new Set(
    [...uses].filter(([name, count]) => count > 1 && !unstable.has(name)).map(([name]) => name),
  );
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
