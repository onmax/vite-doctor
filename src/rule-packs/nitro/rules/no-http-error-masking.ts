import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";
import { createRule, report, walkScriptLocal, type AnyNode } from "./shared.js";
import { isNitroRouteFile } from "./request-helpers.js";

const ruleId = "nitro/h3/no-http-error-masking";
const analysisLimit = Symbol("HTTP error analysis limit");

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
        let enclosing = node;
        while (enclosing.__doctorParent && !isFunction(enclosing.__doctorParent))
          enclosing = enclosing.__doctorParent;
        const conditions = stableConditions(enclosing);
        let root = node;
        while (root.__doctorParent) root = root.__doctorParent;
        const lexical = lexicalBindings(root);
        const initial: Path = {
          outcome: "normal",
          budget: { remaining: 4096 },
          conditions: new Map(),
          resolveBinding: lexical.resolve,
          functions: declaredFunctions(lexical),
        };
        let candidate: Path | undefined;
        try {
          candidate = enclosingPaths(node, initial, conditions)
            .flatMap((path) => outcomes(node.block, path, new Map(), conditions))
            .find((path) => {
              if (typeof path.outcome !== "number" || path.outcome < 400 || path.outcome >= 500)
                return false;
              const caught = catchOutcomes(node.handler, path, new Map(), conditions);
              return caught.some(
                (result) =>
                  (result.outcome === 500 || result.outcome === "server-error") &&
                  (!node.finalizer ||
                    outcomes(node.finalizer, result, new Map(), conditions).some(
                      (final) => final.outcome === "normal",
                    )),
              );
            });
        } catch (error) {
          // Incomplete path exploration cannot prove that an HTTP error is masked.
          if (error === analysisLimit) return;
          throw error;
        }
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

type Outcome = number | "server-error" | "normal" | "exit" | "throw" | "break" | "continue";

interface Path {
  budget: { remaining: number };
  resolveBinding: (node: AnyNode, location?: AnyNode) => AnyNode;
  outcome: Outcome;
  label?: string;
  conditions: ReadonlyMap<string, boolean>;
  bindings?: Bindings;
  functions?: ReadonlyMap<AnyNode, AnyNode>;
  calls?: readonly AnyNode[];
  value?: Value;
  errors?: ReadonlyMap<number, Outcome>;
  literals?: ReadonlyMap<AnyNode, { literal: unknown }>;
  uninitialized?: ReadonlySet<AnyNode>;
}

type ErrorValue = { id: number; status: Outcome };
type Value = { error: ErrorValue } | { literal: unknown };
type Bindings = ReadonlyMap<string, ErrorValue>;

function errorStatus(value: ErrorValue | undefined, path: Path): Outcome | undefined {
  return value && (path.errors?.get(value.id) ?? value.status);
}

function outcomes(
  node: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
  argumentValues?: readonly (Value | undefined)[],
): Path[] {
  return evaluateOutcomes(node, path, bindings, conditions, argumentValues).map((current) => {
    if (current.outcome !== "normal") return current;
    const expression = unwrapExpression(node);
    const status = httpStatus(expression, current.resolveBinding);
    if (status !== undefined)
      return { ...current, value: { error: { id: --current.budget.remaining, status } } };
    if (expression?.type === "Literal") return { ...current, value: { literal: expression.value } };
    if (expression?.type === "Identifier") {
      const binding = current.resolveBinding(expression);
      if (binding && current.uninitialized?.has(binding)) return { ...current, outcome: "throw" };
      const error = current.bindings?.get(expression.name);
      return {
        ...current,
        value: error ? { error } : binding ? current.literals?.get(binding) : undefined,
      };
    }
    return current;
  });
}

function evaluateOutcomes(
  node: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
  argumentValues?: readonly (Value | undefined)[],
): Path[] {
  if (--path.budget.remaining < 0) throw analysisLimit;
  bindings = path.bindings ?? bindings;
  const normal = {
    ...path,
    value: undefined as Value | undefined,
    bindings,
    outcome: "normal" as const,
    label: undefined,
  };
  if (!node) return [normal];
  if (unwrapExpression(node) !== node || node.type === "ExpressionStatement")
    return outcomes(node.expression, normal, bindings, conditions);
  if (node.type === "BlockStatement") {
    const locals = blockBindings(node);
    const functions = new Map(path.functions);
    for (const name of locals) functions.delete(path.resolveBinding({ name } as AnyNode, node));
    for (const statement of node.body) {
      if (statement.type === "FunctionDeclaration" && statement.id)
        functions.set(path.resolveBinding(statement.id), statement);
    }
    const scopedBindings = new Map(bindings);
    const scopedConditions = new Map(normal.conditions);
    for (const name of locals) {
      scopedBindings.delete(name);
      scopedConditions.delete(name);
    }
    let paths: Path[] = [
      { ...normal, bindings: scopedBindings, functions, conditions: scopedConditions },
    ];
    for (const statement of node.body) {
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
              current.value,
              [...(current.errors ?? [])],
              [...(current.literals ?? [])].map(([node, value]) => [node.start, value]),
              [...(current.bindings ?? [])].sort(([a], [b]) => a.localeCompare(b)),
              [...current.conditions].sort(([a], [b]) => a.localeCompare(b)),
              [...(current.functions ?? [])]
                .map(([binding, fn]) => [binding.start, fn.start])
                .sort(([a], [b]) => a - b),
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
      const restoredBindings = new Map(current.bindings);
      for (const name of locals) {
        restoredBindings.delete(name);
        if (bindings.has(name)) restoredBindings.set(name, bindings.get(name)!);
      }
      const restoredFunctions = new Map(current.functions);
      for (const name of locals) {
        const binding = path.resolveBinding({ name } as AnyNode, node);
        restoredFunctions.delete(binding);
        if (path.functions?.has(binding))
          restoredFunctions.set(binding, path.functions.get(binding)!);
      }
      return {
        ...current,
        bindings: restoredBindings,
        functions: restoredFunctions,
        conditions: restored,
      };
    });
  }
  if (node.type === "ThrowStatement") {
    const argument = unwrapExpression(node.argument);
    if (argument?.type === "ConditionalExpression")
      return conditionPaths(argument.test, normal, bindings, conditions).flatMap(
        ({ path, value }) =>
          path.outcome === "normal"
            ? outcomes(
                {
                  type: "ThrowStatement",
                  argument: value ? argument.consequent : argument.alternate,
                },
                path,
                bindings,
                conditions,
              )
            : [path],
      );
    return outcomes(argument, normal, bindings, conditions).map((current) => {
      if (current.outcome !== "normal") return current;
      const outcome =
        errorStatus(
          current.value && "error" in current.value ? current.value.error : undefined,
          current,
        ) ?? "throw";
      return { ...current, outcome };
    });
  }
  if (node.type === "ReturnStatement")
    return outcomes(node.argument, normal, bindings, conditions).map((current) => ({
      ...current,
      outcome: current.outcome === "normal" ? "exit" : current.outcome,
    }));
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
    return switchEntries(node, normal, bindings, conditions).flatMap(({ path, entry }) => {
      if (entry === -1) return [path];
      return outcomes(
        { type: "BlockStatement", body: cases.slice(entry).flatMap((item) => item.consequent) },
        path,
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
    let paths: Path[] = [normal];
    for (const declaration of node.declarations) {
      paths = paths.flatMap((current) => {
        if (current.outcome !== "normal") return [current];
        return outcomes(declaration.init, current, bindings, conditions).map((evaluated) => {
          if (evaluated.outcome !== "normal") return evaluated;
          const next = new Map(evaluated.conditions);
          const values = new Map(evaluated.bindings);
          const functions = new Map(evaluated.functions);
          for (const name of bindingNames(declaration.id)) {
            next.delete(name);
            if (declaration.init) {
              functions.delete(evaluated.resolveBinding({ name } as AnyNode, declaration.id));
              values.delete(name);
            }
          }
          if (declaration.id.type === "Identifier") {
            const name = declaration.id.name;
            if (isFunction(declaration.init))
              functions.set(evaluated.resolveBinding(declaration.id), declaration.init);
            const value = evaluated.value;
            if (value && "error" in value) values.set(name, value.error);
            if (
              declaration.init?.type === "Literal" &&
              typeof declaration.init.value === "boolean" &&
              conditions.has(name)
            )
              next.set(name, declaration.init.value);
          }
          const literals = new Map(evaluated.literals);
          const uninitialized = new Set(evaluated.uninitialized);
          for (const name of bindingNames(declaration.id)) {
            const reference =
              declaration.id.type === "Identifier"
                ? declaration.id
                : { ...declaration.id, type: "Identifier", name };
            const binding = evaluated.resolveBinding(reference);
            if (binding) {
              literals.delete(binding);
              uninitialized.delete(binding);
              if (
                declaration.id.type === "Identifier" &&
                evaluated.value &&
                "literal" in evaluated.value
              )
                literals.set(binding, evaluated.value);
            }
          }
          return {
            ...evaluated,
            value: undefined,
            bindings: values,
            functions,
            conditions: next,
            literals,
            uninitialized,
          };
        });
      });
    }
    return paths;
  }
  const assignment = node;
  if (assignment.type === "AssignmentExpression") {
    const targets =
      assignment.left.type === "MemberExpression"
        ? outcomes(assignment.left, normal, bindings, conditions)
        : [normal];
    return targets
      .flatMap((target) =>
        target.outcome === "normal"
          ? outcomes(assignment.right, target, bindings, conditions)
          : [target],
      )
      .map((evaluated) => {
        if (evaluated.outcome !== "normal") return evaluated;
        if (
          assignment.left.type === "MemberExpression" &&
          assignment.left.object.type === "Identifier"
        ) {
          const member = assignment.left;
          const property = member.computed ? member.property.value : member.property.name;
          if (property === "statusCode" || property === "status") {
            const values = new Map(evaluated.bindings);
            const name = member.object.name;
            const error = values.get(name);
            const errors = new Map(evaluated.errors);
            if (error)
              errors.set(
                error.id,
                assignment.operator === "=" &&
                  assignment.right.type === "Literal" &&
                  typeof assignment.right.value === "number"
                  ? assignment.right.value
                  : "throw",
              );
            return { ...evaluated, errors };
          }
        }
        if (assignment.left.type === "Identifier") {
          const next = new Map(evaluated.conditions);
          const values = new Map(evaluated.bindings);
          const functions = new Map(evaluated.functions);
          const binding = evaluated.resolveBinding(assignment.left);
          functions.delete(binding);
          if (binding && assignment.operator === "=" && isFunction(assignment.right))
            functions.set(binding, assignment.right);
          values.delete(assignment.left.name);
          const value = assignment.operator === "=" ? evaluated.value : undefined;
          if (value && "error" in value) values.set(assignment.left.name, value.error);
          const literals = new Map(evaluated.literals);
          if (binding) {
            literals.delete(binding);
            if (value && "literal" in value) literals.set(binding, value);
          }
          next.delete(assignment.left.name);
          if (
            assignment.operator === "=" &&
            assignment.right.type === "Literal" &&
            typeof assignment.right.value === "boolean" &&
            conditions.has(assignment.left.name)
          )
            next.set(assignment.left.name, assignment.right.value);
          return { ...evaluated, bindings: values, functions, conditions: next, literals };
        }
        const values = new Map(evaluated.bindings);
        const functions = new Map(evaluated.functions);
        const next = new Map(evaluated.conditions);
        for (const name of bindingNames(assignment.left)) {
          values.delete(name);
          functions.delete(evaluated.resolveBinding({ name } as AnyNode, assignment.left));
          next.delete(name);
        }
        return { ...evaluated, bindings: values, functions, conditions: next };
      });
  }
  if (node.type === "LogicalExpression") {
    if (node.operator === "??")
      return outcomes(node.left, normal, bindings, conditions).flatMap((current) => {
        if (current.outcome !== "normal") return [current];
        const value = current.value;
        if (value && ("error" in value || value.literal != null)) return [current];
        const right = outcomes(node.right, current, bindings, conditions);
        return value ? right : [current, ...right];
      });
    return conditionPaths(node.left, normal, bindings, conditions).flatMap(({ path, value }) =>
      path.outcome === "normal" && value === (node.operator === "&&")
        ? outcomes(node.right, path, bindings, conditions)
        : [path],
    );
  }
  if (isLoop(node)) return loopOutcomes(node, normal, bindings, conditions);
  if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
    return conditionPaths(node.test, normal, bindings, conditions).flatMap(({ path, value }) =>
      path.outcome === "normal"
        ? outcomes(value ? node.consequent : node.alternate, path, bindings, conditions)
        : [path],
    );
  }

  if (node.type === "TryStatement") {
    let paths = outcomes(node.block, normal, bindings, conditions);
    if (node.handler) {
      paths = paths.flatMap((current) =>
        typeof current.outcome === "number" ||
        current.outcome === "server-error" ||
        current.outcome === "throw"
          ? catchOutcomes(node.handler, current, bindings, conditions)
          : [current],
      );
    }
    if (node.finalizer) {
      paths = paths.flatMap((current) =>
        outcomes(node.finalizer, current, bindings, conditions).map((final) =>
          final.outcome === "normal"
            ? { ...final, outcome: current.outcome, label: current.label, value: current.value }
            : final,
        ),
      );
    }
    return paths;
  }
  const children: AnyNode[] | undefined =
    node.type === "ArrayExpression"
      ? node.elements
      : node.type === "ObjectExpression"
        ? node.properties.flatMap((property: AnyNode) =>
            property.type === "SpreadElement"
              ? [property.argument]
              : [...(property.computed ? [property.key] : []), property.value],
          )
        : node.type === "BinaryExpression"
          ? [node.left, node.right]
          : node.type === "UnaryExpression" || node.type === "SpreadElement"
            ? [node.argument]
            : node.type === "TemplateLiteral" || node.type === "SequenceExpression"
              ? node.expressions
              : undefined;
  if (children) {
    let paths: Path[] = [normal];
    for (const child of children)
      paths = paths.flatMap((current) =>
        current.outcome === "normal" ? outcomes(child, current, bindings, conditions) : [current],
      );
    return node.type === "SequenceExpression"
      ? paths
      : paths.map((current) => ({ ...current, value: undefined }));
  }
  if (node.type === "MemberExpression") {
    return outcomes(node.object, normal, bindings, conditions)
      .flatMap((current) =>
        current.outcome === "normal" && node.computed
          ? outcomes(node.property, current, bindings, conditions)
          : [current],
      )
      .map((current) => ({ ...current, value: undefined }));
  }
  const call = assignment.type === "AwaitExpression" ? assignment.argument : assignment;
  if (!argumentValues && (call.type === "CallExpression" || call.type === "NewExpression")) {
    let paths = outcomes(call.callee, normal, bindings, conditions).map((current) => ({
      path: current,
      values: [] as (Value | undefined)[],
    }));
    for (const argument of call.arguments) {
      paths = paths.flatMap(({ path: current, values }) =>
        current.outcome === "normal"
          ? outcomes(
              argument.type === "SpreadElement" ? argument.argument : argument,
              current,
              bindings,
              conditions,
            ).map((evaluated) => ({ path: evaluated, values: [...values, evaluated.value] }))
          : [{ path: current, values }],
      );
    }
    return paths.flatMap(({ path: current, values }) =>
      current.outcome === "normal"
        ? outcomes(node, current, bindings, conditions, values)
        : [current],
    );
  }
  let callee = unwrapExpression(call.callee);
  if (callee?.type === "Identifier") callee = path.functions?.get(path.resolveBinding(callee));
  if (
    call.type === "CallExpression" &&
    isFunction(callee) &&
    (!callee.async || assignment.type === "AwaitExpression") &&
    !callee.generator
  ) {
    // An exhausted analysis budget is not evidence that the call returns.
    if ((path.calls?.length ?? 0) >= 16) return [];
    const local = new Map(bindings);
    const shadows = new Set<string>();
    const nested = new Set<AnyNode>();
    walkScriptLocal(callee.body, (child) => {
      if (isFunction(child)) walkScriptLocal(child, (descendant) => nested.add(descendant));
      if (nested.has(child) || child.type !== "VariableDeclaration" || child.kind !== "var") return;
      for (const declaration of child.declarations)
        for (const name of bindingNames(declaration.id)) shadows.add(name);
    });
    for (const param of callee.params) for (const name of bindingNames(param)) shadows.add(name);
    const functions = new Map(path.functions);
    const localConditions = new Map(path.conditions);
    for (const name of shadows) {
      local.delete(name);
      functions.delete(path.resolveBinding({ name } as AnyNode, callee));
      localConditions.delete(name);
    }
    let parameterPaths: Path[] = [
      {
        ...normal,
        bindings: local,
        functions,
        conditions: localConditions,
        calls: [...(path.calls ?? []), callee],
      },
    ];
    for (const [index, param] of callee.params.entries()) {
      const target = param.type === "AssignmentPattern" ? param.left : param;
      const supplied = call.arguments[index];
      const defaulted =
        param.type === "AssignmentPattern" &&
        (!supplied || isUndefinedArgument(supplied, path.resolveBinding));
      parameterPaths = parameterPaths.flatMap((current) => {
        if (current.outcome !== "normal") return [current];
        const evaluated = defaulted ? outcomes(param.right, current, local, conditions) : [current];
        return evaluated.map((result) => {
          if (result.outcome !== "normal" || target.type !== "Identifier") return result;
          const arg = defaulted ? param.right : supplied;
          const source = defaulted ? result : path;
          const value = defaulted ? result.value : argumentValues?.[index];
          const error = value && "error" in value ? value.error : undefined;
          const values = new Map(result.bindings);
          if (error) values.set(target.name, error);
          const booleans = new Map(result.conditions);
          const boolean =
            arg?.type === "Literal" && typeof arg.value === "boolean"
              ? arg.value
              : arg?.type === "Identifier"
                ? source.conditions.get(arg.name)
                : undefined;
          if (boolean !== undefined) booleans.set(target.name, boolean);
          return { ...result, bindings: values, conditions: booleans };
        });
      });
    }
    return parameterPaths
      .flatMap((current) =>
        current.outcome === "normal"
          ? outcomes(callee.body, current, local, conditions)
          : [current],
      )
      .map((current) => {
        const restored = new Map(
          [...(current.bindings ?? [])].filter(([name]) => bindings.has(name)),
        );
        const restoredFunctions = new Map(current.functions);
        const restoredConditions = new Map(current.conditions);
        for (const name of shadows) {
          restored.delete(name);
          const binding = path.resolveBinding({ name } as AnyNode, callee);
          restoredFunctions.delete(binding);
          restoredConditions.delete(name);
          if (bindings.has(name)) restored.set(name, bindings.get(name)!);
          if (path.functions?.has(binding))
            restoredFunctions.set(binding, path.functions.get(binding)!);
          if (path.conditions.has(name)) restoredConditions.set(name, path.conditions.get(name)!);
        }
        return {
          ...current,
          outcome: current.outcome === "exit" ? "normal" : current.outcome,
          value:
            current.outcome === "exit" || callee.body.type !== "BlockStatement"
              ? current.value
              : undefined,
          bindings: restored,
          functions: restoredFunctions,
          conditions: restoredConditions,
          calls: path.calls,
        };
      });
  }
  if (!isFunction(node)) {
    const values = new Map(bindings);
    for (const name of values.keys()) if (!stableBinding(node, name)) values.delete(name);
    walkScriptLocal(node, (child) => {
      if (child.type !== "CallExpression") return;
      for (const reference of [child.callee, ...child.arguments]) {
        if (reference.type !== "Identifier") continue;
        const fn = path.functions?.get(path.resolveBinding(reference));
        if (!fn) continue;
        for (const name of values.keys()) if (!stableBinding(fn, name)) values.delete(name);
      }
    });
    const literals = new Map(path.literals);
    for (const binding of literals.keys())
      if (binding.type === "Identifier" && !stableBinding(node, binding.name))
        literals.delete(binding);
    return [{ ...normal, bindings: values, literals }];
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
      : node.type === "ForInStatement" || node.type === "ForOfStatement"
        ? outcomes(node.right, path, bindings, conditions)
        : [path];
  const seen = new Set<string>();
  const iteration = {
    type: "IfStatement",
    test:
      node.test ??
      (node.type === "ForStatement"
        ? { type: "Literal", value: true }
        : { type: "Identifier", name: "" }),
    consequent:
      node.type === "ForInStatement" || node.type === "ForOfStatement"
        ? {
            type: "BlockStatement",
            body: [
              node.left.type === "VariableDeclaration"
                ? {
                    ...node.left,
                    declarations: node.left.declarations.map((declaration: AnyNode) => ({
                      ...declaration,
                      init: { type: "Identifier", name: "" },
                    })),
                  }
                : {
                    type: "AssignmentExpression",
                    operator: "=",
                    left: node.left,
                    right: { type: "Identifier", name: "" },
                  },
              node.body,
            ],
          }
        : node.body,
    alternate: { type: "BreakStatement" },
  } as AnyNode;
  let first = node.type === "DoWhileStatement";
  while (pending.length) {
    const current = pending.pop()!;
    if (current.outcome !== "normal") {
      result.push(current);
      continue;
    }
    const key = JSON.stringify([
      [...current.conditions].sort(([a], [b]) => a.localeCompare(b)),
      [...(current.errors ?? [])],
      [...(current.literals ?? [])].map(([node, value]) => [node.start, value]),
      [...(current.bindings ?? [])].sort(([a], [b]) => a.localeCompare(b)),
      [...(current.functions ?? [])]
        .map(([binding, fn]) => [binding.start, fn.start])
        .sort(([a], [b]) => a - b),
    ]);
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
  const caught = new Map(path.bindings ?? bindings);
  if (handler.param?.type === "Identifier") caught.delete(handler.param.name);
  const name = handler.param?.type === "Identifier" ? handler.param.name : undefined;
  if (name)
    caught.set(
      name,
      path.value && "error" in path.value
        ? path.value.error
        : { id: --path.budget.remaining, status: path.outcome },
    );
  return outcomes(handler.body, { ...path, bindings: caught }, caught, conditions).map(
    (current) => {
      if (!name) return current;
      const restored = new Map(current.bindings);
      restored.delete(name);
      const outer = path.bindings ?? bindings;
      if (outer.has(name)) restored.set(name, outer.get(name)!);
      return { ...current, bindings: restored };
    },
  );
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
    if (child.type === "CallExpression") {
      for (const argument of child.arguments)
        if (argument.type === "Identifier")
          uses.set(argument.name, (uses.get(argument.name) ?? 0) + 1);
    }
    if (
      child.type === "IfStatement" ||
      child.type === "WhileStatement" ||
      child.type === "DoWhileStatement" ||
      (child.type === "ForStatement" && child.test)
    ) {
      const record = (test: AnyNode): void => {
        test = unwrapExpression(test);
        if (test.type === "UnaryExpression" && test.operator === "!") record(test.argument);
        else if (test.type === "LogicalExpression" && ["&&", "||"].includes(test.operator)) {
          record(test.left);
          record(test.right);
        } else if (test.type === "Identifier") uses.set(test.name, (uses.get(test.name) ?? 0) + 1);
      };
      record(child.test);
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
    if (
      (child.type === "VariableDeclarator" && child.id.type !== "Identifier") ||
      child.type === "CatchClause"
    ) {
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

function conditionPaths(
  node: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
): { path: Path; value: boolean }[] {
  if (--path.budget.remaining < 0) throw analysisLimit;
  node = unwrapExpression(node);
  if (node.type === "UnaryExpression" && node.operator === "!")
    return conditionPaths(node.argument, path, bindings, conditions).map((result) => ({
      path: result.path,
      value: !result.value,
    }));
  if (node.type === "LogicalExpression" && ["&&", "||"].includes(node.operator))
    return conditionPaths(node.left, path, bindings, conditions).flatMap((result) =>
      result.path.outcome === "normal" && result.value === (node.operator === "&&")
        ? conditionPaths(node.right, result.path, bindings, conditions)
        : [result],
    );
  return outcomes(node, path, bindings, conditions).flatMap((current) => {
    if (current.outcome !== "normal") return [{ path: current, value: false }];
    let valueNode = node;
    while (valueNode.type === "AssignmentExpression" && valueNode.operator === "=")
      valueNode = unwrapExpression(valueNode.right);
    const values = current.bindings ?? bindings;
    const guard = unwrapExpression(valueNode.callee);
    const guarded = unwrapExpression(valueNode.arguments?.[0]);
    const caught =
      valueNode.type === "CallExpression" &&
      isH3Reference(guard, "isError", current.resolveBinding) &&
      valueNode.arguments.length === 1 &&
      guarded?.type === "Identifier"
        ? errorStatus(values.get(guarded.name), current)
        : undefined;
    const known =
      typeof caught === "number"
        ? true
        : current.value
          ? "error" in current.value || Boolean(current.value.literal)
          : valueNode.type === "Literal"
            ? Boolean(valueNode.value)
            : valueNode.type === "Identifier"
              ? values.has(valueNode.name)
                ? true
                : current.conditions.get(valueNode.name)
              : undefined;
    if (known !== undefined) return [{ path: current, value: known }];
    return [true, false].map((value) => ({
      path:
        valueNode.type === "Identifier" && conditions.has(valueNode.name)
          ? { ...current, conditions: new Map(current.conditions).set(valueNode.name, value) }
          : current,
      value,
    }));
  });
}

function unwrapExpression(node: AnyNode): AnyNode {
  while (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
    ].includes(node?.type)
  )
    node = node.expression;
  return node;
}

function isH3Reference(node: AnyNode, name: string, resolve: Path["resolveBinding"]): boolean {
  if (node?.type !== "Identifier") return false;
  const binding = resolve(node);
  if (!binding) return node.name === name;
  const specifier = binding.__doctorParent;
  const declaration = specifier?.__doctorParent;
  return (
    specifier?.type === "ImportSpecifier" &&
    (specifier.imported.name ?? specifier.imported.value) === name &&
    specifier.importKind !== "type" &&
    declaration?.type === "ImportDeclaration" &&
    declaration.importKind !== "type" &&
    declaration.source.value === "h3"
  );
}

function httpStatus(
  node: AnyNode,
  resolve: Path["resolveBinding"],
): number | "server-error" | undefined {
  node = unwrapExpression(node);
  const callee = unwrapExpression(node?.callee);
  if (
    ["NewExpression", "CallExpression"].includes(node?.type) &&
    callee?.type === "Identifier" &&
    !resolve(callee) &&
    [
      "Error",
      "TypeError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "URIError",
      "EvalError",
      "AggregateError",
    ].includes(callee?.name)
  )
    return "server-error";
  if (node?.type !== "CallExpression" || !isH3Reference(callee, "createError", resolve)) return;
  const options = unwrapExpression(node.arguments?.[0]);
  if (!options || (options.type === "Literal" && typeof options.value === "string")) return 500;
  if (options.type !== "ObjectExpression") return;
  const statuses = new Map<string, number | undefined>();
  for (const property of options.properties ?? []) {
    if (property.type === "SpreadElement" || property.computed) {
      statuses.set("statusCode", undefined);
      statuses.set("status", undefined);
      continue;
    }
    const key = property.key?.name ?? property.key?.value;
    if (key === "statusCode" || key === "status") {
      const value = unwrapExpression(property.value);
      statuses.set(key, typeof value?.value === "number" ? value.value : undefined);
    }
  }
  if (statuses.has("statusCode")) return statuses.get("statusCode");
  return statuses.has("status") ? statuses.get("status") : 500;
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

function stableBinding(body: AnyNode, name: string): boolean {
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
      (node.type === "VariableDeclarator" && assignsBinding(node.id, name)) ||
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
    node?.type,
  );
}

function lexicalBindings(root: AnyNode) {
  type Scope = { parent?: Scope; bindings: Map<string, AnyNode>; functionScope?: boolean };
  const scopes = new Map<AnyNode, Scope>();
  const names = new Map<AnyNode, AnyNode>();
  function bind(pattern: AnyNode, scope: Scope) {
    for (const binding of bindingNames(pattern))
      if (!scope.bindings.has(binding)) scope.bindings.set(binding, pattern);
  }
  function collect(node: AnyNode, outer: Scope) {
    if (!node?.type) return;
    if (node.type === "FunctionDeclaration" && node.id) {
      bind(node.id, outer);
      names.set(node, outer.bindings.get(node.id.name)!);
    }
    const scoped =
      isFunction(node) ||
      [
        "BlockStatement",
        "CatchClause",
        "SwitchStatement",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
      ].includes(node.type);
    const scope: Scope = scoped
      ? { parent: outer, bindings: new Map(), functionScope: isFunction(node) }
      : outer;
    scopes.set(node, scope);
    if (isFunction(node)) {
      node.params.forEach((param: AnyNode) => bind(param, scope));
      if (node.type === "FunctionExpression") bind(node.id, scope);
    }
    if (node.type === "CatchClause") bind(node.param, scope);
    if (node.type === "ImportDeclaration")
      for (const specifier of node.specifiers) bind(specifier.local, scope);
    if (node.type === "ClassDeclaration") bind(node.id, scope);
    if (node.type === "VariableDeclaration") {
      let target = scope;
      if (node.kind === "var")
        while (target.parent && !target.functionScope) target = target.parent;
      for (const declaration of node.declarations) {
        bind(declaration.id, target);
        if (declaration.id.type === "Identifier" && isFunction(declaration.init))
          names.set(declaration.init, target.bindings.get(declaration.id.name)!);
      }
    }
    for (const key of getNodeVisitorKeys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => collect(child, scope));
      else
        collect(value, node.type === "SwitchStatement" && key === "discriminant" ? outer : scope);
    }
  }
  collect(root, { bindings: new Map(), functionScope: true });
  return {
    names,
    resolve: (reference: AnyNode, location = reference) => {
      for (let scope = scopes.get(location); scope; scope = scope.parent) {
        const binding = scope.bindings.get(reference.name);
        if (binding) return binding;
      }
    },
  };
}

function declaredFunctions(lexical: ReturnType<typeof lexicalBindings>) {
  return new Map(
    [...lexical.names]
      .filter(([fn]) => fn.type === "FunctionDeclaration")
      .map(([fn, binding]) => [binding, fn]),
  );
}

function switchEntries(
  node: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
): { path: Path; entry: number }[] {
  const cases: AnyNode[] = node.cases;
  const fallback = cases.findIndex((item) => !item.test);
  const discriminant = unwrapExpression(node.discriminant);
  return outcomes(discriminant, path, bindings, conditions).flatMap((evaluated) => {
    if (evaluated.outcome !== "normal") return [{ path: evaluated, entry: -1 }];
    const discriminantValue = evaluated.value;
    const uninitialized = new Set(evaluated.uninitialized);
    for (const item of cases)
      for (const statement of item.consequent) {
        if (statement.type === "VariableDeclaration" && statement.kind !== "var")
          for (const declaration of statement.declarations) {
            const binding = evaluated.resolveBinding(declaration.id);
            if (binding) uninitialized.add(binding);
          }
      }
    let unmatched = [{ ...evaluated, uninitialized } as Path];
    const entries: { path: Path; entry: number }[] = [];
    const seen = new Set<unknown>();
    for (const [index, item] of cases.entries()) {
      if (!item.test) continue;
      const test = unwrapExpression(item.test);
      const remaining: Path[] = [];
      for (const path of unmatched) {
        for (const current of outcomes(test, path, bindings, conditions)) {
          if (current.outcome !== "normal") {
            entries.push({ path: current, entry: -1 });
            continue;
          }
          const testValue = current.value;
          const known =
            discriminantValue &&
            "literal" in discriminantValue &&
            testValue &&
            "literal" in testValue;
          const equal = known && discriminantValue.literal === testValue.literal;
          const duplicate = test.type === "Literal" && seen.has(test.value);
          if (!duplicate && (!known || equal)) entries.push({ path: current, entry: index });
          if (!known || !equal) remaining.push(current);
        }
      }
      if (test.type === "Literal") seen.add(test.value);
      unmatched = remaining;
    }
    entries.push(...unmatched.map((path) => ({ path, entry: fallback })));
    return entries;
  });
}

function enclosingPaths(node: AnyNode, initial: Path, conditions: Set<string>): Path[] {
  const prefixes: (AnyNode[] | ((path: Path) => Path[]))[] = [];
  for (
    let child = node, parent = child.__doctorParent;
    parent;
    child = parent, parent = parent.__doctorParent
  ) {
    if (isFunction(parent)) break;
    if (parent.type === "BlockStatement" || parent.type === "Program") {
      const index = parent.body.indexOf(child);
      if (index >= 0) prefixes.unshift(parent.body.slice(0, index));
    } else if (parent.type === "SwitchCase") {
      const switchNode = parent.__doctorParent;
      const target = switchNode.cases.indexOf(parent);
      const preceding = parent.consequent.slice(0, parent.consequent.indexOf(child));
      prefixes.unshift((path) =>
        switchEntries(switchNode, path, new Map(), conditions).flatMap(
          ({ path: entryPath, entry }) => {
            if (entry < 0 || entry > target || entryPath.outcome !== "normal") return [];
            let paths = [entryPath];
            for (const statement of [
              ...switchNode.cases.slice(entry, target).flatMap((item: AnyNode) => item.consequent),
              ...preceding,
            ]) {
              paths = paths.flatMap((current) =>
                current.outcome === "normal"
                  ? outcomes(statement, current, new Map(), conditions)
                  : [],
              );
            }
            return paths.filter((current) => current.outcome === "normal");
          },
        ),
      );
    } else if (parent.type === "IfStatement") {
      prefixes.unshift([
        {
          type: "IfStatement",
          test: parent.test,
          consequent: child === parent.consequent ? null : { type: "ReturnStatement" },
          alternate: child === parent.alternate ? null : { type: "ReturnStatement" },
        } as AnyNode,
      ]);
    } else if (
      (parent.type === "ForInStatement" || parent.type === "ForOfStatement") &&
      child === parent.body
    ) {
      prefixes.unshift([parent.right]);
    } else if (
      (parent.type === "WhileStatement" || parent.type === "ForStatement") &&
      child === parent.body
    ) {
      prefixes.unshift([
        ...(parent.type === "ForStatement" && parent.init ? [parent.init] : []),
        {
          type: "IfStatement",
          test: parent.test ?? { type: "Literal", value: true },
          consequent: null,
          alternate: { type: "ReturnStatement" },
        } as AnyNode,
      ]);
    }
  }
  let paths = [initial];
  for (const statement of prefixes.flat()) {
    paths = paths.flatMap((path) =>
      path.outcome !== "normal"
        ? [path]
        : typeof statement === "function"
          ? statement(path)
          : outcomes(statement, path, new Map(), conditions),
    );
  }
  return paths.filter((path) => path.outcome === "normal");
}

function isUndefinedArgument(node: AnyNode, resolve: Path["resolveBinding"]): boolean {
  while (node.type === "ParenthesizedExpression") node = node.expression;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "void" &&
    node.argument.type === "Literal"
  )
    return true;
  if (node.type !== "Identifier" || node.name !== "undefined") return false;
  return !resolve(node);
}

function unreferencedFunctionNodes(root: AnyNode): Set<AnyNode> {
  const { names, resolve } = lexicalBindings(root);
  const invoked = new Set<AnyNode>();
  walkScriptLocal(root, (node) => {
    if (node.type !== "CallExpression") return;
    for (const reference of [node.callee, ...node.arguments]) {
      if (reference.type !== "Identifier") continue;
      const binding = resolve(reference);
      if (binding) invoked.add(binding);
    }
  });
  const skipped = new Set<AnyNode>();
  for (const [fn, binding] of names) {
    if (fn !== root && !invoked.has(binding)) walkScriptLocal(fn, (node) => skipped.add(node));
  }
  return skipped;
}

function bindingNames(pattern: AnyNode): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((item: AnyNode) => bindingNames(item.value ?? item.argument));
  return [];
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
