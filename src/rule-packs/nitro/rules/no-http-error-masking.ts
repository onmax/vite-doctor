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
    fixable: "suggestion",
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

type Outcome = number | "normal" | "exit" | "throw" | "break" | "continue";

interface Path {
  outcome: Outcome;
  label?: string;
  conditions: ReadonlyMap<string, boolean>;
}

type Bindings = ReadonlyMap<string, Outcome>;

function outcomes(node: AnyNode, path: Path, bindings: Bindings, conditions: Set<string>): Path[] {
  const normal = { ...path, outcome: "normal" as const, label: undefined };
  if (!node) return [normal];
  if (node.type === "BlockStatement") {
    const locals = blockBindings(node);
    const scopedBindings = new Map(bindings);
    const scopedConditions = new Map(normal.conditions);
    for (const name of locals) {
      scopedBindings.delete(name);
      scopedConditions.delete(name);
    }
    let paths: Path[] = [{ ...normal, conditions: scopedConditions }];
    for (const statement of node.body) {
      if (statement.type === "VariableDeclaration") {
        for (const declaration of statement.declarations) {
          const status = httpStatus(declaration.init);
          if (
            declaration.id.type === "Identifier" &&
            status !== undefined &&
            stableBinding(node, declaration.id.name, declaration)
          )
            scopedBindings.set(declaration.id.name, status);
        }
      }
      const next = paths.flatMap((current) =>
        current.outcome === "normal"
          ? outcomes(statement, current, scopedBindings, conditions)
          : [current],
      );
      paths = [
        ...new Map(
          next.map((current) => [
            JSON.stringify([
              current.outcome,
              current.label,
              [...current.conditions].sort(([a], [b]) => a.localeCompare(b)),
            ]),
            current,
          ]),
        ).values(),
      ];
    }
    return paths.map((current) => {
      const restored = new Map(current.conditions);
      for (const name of locals) {
        restored.delete(name);
        if (path.conditions.has(name)) restored.set(name, path.conditions.get(name)!);
      }
      return { ...current, conditions: restored };
    });
  }
  if (node.type === "ThrowStatement") {
    const outcome =
      httpStatus(node.argument) ??
      (node.argument?.type === "Identifier" ? bindings.get(node.argument.name) : undefined) ??
      "throw";
    return [{ ...path, outcome }];
  }
  if (node.type === "ReturnStatement") return [{ ...path, outcome: "exit" }];
  if (node.type === "BreakStatement" || node.type === "ContinueStatement")
    return [
      {
        ...path,
        outcome: node.type === "BreakStatement" ? "break" : "continue",
        label: node.label?.name,
      },
    ];
  if (node.type === "LabeledStatement") {
    const labels = new Set<string>();
    let body = node;
    while (body.type === "LabeledStatement") {
      labels.add(body.label.name);
      body = body.body;
    }
    const paths = isLoop(body)
      ? loopOutcomes(body, normal, bindings, conditions, labels)
      : outcomes(body, normal, bindings, conditions);
    return paths.map((current) =>
      current.outcome === "break" && current.label && labels.has(current.label)
        ? { ...current, outcome: "normal", label: undefined }
        : current,
    );
  }
  if (node.type === "SwitchStatement") {
    const cases: AnyNode[] = node.cases;
    const fallback = cases.findIndex((item) => !item.test);
    const seen = new Set<unknown>();
    let entries = cases.flatMap((item, index) => {
      if (item.test?.type !== "Literal") return [index];
      if (seen.has(item.test.value)) return [];
      seen.add(item.test.value);
      return [index];
    });
    if (
      node.discriminant.type === "Literal" &&
      cases.every((item) => !item.test || item.test.type === "Literal")
    ) {
      const match = cases.findIndex(
        (item) => item.test && item.test.value === node.discriminant.value,
      );
      entries = [match === -1 ? fallback : match];
    } else if (fallback === -1) entries.push(-1);
    return entries.flatMap((entry) => {
      if (entry === -1) return [normal];
      return outcomes(
        { type: "BlockStatement", body: cases.slice(entry).flatMap((item) => item.consequent) },
        normal,
        bindings,
        conditions,
      ).map((current) =>
        current.outcome === "break" && !current.label
          ? { ...current, outcome: "normal" as const }
          : current,
      );
    });
  }
  if (node.type === "VariableDeclaration") {
    const next = new Map(path.conditions);
    for (const declaration of node.declarations) {
      if (declaration.id.type !== "Identifier") continue;
      next.delete(declaration.id.name);
      if (
        declaration.init?.type === "Literal" &&
        typeof declaration.init.value === "boolean" &&
        conditions.has(declaration.id.name)
      )
        next.set(declaration.id.name, declaration.init.value);
    }
    return [{ ...normal, conditions: next }];
  }
  const assignment = node.type === "ExpressionStatement" ? node.expression : node;
  if (assignment.type === "AssignmentExpression" && assignment.left.type === "Identifier") {
    const next = new Map(path.conditions);
    next.delete(assignment.left.name);
    if (
      assignment.operator === "=" &&
      assignment.right.type === "Literal" &&
      typeof assignment.right.value === "boolean" &&
      conditions.has(assignment.left.name)
    )
      next.set(assignment.left.name, assignment.right.value);
    return [{ ...normal, conditions: next }];
  }
  if (isLoop(node)) return loopOutcomes(node, normal, bindings, conditions);
  if (node.type === "IfStatement") {
    let test = node.test;
    let negated = false;
    while (test.type === "UnaryExpression" && test.operator === "!") {
      negated = !negated;
      test = test.argument;
    }
    const caught =
      test.type === "CallExpression" &&
      test.callee?.name === "isError" &&
      test.arguments?.length === 1 &&
      test.arguments[0]?.type === "Identifier"
        ? bindings.get(test.arguments[0].name)
        : undefined;
    const known =
      typeof caught === "number" ? true : test.type === "Literal" ? Boolean(test.value) : undefined;
    if (known !== undefined)
      return outcomes(
        known !== negated ? node.consequent : node.alternate,
        normal,
        bindings,
        conditions,
      );
    const identifier = test;
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
          final.outcome === "normal"
            ? { ...final, outcome: current.outcome, label: current.label }
            : final,
        ),
      );
    }
    return paths;
  }
  return [normal];
}

function isLoop(node: AnyNode): boolean {
  return [
    "WhileStatement",
    "DoWhileStatement",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
  ].includes(node.type);
}

function loopOutcomes(
  node: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
  labels = new Set<string>(),
): Path[] {
  if (
    node.type === "ForStatement" &&
    node.init?.type === "VariableDeclaration" &&
    node.init.kind !== "var"
  ) {
    return outcomes(
      {
        type: "BlockStatement",
        body: [
          node.init,
          [...labels].reduce(
            (body, name) => ({ type: "LabeledStatement", label: { name }, body }),
            { ...node, init: null } as AnyNode,
          ),
        ],
      },
      path,
      bindings,
      conditions,
    );
  }
  const result: Path[] = [];
  const pending =
    node.type === "ForStatement" && node.init
      ? outcomes(node.init, path, bindings, conditions)
      : [path];
  const seen = new Set<string>();
  const iteration = {
    type: "IfStatement",
    test:
      node.test ??
      (node.type === "ForStatement"
        ? { type: "Literal", value: true }
        : { type: "Identifier", name: "" }),
    consequent: node.body,
    alternate: { type: "BreakStatement" },
  } as AnyNode;
  let first = node.type === "DoWhileStatement";
  while (pending.length) {
    const current = pending.pop()!;
    const key = JSON.stringify([...current.conditions].sort(([a], [b]) => a.localeCompare(b)));
    if (!first && seen.has(key)) continue;
    if (!first) seen.add(key);
    const paths = outcomes(first ? node.body : iteration, current, bindings, conditions);
    first = false;
    for (const next of paths) {
      if (next.label && !labels.has(next.label)) result.push(next);
      else if (next.outcome === "break")
        result.push({ ...next, outcome: "normal", label: undefined });
      else if (next.outcome === "normal" || next.outcome === "continue")
        pending.push(...outcomes(node.update, next, bindings, conditions));
      else result.push(next);
    }
  }
  return result;
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
  const assignments = new Set<AnyNode>();
  const skipped = unreferencedFunctionNodes(node);
  const nested = new Set<AnyNode>();
  walkScriptLocal(node, (child) => {
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(child.type)
    )
      walkScriptLocal(child, (descendant) => nested.add(descendant));
    if (nested.has(child)) return;
    if (child.type === "ExpressionStatement") assignments.add(child.expression);
    if (child.type === "ForStatement" && child.update) assignments.add(child.update);
  });
  walkScriptLocal(node, (child) => {
    if (skipped.has(child)) return;
    if (
      child.type === "IfStatement" ||
      child.type === "WhileStatement" ||
      child.type === "DoWhileStatement" ||
      (child.type === "ForStatement" && child.test)
    ) {
      let test = child.test;
      while (test.type === "UnaryExpression" && test.operator === "!") test = test.argument;
      if (test.type === "Identifier") uses.set(test.name, (uses.get(test.name) ?? 0) + 1);
    }
    if (
      child.type === "VariableDeclarator" &&
      child.id.type === "Identifier" &&
      child.init?.type === "Literal" &&
      typeof child.init.value === "boolean"
    ) {
      uses.set(child.id.name, (uses.get(child.id.name) ?? 0) + 1);
      return;
    }
    if (child.type === "VariableDeclarator" || child.type === "CatchClause") {
      walkScriptLocal(child.id ?? child.param, (binding) => {
        if (binding.type === "Identifier") unstable.add(binding.name);
      });
    }
    if (child.type === "ForInStatement" || child.type === "ForOfStatement") {
      walkScriptLocal(child.left, (target) => {
        if (target.type === "Identifier") unstable.add(target.name);
      });
    }
    if (child.type === "AssignmentExpression" || child.type === "UpdateExpression") {
      if (
        !nested.has(child) &&
        assignments.has(child) &&
        child.operator === "=" &&
        child.left.type === "Identifier" &&
        child.right.type === "Literal" &&
        typeof child.right.value === "boolean"
      ) {
        uses.set(child.left.name, (uses.get(child.left.name) ?? 0) + 1);
        return;
      }
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
  const statuses = new Map<string, number | undefined>();
  for (const property of options.properties ?? []) {
    if (property.type === "SpreadElement" || property.computed) {
      statuses.set("statusCode", undefined);
      statuses.set("status", undefined);
      continue;
    }
    const key = property.key?.name ?? property.key?.value;
    if (key === "statusCode" || key === "status")
      statuses.set(
        key,
        typeof property.value?.value === "number" ? property.value.value : undefined,
      );
  }
  if (statuses.has("statusCode")) return statuses.get("statusCode");
  return statuses.get("status");
}

function blockBindings(node: AnyNode): Set<string> {
  const names = new Set<string>();
  for (const statement of node.body) {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
      for (const declaration of statement.declarations)
        walkScriptLocal(declaration.id, (binding) => {
          if (binding.type === "Identifier") names.add(binding.name);
        });
    } else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
      if (statement.id) names.add(statement.id.name);
    }
  }
  return names;
}

function stableCatchBinding(handler: AnyNode): string | undefined {
  if (handler.param?.type !== "Identifier") return;
  const name = handler.param.name;
  return stableBinding(handler.body, name) ? name : undefined;
}

function stableBinding(body: AnyNode, name: string, declaration?: AnyNode): boolean {
  let stable = true;
  const nested = unreferencedFunctionNodes(body);
  walkScriptLocal(body, (node) => {
    if (nested.has(node)) return;
    if (
      (node !== body && node.type === "BlockStatement" && blockBindings(node).has(name)) ||
      (isFunction(node) && node.params.some((param: AnyNode) => assignsBinding(param, name))) ||
      (node.type === "CatchClause" && node.param?.name === name)
    ) {
      walkScriptLocal(node, (child) => nested.add(child));
      return;
    }
    if (
      (node !== declaration &&
        node.type === "VariableDeclarator" &&
        assignsBinding(node.id, name)) ||
      (node.type === "AssignmentExpression" && assignsBinding(node.left, name)) ||
      (node.type === "UpdateExpression" && node.argument?.name === name) ||
      (node.type === "CatchClause" && node.param?.name === name)
    )
      stable = false;
  });
  return stable;
}

function isFunction(node: AnyNode): boolean {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    node.type,
  );
}

function unreferencedFunctionNodes(root: AnyNode): Set<AnyNode> {
  const names = new Map<AnyNode, AnyNode>();
  const identifiers = new Map<string, Set<AnyNode>>();
  walkScriptLocal(root, (node) => {
    if (node.type === "Identifier") {
      if (!identifiers.has(node.name)) identifiers.set(node.name, new Set());
      identifiers.get(node.name)!.add(node);
    }
    if (node.type === "FunctionDeclaration" && node.id) names.set(node, node.id);
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init &&
      isFunction(node.init)
    )
      names.set(node.init, node.id);
  });
  const skipped = new Set<AnyNode>();
  for (const [fn, name] of names) {
    if (identifiers.get(name.name)?.size === 1) walkScriptLocal(fn, (node) => skipped.add(node));
  }
  return skipped;
}

function assignsBinding(node: AnyNode, name: string): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "AssignmentPattern") return assignsBinding(node.left, name);
  if (node.type === "RestElement") return assignsBinding(node.argument, name);
  if (node.type === "ArrayPattern")
    return node.elements.some((element: AnyNode) => assignsBinding(element, name));
  if (node.type === "ObjectPattern")
    return node.properties.some((property: AnyNode) =>
      assignsBinding(property.type === "RestElement" ? property.argument : property.value, name),
    );
  return false;
}
