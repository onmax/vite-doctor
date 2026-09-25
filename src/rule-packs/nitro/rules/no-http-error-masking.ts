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
        const enclosingFunction = enclosing.__doctorParent;
        const handlerCall = enclosingFunction?.__doctorParent;
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
          ...moduleBindings(root, enclosingFunction, lexical.resolve),
          asyncBody: Boolean(
            enclosingFunction?.async ||
            (handlerCall?.type === "CallExpression" &&
              handlerCall.arguments.includes(enclosingFunction) &&
              ["defineEventHandler", "eventHandler"].some((name) =>
                isH3Reference(unwrapExpression(handlerCall.callee), name, lexical.resolve),
              )),
          ),
        };
        let candidate: Path | undefined;
        try {
          candidate = enclosingPaths(node, initial, conditions)
            .flatMap((path) => outcomes(node.block, path, new Map(), conditions))
            .find((path) => {
              if (typeof path.outcome !== "number" || path.outcome < 400 || path.outcome >= 500)
                return false;
              const caught = catchOutcomes(node.handler, path, new Map(), conditions);
              return caught.some((result) => {
                if (result.outcome !== 500 && result.outcome !== "server-error") return false;
                if (!node.finalizer) return true;
                return outcomes(node.finalizer, result, new Map(), conditions).some((final) => {
                  if (final.outcome !== "normal") return false;
                  if (!result.value || !("error" in result.value)) return true;
                  const status = errorStatus(result.value.error, final);
                  return status === 500 || status === "server-error";
                });
              });
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
  superClasses?: ReadonlyMap<AnyNode, AnyNode>;
  objects?: ReadonlyMap<AnyNode, AnyNode>;
  promises?: ReadonlyMap<AnyNode, Value>;
  calls?: readonly AnyNode[];
  value?: Value;
  errors?: ReadonlyMap<number, Outcome>;
  literals?: ReadonlyMap<AnyNode, { literal: unknown }>;
  uninitialized?: ReadonlySet<AnyNode>;
  arrayIteratorElements?: AnyNode[] | null;
  asyncBody?: boolean;
  adoptingAsync?: boolean;
}

type ErrorValue = { id: number; status: Outcome; instanceofError?: boolean };
type Value =
  | { error: ErrorValue }
  | { literal: unknown }
  | { promise: { outcome: Outcome; value?: Value } };
type Bindings = ReadonlyMap<AnyNode, ErrorValue>;

function pathKey(value: unknown): string {
  return JSON.stringify(value, (_key, value) =>
    typeof value === "bigint" ? { bigint: String(value) } : value,
  );
}

function conditionKey(node: AnyNode, path: Path, location = node): string {
  const binding = path.resolveBinding(node, location);
  return binding ? `${binding.start}:${node.name}` : node.name;
}

function errorStatus(value: ErrorValue | undefined, path: Path): Outcome | undefined {
  return value && (path.errors?.get(value.id) ?? value.status);
}

function compoundStatus(operator: string, previous: number, operand: number): number | undefined {
  switch (operator) {
    case "+=":
      return previous + operand;
    case "-=":
      return previous - operand;
    case "*=":
      return previous * operand;
    case "/=":
      return previous / operand;
    case "%=":
      return previous % operand;
    case "**=":
      return previous ** operand;
    case "|=":
      return previous | operand;
    case "&=":
      return previous & operand;
    case "^=":
      return previous ^ operand;
    case "<<=":
      return previous << operand;
    case ">>=":
      return previous >> operand;
    case ">>>=":
      return previous >>> operand;
  }
}

function outcomes(
  node: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
  argumentValues?: readonly (Value | undefined)[],
  evaluatedArguments?: AnyNode[],
): Path[] {
  return evaluateOutcomes(node, path, bindings, conditions, argumentValues, evaluatedArguments).map(
    (current) => {
      if (current.outcome !== "normal") return current;
      const expression = unwrapExpression(node);
      const status = httpStatus(expression, current);
      if (status !== undefined)
        return {
          ...current,
          value: {
            error: {
              id: --current.budget.remaining,
              status,
              instanceofError:
                expression?.type === "CallExpression" &&
                isH3Reference(
                  unwrapExpression(expression.callee),
                  "createError",
                  current.resolveBinding,
                ) &&
                resolvedObject(expression.arguments[0], current)?.properties.every(
                  (property: AnyNode) =>
                    property.type !== "SpreadElement" &&
                    !property.computed &&
                    !["constructor", "__proto__"].includes(
                      property.key?.name ?? property.key?.value,
                    ),
                ),
            },
          },
        };
      if (expression?.type === "Literal")
        return { ...current, value: { literal: expression.value } };
      if (expression?.type === "Identifier") {
        const binding = current.resolveBinding(expression);
        if (binding && current.uninitialized?.has(binding)) return { ...current, outcome: "throw" };
        const error = current.bindings?.get(binding);
        return {
          ...current,
          value: error
            ? { error }
            : binding
              ? (current.promises?.get(binding) ?? current.literals?.get(binding))
              : expression.name === "undefined"
                ? { literal: undefined }
                : undefined,
        };
      }
      return current;
    },
  );
}

function evaluateOutcomes(
  node: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
  argumentValues?: readonly (Value | undefined)[],
  evaluatedArguments?: AnyNode[],
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
  if (node.type === "ChainExpression") {
    const expression = node.expression;
    if (shortCircuitsChain(expression, normal))
      return [{ ...normal, value: { literal: undefined } }];
    return outcomes(expression, normal, bindings, conditions);
  }
  if (unwrapExpression(node) !== node || node.type === "ExpressionStatement")
    return outcomes(node.expression, normal, bindings, conditions);
  if (node.type === "BlockStatement") {
    const locals = blockBindings(node);
    const functions = new Map(path.functions);
    const objects = new Map(path.objects);
    const promises = new Map(path.promises);
    for (const name of locals) functions.delete(path.resolveBinding({ name } as AnyNode, node));
    for (const name of locals) objects.delete(path.resolveBinding({ name } as AnyNode, node));
    for (const name of locals) promises.delete(path.resolveBinding({ name } as AnyNode, node));
    for (const statement of node.body) {
      if (statement.type === "FunctionDeclaration" && statement.id)
        functions.set(path.resolveBinding(statement.id), statement);
    }
    const uninitialized = lexicalTDZ(node, path);
    const scopedBindings = new Map(bindings);
    const scopedConditions = new Map(normal.conditions);
    for (const name of locals) {
      scopedBindings.delete(path.resolveBinding({ name } as AnyNode, node));
      scopedConditions.delete(conditionKey({ name } as AnyNode, path, node));
    }
    let paths: Path[] = [
      {
        ...normal,
        bindings: scopedBindings,
        functions,
        objects,
        promises,
        conditions: scopedConditions,
        uninitialized,
      },
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
            pathKey([
              current.outcome,
              current.label,
              [...(current.uninitialized ?? [])].map((binding) => binding.start),
              current.value,
              [...(current.errors ?? [])],
              [...(current.literals ?? [])].map(([node, value]) => [node.start, value]),
              [...(current.bindings ?? [])].map(([binding, value]) => [binding?.start, value]),
              [...current.conditions].sort(([a], [b]) => a.localeCompare(b)),
              [...(current.functions ?? [])]
                .map(([binding, fn]) => [binding.start, fn.start])
                .sort(([a], [b]) => a - b),
              [...(current.objects ?? [])]
                .map(([binding, object]) => [binding.start, object.start])
                .sort(([a], [b]) => a - b),
              [...(current.promises ?? [])].map(([binding, value]) => [binding.start, value]),
            ]),
            current,
          ]),
        ).values(),
      ];
    }
    return paths.map((current) => {
      const restored = new Map(current.conditions);
      for (const name of locals) {
        const key = conditionKey({ name } as AnyNode, path, node);
        restored.delete(key);
        if (path.conditions.has(key)) restored.set(key, path.conditions.get(key)!);
      }
      const restoredBindings = new Map(current.bindings);
      for (const name of locals) {
        const binding = path.resolveBinding({ name } as AnyNode, node);
        restoredBindings.delete(binding);
        if (bindings.has(binding)) restoredBindings.set(binding, bindings.get(binding)!);
      }
      const restoredFunctions = new Map(current.functions);
      const restoredObjects = new Map(current.objects);
      const restoredPromises = new Map(current.promises);
      for (const name of locals) {
        const binding = path.resolveBinding({ name } as AnyNode, node);
        restoredFunctions.delete(binding);
        restoredObjects.delete(binding);
        restoredPromises.delete(binding);
        if (path.functions?.has(binding))
          restoredFunctions.set(binding, path.functions.get(binding)!);
        if (path.objects?.has(binding)) restoredObjects.set(binding, path.objects.get(binding)!);
        if (path.promises?.has(binding)) restoredPromises.set(binding, path.promises.get(binding)!);
      }
      return {
        ...current,
        bindings: restoredBindings,
        functions: restoredFunctions,
        objects: restoredObjects,
        promises: restoredPromises,
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
        ) ?? (current.value && "literal" in current.value ? "server-error" : "throw");
      return {
        ...current,
        outcome:
          outcome === "throw" && argument?.type === "ObjectExpression" ? "server-error" : outcome,
      };
    });
  }
  if (node.type === "ReturnStatement")
    return outcomes(
      node.argument,
      {
        ...normal,
        adoptingAsync: normal.asyncBody,
      },
      bindings,
      conditions,
    ).map((current) => ({
      ...current,
      outcome: current.outcome === "normal" ? "exit" : current.outcome,
      adoptingAsync: path.adoptingAsync,
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
        return outcomes(declaration.init, current, bindings, conditions)
          .flatMap((evaluated) =>
            patternOutcomes(declaration.id, declaration.init, evaluated, conditions, evaluated),
          )
          .map((evaluated) => {
            if (evaluated.outcome !== "normal") return evaluated;
            const next = new Map(evaluated.conditions);
            const values = new Map(evaluated.bindings);
            const functions = new Map(evaluated.functions);
            const objects = new Map(evaluated.objects);
            for (const name of bindingNames(declaration.id)) {
              if (declaration.id.type === "Identifier")
                next.delete(conditionKey({ name } as AnyNode, evaluated, declaration.id));
              if (declaration.init && declaration.id.type === "Identifier") {
                functions.delete(evaluated.resolveBinding({ name } as AnyNode, declaration.id));
                objects.delete(evaluated.resolveBinding({ name } as AnyNode, declaration.id));
                values.delete(evaluated.resolveBinding({ name } as AnyNode, declaration.id));
              }
            }
            if (declaration.id.type === "Identifier") {
              const name = declaration.id.name;
              const initializer = unwrapExpression(declaration.init);
              const fn = isLocalCallable(initializer)
                ? initializer
                : initializer?.type === "Identifier"
                  ? evaluated.functions?.get(evaluated.resolveBinding(initializer))
                  : undefined;
              if (fn) functions.set(evaluated.resolveBinding(declaration.id), fn);
              const object =
                initializer?.type === "ObjectExpression"
                  ? initializer
                  : initializer?.type === "Identifier"
                    ? evaluated.objects?.get(evaluated.resolveBinding(initializer))
                    : undefined;
              if (object) objects.set(evaluated.resolveBinding(declaration.id), object);
              const value = evaluated.value;
              if (value && "error" in value)
                values.set(evaluated.resolveBinding(declaration.id), value.error);
              if (
                declaration.init?.type === "Literal" &&
                typeof declaration.init.value === "boolean" &&
                conditions.has(name)
              )
                next.set(conditionKey(declaration.id, evaluated), declaration.init.value);
            }
            const literals = new Map(evaluated.literals);
            const promises = new Map(evaluated.promises);
            const uninitialized = new Set(evaluated.uninitialized);
            for (const name of bindingNames(declaration.id)) {
              const reference =
                declaration.id.type === "Identifier"
                  ? declaration.id
                  : { ...declaration.id, type: "Identifier", name };
              const binding = evaluated.resolveBinding(reference, declaration.id);
              if (binding) {
                if (declaration.id.type === "Identifier") literals.delete(binding);
                if (declaration.id.type === "Identifier") promises.delete(binding);
                uninitialized.delete(binding);
                if (
                  declaration.id.type === "Identifier" &&
                  evaluated.value &&
                  "literal" in evaluated.value
                )
                  literals.set(binding, evaluated.value);
                if (
                  declaration.id.type === "Identifier" &&
                  evaluated.value &&
                  "promise" in evaluated.value
                )
                  promises.set(binding, evaluated.value);
                else if (declaration.id.type === "Identifier" && !declaration.init)
                  literals.set(binding, { literal: undefined });
              }
            }
            return {
              ...evaluated,
              value: undefined,
              bindings: values,
              functions,
              objects,
              conditions: next,
              literals,
              promises,
              uninitialized,
            };
          });
      });
    }
    return paths;
  }
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    const uninitialized = new Set(normal.uninitialized);
    if (node.id) uninitialized.add(normal.resolveBinding(node.id));
    let paths = outcomes(node.superClass, { ...normal, uninitialized }, bindings, conditions);
    for (const member of node.body.body) {
      if (member.computed)
        paths = paths.flatMap((current) =>
          current.outcome === "normal"
            ? outcomes(member.key, current, bindings, conditions)
            : [current],
        );
    }
    paths = paths.map((current) => {
      const uninitialized = new Set(current.uninitialized);
      if (node.id) uninitialized.delete(current.resolveBinding(node.id));
      return { ...current, uninitialized };
    });
    for (const member of node.body.body) {
      const initializer =
        member.type === "StaticBlock"
          ? { ...member, type: "BlockStatement" }
          : member.static && member.type === "PropertyDefinition"
            ? member.value
            : undefined;
      if (initializer)
        paths = paths.flatMap((current) =>
          current.outcome === "normal"
            ? outcomes(initializer, current, bindings, conditions)
            : [current],
        );
    }
    return paths.map((current) => {
      if (current.outcome !== "normal") return current;
      const uninitialized = new Set(current.uninitialized);
      if (node.id) uninitialized.delete(node.id);
      const functions = new Map(current.functions);
      const superClasses = new Map(current.superClasses);
      if (node.superClass) {
        const base = unwrapExpression(node.superClass);
        const resolved =
          base?.type === "Identifier" ? current.functions?.get(current.resolveBinding(base)) : base;
        if (resolved?.type === "ClassDeclaration" || resolved?.type === "ClassExpression")
          superClasses.set(node, resolved);
      }
      if (node.type === "ClassDeclaration" && node.id)
        functions.set(
          current.resolveBinding({ name: node.id.name } as AnyNode, node.__doctorParent) ??
            current.resolveBinding(node.id) ??
            node.id,
          node,
        );
      return { ...current, uninitialized, functions, superClasses, value: undefined };
    });
  }
  if (node.type === "UpdateExpression") {
    return outcomes(node.argument, normal, bindings, conditions).map((current) => {
      if (current.outcome !== "normal") return current;
      const member = node.argument;
      const previous = current.value;
      const value =
        previous && "literal" in previous && typeof previous.literal === "number"
          ? previous.literal + (node.operator === "++" ? 1 : -1)
          : undefined;
      const errors = new Map(current.errors);
      const literals = new Map(current.literals);
      if (member.type === "MemberExpression" && member.object.type === "Identifier") {
        const property = member.computed
          ? knownLiteral(member.property, current)
          : member.property.name;
        const error = current.bindings?.get(current.resolveBinding(member.object));
        if (error && (property === "statusCode" || property === "status"))
          errors.set(error.id, value ?? "throw");
      } else if (member.type === "Identifier") {
        const binding = current.resolveBinding(member);
        literals.delete(binding);
        if (value !== undefined) literals.set(binding, { literal: value });
      }
      return {
        ...current,
        errors,
        literals,
        value: node.prefix ? (value === undefined ? undefined : { literal: value }) : previous,
      };
    });
  }
  const assignment = node;
  if (assignment.type === "AssignmentExpression") {
    const logical = ["&&=", "||=", "??="].includes(assignment.operator);
    const targets =
      assignment.left.type === "MemberExpression" || logical
        ? outcomes(assignment.left, normal, bindings, conditions)
        : [normal];
    return targets
      .flatMap((target) => {
        if (target.outcome !== "normal") return [{ target, evaluated: target, skipped: true }];
        if (logical) {
          const value = target.value;
          const literal = value && "literal" in value ? value.literal : undefined;
          const truthy = value && ("error" in value || (literal !== undefined && !!literal));
          const known = value && ("error" in value || "literal" in value);
          const shouldEvaluate =
            assignment.operator === "??="
              ? literal == null && !truthy
              : assignment.operator === "&&="
                ? truthy
                : !truthy;
          if (known && !shouldEvaluate) return [{ target, evaluated: target, skipped: true }];
          const evaluated = outcomes(assignment.right, target, bindings, conditions).map(
            (result) => ({ target, evaluated: result, skipped: false }),
          );
          return known ? evaluated : [{ target, evaluated: target, skipped: true }, ...evaluated];
        }
        return outcomes(assignment.right, target, bindings, conditions).map((evaluated) => ({
          target,
          evaluated,
          skipped: false,
        }));
      })
      .map(({ target, evaluated, skipped }) => {
        if (skipped) return evaluated;
        if (evaluated.outcome !== "normal") return evaluated;
        if (isArrayIterator(assignment.left, target)) {
          const iterator = unwrapExpression(assignment.right);
          const elements =
            iterator?.generator && iterator.body?.type === "BlockStatement"
              ? iterator.body.body.map((statement: AnyNode) =>
                  statement.type === "ExpressionStatement" &&
                  statement.expression.type === "YieldExpression"
                    ? unwrapExpression(statement.expression.argument)
                    : undefined,
                )
              : undefined;
          evaluated = {
            ...evaluated,
            arrayIteratorElements: elements?.every(
              (element: AnyNode) => element?.type === "Literal",
            )
              ? elements
              : null,
          };
        }
        if (
          assignment.left.type === "MemberExpression" &&
          assignment.left.object.type === "Identifier"
        ) {
          const member = assignment.left;
          const objects = new Map(evaluated.objects);
          const object = objects.get(evaluated.resolveBinding(member.object));
          if (object)
            for (const [binding, candidate] of objects)
              if (candidate === object) objects.delete(binding);
          evaluated = { ...evaluated, objects };
          const property = member.computed
            ? knownLiteral(member.property, target)
            : member.property.name;
          if (property === "statusCode" || property === "status") {
            const error = target.bindings?.get(target.resolveBinding(member.object));
            const errors = new Map(evaluated.errors);
            const previous = error && errorStatus(error, target);
            const operand =
              evaluated.value && "literal" in evaluated.value ? evaluated.value.literal : undefined;
            const status =
              assignment.operator === "="
                ? operand
                : typeof previous === "number" && typeof operand === "number"
                  ? compoundStatus(assignment.operator, previous, operand)
                  : undefined;
            if (error) errors.set(error.id, typeof status === "number" ? status : "throw");
            return { ...evaluated, errors };
          }
        }
        if (assignment.left.type === "Identifier") {
          const next = new Map(evaluated.conditions);
          const values = new Map(evaluated.bindings);
          const functions = new Map(evaluated.functions);
          const objects = new Map(evaluated.objects);
          const binding = evaluated.resolveBinding(assignment.left);
          if (
            binding?.__doctorParent?.type === "FunctionExpression" &&
            binding.__doctorParent.id === binding
          )
            return { ...evaluated, outcome: "throw" };
          functions.delete(binding);
          objects.delete(binding);
          const source = unwrapExpression(assignment.right);
          const fn = isLocalCallable(source)
            ? source
            : source?.type === "Identifier"
              ? evaluated.functions?.get(evaluated.resolveBinding(source))
              : undefined;
          if (binding && assignment.operator === "=" && fn) functions.set(binding, fn);
          const object =
            source?.type === "ObjectExpression"
              ? source
              : source?.type === "Identifier"
                ? evaluated.objects?.get(evaluated.resolveBinding(source))
                : undefined;
          if (binding && assignment.operator === "=" && object) objects.set(binding, object);
          values.delete(binding);
          const value = assignment.operator === "=" ? evaluated.value : undefined;
          if (value && "error" in value) values.set(binding, value.error);
          const literals = new Map(evaluated.literals);
          const promises = new Map(evaluated.promises);
          if (binding) {
            literals.delete(binding);
            promises.delete(binding);
            if (value && "literal" in value) literals.set(binding, value);
            if (value && "promise" in value) promises.set(binding, value);
          }
          next.delete(conditionKey(assignment.left, evaluated));
          if (
            assignment.operator === "=" &&
            assignment.right.type === "Literal" &&
            typeof assignment.right.value === "boolean" &&
            conditions.has(assignment.left.name)
          )
            next.set(conditionKey(assignment.left, evaluated), assignment.right.value);
          return {
            ...evaluated,
            bindings: values,
            functions,
            objects,
            conditions: next,
            literals,
            promises,
          };
        }
        const values = new Map(evaluated.bindings);
        const functions = new Map(evaluated.functions);
        const next = new Map(evaluated.conditions);
        for (const name of bindingNames(assignment.left)) {
          values.delete(evaluated.resolveBinding({ name } as AnyNode, assignment.left));
          functions.delete(evaluated.resolveBinding({ name } as AnyNode, assignment.left));
          next.delete(conditionKey({ name } as AnyNode, evaluated, assignment.left));
        }
        return { ...evaluated, bindings: values, functions, conditions: next };
      });
  }
  if (node.type === "LogicalExpression") {
    if (node.operator === "??")
      return outcomes(node.left, normal, bindings, conditions).flatMap((current) => {
        if (current.outcome !== "normal") return [current];
        const value = current.value;
        if (value && ("error" in value || "promise" in value || value.literal != null))
          return [current];
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
            ? {
                ...final,
                outcome:
                  (typeof current.outcome === "number" ||
                    current.outcome === "server-error" ||
                    current.outcome === "throw") &&
                  current.value &&
                  "error" in current.value
                    ? (errorStatus(current.value.error, final) ?? current.outcome)
                    : current.outcome,
                label: current.label,
                value: current.value,
              }
            : final,
        ),
      );
    }
    return paths;
  }
  if (
    node.type === "BinaryExpression" &&
    ["===", "!==", "==", "!=", "<", "<=", ">", ">=", "instanceof"].includes(node.operator)
  ) {
    return outcomes(node.left, normal, bindings, conditions).flatMap((left) => {
      if (left.outcome !== "normal") return [left];
      const leftValue = left.value;
      return outcomes(node.right, left, bindings, conditions).map((right) => {
        if (right.outcome !== "normal") return right;
        const rightValue = right.value;
        let value: Value | undefined;
        if (
          node.operator === "instanceof" &&
          leftValue &&
          "error" in leftValue &&
          node.right.type === "Identifier" &&
          node.right.name === "Error" &&
          !right.resolveBinding(node.right) &&
          leftValue.error.instanceofError === true
        )
          value = { literal: true };
        if (leftValue && "literal" in leftValue && rightValue && "literal" in rightValue) {
          const a = leftValue.literal;
          const b = rightValue.literal;
          if (node.operator === "===") value = { literal: a === b };
          else if (node.operator === "!==") value = { literal: a !== b };
          else if (
            (typeof a === "number" || typeof a === "string") &&
            (typeof b === "number" || typeof b === "string")
          ) {
            const comparisons: Record<string, boolean> = {
              "==": a == b,
              "!=": a != b,
              "<": a < b,
              "<=": a <= b,
              ">": a > b,
              ">=": a >= b,
            };
            value = { literal: comparisons[node.operator] };
          }
        }
        return { ...right, value };
      });
    });
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
              : node.type === "TaggedTemplateExpression"
                ? [node.tag, ...node.quasi.expressions]
                : undefined;
  if (children) {
    let paths: Path[] = [normal];
    for (const child of children)
      paths = paths.flatMap((current) =>
        current.outcome === "normal" ? outcomes(child, current, bindings, conditions) : [current],
      );
    if (node.type === "UnaryExpression")
      return paths.map((current) => {
        if (current.outcome !== "normal" || !current.value || !("literal" in current.value))
          return { ...current, value: undefined };
        const value = current.value.literal;
        const literal =
          node.operator === "!"
            ? !value
            : node.operator === "void"
              ? undefined
              : node.operator === "+" && (typeof value === "number" || typeof value === "string")
                ? +value
                : node.operator === "-" && typeof value === "number"
                  ? -value
                  : node.operator === "~" && typeof value === "number"
                    ? ~value
                    : node.operator === "typeof"
                      ? typeof value
                      : undefined;
        return { ...current, value: { literal } };
      });
    if (node.type === "TaggedTemplateExpression")
      return paths.flatMap((current) =>
        current.outcome === "normal"
          ? outcomes(
              {
                type: "CallExpression",
                callee: node.tag,
                arguments: [{ type: "UnknownExpression" }, ...node.quasi.expressions],
              } as AnyNode,
              current,
              bindings,
              conditions,
              [undefined, ...node.quasi.expressions.map(() => undefined)],
              [{ type: "UnknownExpression" }, ...node.quasi.expressions],
            )
          : [current],
      );
    return node.type === "SequenceExpression"
      ? paths
      : paths.map((current) => ({ ...current, value: undefined }));
  }
  if (node.type === "MemberExpression") {
    return outcomes(node.object, normal, bindings, conditions).flatMap((object) => {
      if (object.outcome !== "normal") return [object];
      const objectValue = object.value;
      const properties = node.computed
        ? outcomes(node.property, object, bindings, conditions)
        : [object];
      return properties.map((current) => {
        if (current.outcome !== "normal") return current;
        if (
          !node.optional &&
          ((objectValue && "literal" in objectValue && objectValue.literal == null) ||
            (node.object.type === "Identifier" &&
              node.object.name === "undefined" &&
              !current.resolveBinding(node.object)))
        )
          return { ...current, outcome: "throw" };
        const property = node.computed
          ? current.value && "literal" in current.value
            ? current.value.literal
            : undefined
          : node.property.name;
        const status =
          objectValue && "error" in objectValue
            ? errorStatus(objectValue.error, current)
            : undefined;
        return {
          ...current,
          value:
            (property === "statusCode" || property === "status") && typeof status === "number"
              ? { literal: status }
              : property === "then" && objectValue && "promise" in objectValue
                ? objectValue
                : undefined,
        };
      });
    });
  }
  let call =
    assignment.type === "AwaitExpression" ? unwrapExpression(assignment.argument) : assignment;
  if (
    assignment.type === "AwaitExpression" &&
    call.type !== "CallExpression" &&
    call.type !== "NewExpression"
  ) {
    if (call.type === "ConditionalExpression")
      return conditionPaths(call.test, normal, bindings, conditions).flatMap(({ path, value }) =>
        path.outcome === "normal"
          ? outcomes(
              { ...assignment, argument: value ? call.consequent : call.alternate },
              path,
              bindings,
              conditions,
            )
          : [path],
      );
    if (call.type === "SequenceExpression") {
      let paths: Path[] = [normal];
      for (const expression of call.expressions.slice(0, -1))
        paths = paths.flatMap((current) =>
          current.outcome === "normal"
            ? outcomes(expression, current, bindings, conditions)
            : [current],
        );
      return paths.flatMap((current) =>
        current.outcome === "normal"
          ? outcomes(
              { ...assignment, argument: call.expressions.at(-1) },
              current,
              bindings,
              conditions,
            )
          : [current],
      );
    }
    if (call.type === "LogicalExpression" && call.operator === "??")
      return outcomes(call.left, normal, bindings, conditions).flatMap((path) => {
        if (path.outcome !== "normal") return [path];
        const value = path.value;
        const right =
          value && "literal" in value && value.literal != null
            ? []
            : outcomes({ ...assignment, argument: call.right }, path, bindings, conditions);
        return value && ("error" in value || "promise" in value || value.literal != null)
          ? [path]
          : value
            ? right
            : [path, ...right];
      });
    if (call.type === "LogicalExpression")
      return conditionPaths(call.left, normal, bindings, conditions).flatMap(({ path, value }) =>
        path.outcome === "normal" && value === (call.operator === "&&")
          ? outcomes({ ...assignment, argument: call.right }, path, bindings, conditions)
          : [path],
      );
    return outcomes(call, normal, bindings, conditions).map((current) =>
      current.outcome === "normal" && current.value && "promise" in current.value
        ? { ...current, ...current.value.promise }
        : current,
    );
  }
  if (!argumentValues && (call.type === "CallExpression" || call.type === "NewExpression")) {
    const target = unwrapExpression(call.callee);
    const adoptingArguments =
      (assignment.type === "AwaitExpression" || path.adoptingAsync) &&
      target?.type === "MemberExpression" &&
      target.object.type === "Identifier" &&
      target.object.name === "Promise" &&
      !path.resolveBinding(target.object) &&
      (target.computed ? knownLiteral(target.property, path) : target.property.name) === "all" &&
      unwrapExpression(call.arguments[0])?.type === "ArrayExpression";
    let paths = outcomes(
      call.callee,
      { ...normal, adoptingAsync: false },
      bindings,
      conditions,
    ).map((current) => ({
      path: current,
      values: [] as (Value | undefined)[],
      arguments: [] as AnyNode[],
    }));
    for (const argument of call.arguments) {
      paths = paths.flatMap(({ path: current, values, arguments: evaluatedArguments }) => {
        const evaluate = (
          item: AnyNode,
          state: Path,
          items: AnyNode[],
          itemValues: (Value | undefined)[],
        ): typeof paths => {
          if (state.outcome !== "normal")
            return [{ path: state, values: itemValues, arguments: items }];
          const operand =
            item.type === "SpreadElement" ? unwrapExpression(item.argument) : undefined;
          if (operand?.type === "ArrayExpression" && state.arrayIteratorElements !== null) {
            const elements: AnyNode[] = state.arrayIteratorElements ?? operand.elements;
            return elements.reduce<typeof paths>(
              (results, element) =>
                results.flatMap((result) =>
                  evaluate(
                    element ?? { type: "Literal", value: undefined },
                    result.path,
                    result.arguments,
                    result.values,
                  ),
                ),
              [{ path: state, values: itemValues, arguments: items }],
            );
          }
          return outcomes(
            item.type === "SpreadElement" ? item.argument : item,
            adoptingArguments ? { ...state, adoptingAsync: true } : state,
            bindings,
            conditions,
          ).map((evaluated) => ({
            path: { ...evaluated, adoptingAsync: state.adoptingAsync },
            values: [...itemValues, evaluated.value],
            arguments: [...items, item],
          }));
        };
        return evaluate(argument, current, evaluatedArguments, values);
      });
    }
    return paths.flatMap(({ path: current, values, arguments: evaluatedArguments }) => {
      if (current.outcome !== "normal") return [current];
      if (
        call.type === "CallExpression" &&
        target?.type === "MemberExpression" &&
        !call.arguments.length &&
        (target.computed ? knownLiteral(target.property, current) : target.property.name) ===
          "then" &&
        current.value &&
        "promise" in current.value
      )
        return [
          path.adoptingAsync || assignment.type === "AwaitExpression"
            ? { ...current, ...current.value.promise }
            : current,
        ];
      return outcomes(
        node,
        { ...current, adoptingAsync: path.adoptingAsync },
        bindings,
        conditions,
        values,
        evaluatedArguments,
      );
    });
  }
  if (evaluatedArguments) call = { ...call, arguments: evaluatedArguments };
  let callee = unwrapExpression(call.callee);
  if (
    (assignment.type === "AwaitExpression" || path.adoptingAsync) &&
    callee?.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Promise" &&
    !path.resolveBinding(callee.object) &&
    (callee.computed ? knownLiteral(callee.property, path) : callee.property.name) === "reject"
  ) {
    const rejection = argumentValues?.[0];
    return [
      {
        ...normal,
        outcome:
          rejection && "error" in rejection
            ? (errorStatus(rejection.error, path) ?? "throw")
            : "throw",
        value: rejection,
      },
    ];
  }
  if (callee?.type === "Identifier") callee = path.functions?.get(path.resolveBinding(callee));
  if (callee?.type === "MemberExpression" && callee.object.type === "Identifier") {
    const object = path.objects?.get(path.resolveBinding(callee.object));
    const key = callee.computed ? knownLiteral(callee.property, path) : callee.property.name;
    const properties = object?.properties ?? [];
    const index = properties.findLastIndex(
      (item: AnyNode) =>
        item.type !== "SpreadElement" &&
        (item.computed ? knownLiteral(item.key, path) : (item.key.name ?? item.key.value)) === key,
    );
    if (
      index !== -1 &&
      !properties
        .slice(index + 1)
        .some(
          (item: AnyNode) =>
            item.type === "SpreadElement" ||
            (item.computed && knownLiteral(item.key, path) === undefined),
        )
    ) {
      const property = properties[index];
      if (property.kind === "init") callee = unwrapExpression(property.value);
      if (callee?.type === "Identifier") callee = path.functions?.get(path.resolveBinding(callee));
    }
  }
  if (callee?.type === "ClassDeclaration" || callee?.type === "ClassExpression") {
    if (call.type !== "NewExpression") return [{ ...normal, outcome: "throw" }];
    const constructor = callee.body.body.find(
      (member: AnyNode) => member.kind === "constructor" && !member.static,
    )?.value;
    if (!constructor && callee.superClass) {
      const baseClass = path.superClasses?.get(callee);
      if (baseClass?.type === "ClassDeclaration" || baseClass?.type === "ClassExpression")
        return outcomes(
          { ...call, callee: baseClass } as AnyNode,
          normal,
          bindings,
          conditions,
          argumentValues,
          evaluatedArguments,
        );
    }
    if (!constructor) return [normal];
    callee = constructor;
  }
  if (
    call.type === "NewExpression" &&
    (callee?.type === "ArrowFunctionExpression" || callee?.async || callee?.generator)
  )
    return [{ ...normal, outcome: "throw" }];
  if (
    call.type === "CallExpression" &&
    isFunction(callee) &&
    callee.async &&
    !callee.generator &&
    assignment.type !== "AwaitExpression" &&
    !path.adoptingAsync
  ) {
    return outcomes(
      assignment,
      { ...normal, adoptingAsync: true },
      bindings,
      conditions,
      argumentValues,
      evaluatedArguments,
    ).map((result) => ({
      ...result,
      outcome: "normal",
      adoptingAsync: path.adoptingAsync,
      value:
        result.outcome === "normal"
          ? undefined
          : { promise: { outcome: result.outcome, value: result.value } },
    }));
  }
  if (
    (call.type === "CallExpression" ||
      (call.type === "NewExpression" && callee?.type !== "ArrowFunctionExpression")) &&
    isFunction(callee) &&
    (!callee.async || assignment.type === "AwaitExpression" || path.adoptingAsync) &&
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
    const objects = new Map(path.objects);
    const promises = new Map(path.promises);
    if (
      callee.type === "FunctionExpression" &&
      callee.id &&
      path.resolveBinding(callee.id) === callee.id
    )
      shadows.add(callee.id.name);
    const localConditions = new Map(path.conditions);
    const localLiterals = new Map(path.literals);
    for (const name of shadows) {
      localLiterals.delete(path.resolveBinding({ name } as AnyNode, callee));
      local.delete(path.resolveBinding({ name } as AnyNode, callee));
      functions.delete(path.resolveBinding({ name } as AnyNode, callee));
      objects.delete(path.resolveBinding({ name } as AnyNode, callee));
      promises.delete(path.resolveBinding({ name } as AnyNode, callee));
      localConditions.delete(conditionKey({ name } as AnyNode, path, callee));
    }
    if (
      callee.type === "FunctionExpression" &&
      callee.id &&
      path.resolveBinding(callee.id) === callee.id
    )
      functions.set(path.resolveBinding(callee.id), callee);
    let parameterPaths: Path[] = [
      {
        ...normal,
        bindings: local,
        functions,
        objects,
        promises,
        conditions: localConditions,
        literals: localLiterals,
        calls: [...(path.calls ?? []), callee],
        asyncBody: Boolean(callee.async),
        adoptingAsync: false,
        uninitialized: new Set([
          ...(path.uninitialized ?? []),
          ...callee.params.flatMap((param: AnyNode) =>
            bindingNames(param).map((name) => path.resolveBinding({ name } as AnyNode, callee)),
          ),
        ]),
      },
    ];
    for (const [index, param] of callee.params.entries()) {
      const target = param.type === "AssignmentPattern" ? param.left : param;
      const spreadIndex = call.arguments.findIndex(
        (argument: AnyNode) => argument.type === "SpreadElement",
      );
      const uncertain = spreadIndex !== -1 && index >= spreadIndex;
      const supplied = uncertain ? { type: "UnknownExpression" } : call.arguments[index];
      const defaulted =
        param.type === "AssignmentPattern" &&
        (!supplied ||
          (supplied.type === "Literal" && supplied.value === undefined) ||
          isUndefinedArgument(supplied, path.resolveBinding) ||
          (!uncertain &&
            argumentValues?.[index] &&
            "literal" in argumentValues[index] &&
            argumentValues[index].literal === undefined));
      parameterPaths = parameterPaths.flatMap((current) => {
        if (current.outcome !== "normal") return [current];
        const choices =
          uncertain && param.type === "AssignmentPattern" ? [false, true] : [defaulted];
        return choices.flatMap((defaulted) => {
          const evaluated = defaulted
            ? outcomes(param.right, current, local, conditions)
            : [current];
          return evaluated.flatMap((result) => {
            if (result.outcome !== "normal") return [result];
            const uninitialized = new Set(result.uninitialized);
            for (const name of bindingNames(target))
              uninitialized.delete(result.resolveBinding({ name } as AnyNode, callee));
            result = { ...result, uninitialized };
            if (target.type !== "Identifier")
              return patternOutcomes(
                target,
                defaulted ? param.right : supplied,
                result,
                conditions,
                defaulted ? result : path,
              );
            const arg = defaulted ? param.right : supplied;
            const source = defaulted ? result : path;
            const value = defaulted
              ? result.value
              : uncertain
                ? undefined
                : argumentValues?.[index];
            const error = value && "error" in value ? value.error : undefined;
            const values = new Map(result.bindings);
            if (error) values.set(result.resolveBinding(target), error);
            const booleans = new Map(result.conditions);
            const boolean =
              arg?.type === "Literal" && typeof arg.value === "boolean"
                ? arg.value
                : arg?.type === "Identifier"
                  ? source.conditions.get(conditionKey(arg, source))
                  : undefined;
            if (boolean !== undefined) booleans.set(conditionKey(target, result), boolean);
            const literals = new Map(result.literals);
            const objects = new Map(result.objects);
            const functions = new Map(result.functions);
            const promises = new Map(result.promises);
            const binding = result.resolveBinding(target);
            const object =
              arg?.type === "Identifier"
                ? source.objects?.get(source.resolveBinding(arg))
                : arg?.type === "ObjectExpression"
                  ? arg
                  : undefined;
            if (object) objects.set(binding, object);
            const fn =
              arg?.type === "Identifier"
                ? source.functions?.get(source.resolveBinding(arg))
                : isLocalCallable(arg)
                  ? arg
                  : undefined;
            if (fn) functions.set(binding, fn);
            literals.delete(binding);
            if (value && "literal" in value) literals.set(binding, value);
            promises.delete(binding);
            if (value && "promise" in value) promises.set(binding, value);
            return {
              ...result,
              bindings: values,
              conditions: booleans,
              literals,
              objects,
              functions,
              promises,
            };
          });
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
          [...(current.bindings ?? [])].filter(
            ([name]) =>
              bindings.has(name) ||
              path.resolveBinding({ name: name?.name } as AnyNode, node) === name,
          ),
        );
        const restoredFunctions = new Map(current.functions);
        const restoredObjects = new Map(current.objects);
        const restoredConditions = new Map(current.conditions);
        const restoredLiterals = new Map(current.literals);
        const restoredPromises = new Map(current.promises);
        for (const name of shadows) {
          const binding = path.resolveBinding({ name } as AnyNode, callee);
          restored.delete(binding);
          restoredFunctions.delete(binding);
          restoredObjects.delete(binding);
          restoredLiterals.delete(binding);
          restoredPromises.delete(binding);
          if (path.literals?.has(binding))
            restoredLiterals.set(binding, path.literals.get(binding)!);
          if (path.promises?.has(binding))
            restoredPromises.set(binding, path.promises.get(binding)!);
          const key = conditionKey({ name } as AnyNode, path, callee);
          restoredConditions.delete(key);
          if (bindings.has(binding)) restored.set(binding, bindings.get(binding)!);
          if (path.functions?.has(binding))
            restoredFunctions.set(binding, path.functions.get(binding)!);
          if (path.objects?.has(binding)) restoredObjects.set(binding, path.objects.get(binding)!);
          if (path.conditions.has(key)) restoredConditions.set(key, path.conditions.get(key)!);
        }
        const returnedValue =
          current.outcome === "exit" || callee.body.type !== "BlockStatement"
            ? current.value
            : undefined;
        const adopted =
          (assignment.type === "AwaitExpression" || path.adoptingAsync) &&
          returnedValue &&
          "promise" in returnedValue
            ? returnedValue.promise
            : undefined;
        return {
          ...current,
          outcome: adopted?.outcome ?? (current.outcome === "exit" ? "normal" : current.outcome),
          value: adopted?.value ?? returnedValue,
          bindings: restored,
          functions: restoredFunctions,
          objects: restoredObjects,
          conditions: restoredConditions,
          literals: restoredLiterals,
          promises: restoredPromises,
          calls: path.calls,
          asyncBody: path.asyncBody,
          adoptingAsync: path.adoptingAsync,
        };
      });
  }
  if (!isFunction(node)) {
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const target = unwrapExpression(node.callee);
      if (
        node.type === "CallExpression" &&
        target?.type === "MemberExpression" &&
        target.object.type === "Identifier" &&
        target.object.name === "Object" &&
        !path.resolveBinding(target.object) &&
        (target.computed ? knownLiteral(target.property, path) : target.property.name) ===
          "assign" &&
        node.arguments[0]?.type === "Identifier"
      ) {
        const error = bindings.get(path.resolveBinding(node.arguments[0]));
        if (error) {
          const errors = new Map(normal.errors);
          for (const source of node.arguments.slice(1)) {
            const object = resolvedObject(source, normal);
            if (!object) {
              errors.set(error.id, "throw");
              continue;
            }
            const applyWrites = (source: AnyNode, visited: Set<AnyNode>) => {
              if (visited.has(source)) return;
              visited.add(source);
              for (const property of source.properties) {
                if (property.type === "SpreadElement") {
                  const spread = resolvedObject(property.argument, normal);
                  if (spread) applyWrites(spread, visited);
                  else errors.set(error.id, "throw");
                  continue;
                }
                const key = property.computed
                  ? knownLiteral(property.key, normal)
                  : (property.key?.name ?? property.key?.value);
                if (key === "statusCode" || key === "status")
                  errors.set(error.id, numericStatus(property.value, normal) ?? "throw");
                else if (property.computed && key === undefined) errors.set(error.id, "throw");
              }
              visited.delete(source);
            };
            applyWrites(object, new Set());
          }
          return [{ ...normal, errors, value: { error } }];
        }
      }
      if (["Literal", "ObjectExpression", "ArrayExpression"].includes(target?.type))
        return [{ ...normal, outcome: "throw" }];
      if (target?.type === "Identifier") {
        const binding = path.resolveBinding(target);
        const literal = path.literals?.get(binding);
        if (
          literal ||
          path.objects?.has(binding) ||
          (binding && path.functions?.has(binding) === false && path.bindings?.has(binding))
        )
          return [{ ...normal, outcome: "throw" }];
      }
    }
    const values = new Map(bindings);
    for (const binding of values.keys())
      if (!stableBinding(node, binding?.name)) values.delete(binding);
    walkScriptLocal(node, (child) => {
      if (child.type !== "CallExpression") return;
      for (const reference of [child.callee, ...child.arguments]) {
        if (reference.type !== "Identifier") continue;
        const fn = path.functions?.get(path.resolveBinding(reference));
        if (!fn) continue;
        for (const binding of values.keys())
          if (!stableBinding(fn, binding?.name)) values.delete(binding);
      }
    });
    const literals = new Map(path.literals);
    for (const binding of literals.keys())
      if (binding.type === "Identifier" && !stableBinding(node, binding.name))
        literals.delete(binding);
    const objects = new Map(normal.objects);
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = unwrapExpression(node.callee);
      if (!isH3Reference(callee, "createError", path.resolveBinding)) {
        for (const argument of node.arguments) {
          const reference = unwrapExpression(
            argument.type === "SpreadElement" ? argument.argument : argument,
          );
          if (reference?.type !== "Identifier") continue;
          const object = objects.get(normal.resolveBinding(reference));
          if (object)
            for (const [binding, candidate] of objects)
              if (candidate === object) objects.delete(binding);
        }
      }
    }
    return [{ ...normal, bindings: values, literals, objects }];
  }
  return [normal];
}

function knownLiteral(node: AnyNode, path: Path): unknown {
  node = unwrapExpression(node);
  return node?.type === "Identifier"
    ? path.literals?.get(path.resolveBinding(node))?.literal
    : node?.type === "Literal"
      ? node.value
      : undefined;
}

function knownNullish(node: AnyNode, path: Path): boolean {
  node = unwrapExpression(node);
  if (node?.type === "Literal") return node.value == null;
  if (node?.type !== "Identifier") return false;
  const binding = path.resolveBinding(node);
  return binding
    ? path.literals?.has(binding) === true && path.literals.get(binding)?.literal == null
    : node.name === "undefined";
}

function shortCircuitsChain(node: AnyNode, path: Path): boolean {
  node = unwrapExpression(node);
  if (node.type === "MemberExpression")
    return (
      (node.optional && knownNullish(node.object, path)) || shortCircuitsChain(node.object, path)
    );
  if (node.type === "CallExpression")
    return (
      (node.optional && knownNullish(node.callee, path)) || shortCircuitsChain(node.callee, path)
    );
  return false;
}

function patternOutcomes(
  pattern: AnyNode,
  source: AnyNode,
  path: Path,
  conditions: Set<string>,
  parameterSource?: Path,
): Path[] {
  if (path.outcome !== "normal" || !pattern) return [path];
  source = unwrapExpression(source);
  if (pattern.type === "Identifier" && parameterSource) {
    const sourceBinding =
      source?.type === "Identifier" ? parameterSource.resolveBinding(source) : undefined;
    const error = parameterSource.bindings?.get(sourceBinding);
    const literal = knownLiteral(source, parameterSource);
    const binding = path.resolveBinding(pattern);
    const values = new Map(path.bindings);
    const literals = new Map(path.literals);
    const booleans = new Map(path.conditions);
    if (error) values.set(binding, error);
    if (literal !== undefined) literals.set(binding, { literal });
    if (typeof literal === "boolean") booleans.set(conditionKey(pattern, path), literal);
    return [{ ...path, bindings: values, literals, conditions: booleans }];
  }
  if (pattern.type === "AssignmentPattern") {
    const missing =
      !source ||
      (source.type === "Literal" && source.value === undefined) ||
      isUndefinedArgument(source, path.resolveBinding);
    const known =
      source?.type === "Literal" ||
      source?.type === "ObjectExpression" ||
      source?.type === "ArrayExpression";
    const defaults = () =>
      outcomes(pattern.right, path, path.bindings ?? new Map(), conditions).flatMap((current) =>
        patternOutcomes(
          pattern.left,
          pattern.right,
          current,
          conditions,
          parameterSource ? current : undefined,
        ),
      );
    return missing
      ? defaults()
      : known
        ? patternOutcomes(pattern.left, source, path, conditions, parameterSource)
        : [
            ...patternOutcomes(pattern.left, source, path, conditions, parameterSource),
            ...defaults(),
          ];
  }
  const entries: [AnyNode, AnyNode, AnyNode?][] = [];
  if (pattern.type === "ObjectPattern") {
    if (knownNullish(source, parameterSource ?? path)) return [{ ...path, outcome: "throw" }];
    for (const property of pattern.properties) {
      if (property.type === "RestElement") continue;
      const key = property.computed
        ? knownLiteral(property.key, path)
        : (property.key.name ?? property.key.value);
      const properties = source?.type === "ObjectExpression" ? source.properties : undefined;
      const uncertain =
        !properties ||
        properties.some(
          (item: AnyNode) =>
            item.type === "SpreadElement" ||
            (item.computed && knownLiteral(item.key, parameterSource ?? path) === undefined),
        );
      const matching = properties?.findLast(
        (item: AnyNode) =>
          (item.computed
            ? knownLiteral(item.key, parameterSource ?? path)
            : (item.key?.name ?? item.key?.value)) === key,
      );
      entries.push([
        property.value,
        uncertain ? { type: "UnknownExpression" } : matching?.value,
        property.computed ? property.key : undefined,
      ]);
    }
  } else if (pattern.type === "ArrayPattern") {
    if (knownNullish(source, parameterSource ?? path)) return [{ ...path, outcome: "throw" }];
    for (const [index, element] of pattern.elements.entries()) {
      if (element)
        entries.push([
          element,
          source?.type === "ArrayExpression"
            ? source.elements[index]
            : typeof knownLiteral(source, parameterSource ?? path) === "string"
              ? {
                  type: "Literal",
                  value: Array.from(knownLiteral(source, parameterSource ?? path) as string)[index],
                }
              : { type: "UnknownExpression" },
        ]);
    }
  }
  return entries.reduce(
    (paths, [target, value, key]) =>
      paths.flatMap((current) => {
        if (current.outcome !== "normal") return [current];
        const evaluated = key
          ? outcomes(key, current, current.bindings ?? new Map(), conditions)
          : [current];
        return evaluated.flatMap((result) =>
          patternOutcomes(target, value, result, conditions, parameterSource),
        );
      }),
    [path],
  );
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
  const initial =
    node.type === "ForStatement" && node.init
      ? outcomes(node.init, path, bindings, conditions)
      : node.type === "ForInStatement" || node.type === "ForOfStatement"
        ? outcomes(node.right, path, bindings, conditions)
        : [path];
  const right = unwrapExpression(node.right);
  const pending = initial.map((current) => ({
    current,
    index: 0,
    elements:
      node.type === "ForOfStatement" && current.arrayIteratorElements !== null
        ? (current.arrayIteratorElements ??
          (right?.type === "ArrayExpression" ? right.elements : undefined))
        : undefined,
  }));
  const seen = new Set<string>();
  const iteration = (element: AnyNode) =>
    ({
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
                        init: node.await ? { type: "AwaitExpression", argument: element } : element,
                      })),
                    }
                  : {
                      type: "AssignmentExpression",
                      operator: "=",
                      left: node.left,
                      right: node.await ? { type: "AwaitExpression", argument: element } : element,
                    },
                node.body,
              ],
            }
          : node.body,
      alternate: { type: "BreakStatement" },
    }) as AnyNode;
  let first = node.type === "DoWhileStatement";
  while (pending.length) {
    const { current, index, elements } = pending.pop()!;
    if (current.outcome !== "normal") {
      result.push(current);
      continue;
    }
    if (elements?.length === 0) {
      result.push(current);
      continue;
    }
    const key = pathKey([loopStateKey(current), index]);
    if (!first && seen.has(key)) continue;
    if (!first) seen.add(key);
    const element = elements?.[index] ?? { type: "Identifier", name: "" };
    const paths = outcomes(first ? node.body : iteration(element), current, bindings, conditions);
    first = false;
    for (const next of paths) {
      if (next.label && !labels.has(next.label)) result.push(next);
      else if (next.outcome === "break")
        result.push({ ...next, outcome: "normal", label: undefined });
      else if (next.outcome === "normal" || next.outcome === "continue") {
        const updated = outcomes(node.update, next, bindings, conditions);
        if (elements?.length && index + 1 >= elements.length)
          result.push(...updated.map((current) => ({ ...current, outcome: "normal" as const })));
        else
          pending.push(
            ...updated.map((current) => ({
              current,
              index: elements?.length ? index + 1 : 0,
              elements,
            })),
          );
      } else result.push(next);
    }
  }
  return result;
}

function loopStateKey(current: Path): string {
  return pathKey([
    [...current.conditions].sort(([left], [right]) => left.localeCompare(right)),
    [...(current.errors ?? [])],
    [...(current.literals ?? [])].map(([binding, value]) => [binding.start, value]),
    [...(current.bindings ?? [])].map(([binding, value]) => [binding?.start, value]),
    [...(current.functions ?? [])].map(([binding, fn]) => [binding.start, fn.start]),
    [...(current.objects ?? [])].map(([binding, object]) => [binding.start, object.start]),
    [...(current.uninitialized ?? [])].map((binding) => binding.start),
  ]);
}

function catchOutcomes(
  handler: AnyNode,
  path: Path,
  bindings: Bindings,
  conditions: Set<string>,
): Path[] {
  const caught = new Map(path.bindings ?? bindings);
  if (handler.param?.type === "Identifier") caught.delete(path.resolveBinding(handler.param));
  const name =
    handler.param?.type === "Identifier" ? path.resolveBinding(handler.param) : undefined;
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
        ? errorStatus(values.get(current.resolveBinding(guarded)), current)
        : undefined;
    const known =
      typeof caught === "number"
        ? true
        : current.value
          ? "error" in current.value || "promise" in current.value || Boolean(current.value.literal)
          : valueNode.type === "Literal"
            ? Boolean(valueNode.value)
            : valueNode.type === "Identifier"
              ? values.has(current.resolveBinding(valueNode)) ||
                current.functions?.has(current.resolveBinding(valueNode)) ||
                current.objects?.has(current.resolveBinding(valueNode))
                ? true
                : current.conditions.get(conditionKey(valueNode, current))
              : undefined;
    if (known !== undefined) return [{ path: current, value: known }];
    return [true, false].map((value) => ({
      path:
        valueNode.type === "Identifier" && conditions.has(valueNode.name)
          ? {
              ...current,
              conditions: new Map(current.conditions).set(conditionKey(valueNode, current), value),
            }
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
      "TSNonNullExpression",
    ].includes(node?.type)
  )
    node = node.expression;
  return node;
}

function isArrayIterator(node: AnyNode, path: Path): boolean {
  if (node?.type !== "MemberExpression" || !node.computed) return false;
  const prototype = unwrapExpression(node.object);
  return (
    prototype?.type === "MemberExpression" &&
    !prototype.computed &&
    prototype.object?.type === "Identifier" &&
    prototype.object.name === "Array" &&
    !path.resolveBinding(prototype.object) &&
    prototype.property.name === "prototype" &&
    node.property?.type === "MemberExpression" &&
    !node.property.computed &&
    node.property.object?.type === "Identifier" &&
    node.property.object.name === "Symbol" &&
    !path.resolveBinding(node.property.object) &&
    node.property.property.name === "iterator"
  );
}

function isH3Reference(node: AnyNode, name: string, resolve: Path["resolveBinding"]): boolean {
  if (node?.type === "MemberExpression") {
    const key = node.computed ? node.property.value : node.property.name;
    if (key !== name || node.object.type !== "Identifier") return false;
    const specifier = resolve(node.object)?.__doctorParent;
    const declaration = specifier?.__doctorParent;
    return (
      specifier?.type === "ImportNamespaceSpecifier" &&
      declaration?.type === "ImportDeclaration" &&
      declaration.importKind !== "type" &&
      declaration.source.value === "h3"
    );
  }
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

function numericStatus(
  node: AnyNode,
  path: Path,
  visited = new Set<AnyNode>(),
): number | undefined {
  node = unwrapExpression(node);
  if (visited.has(node)) return;
  visited.add(node);
  const literal = knownLiteral(node, path);
  if (typeof literal === "number") return literal;
  if (node?.type === "MemberExpression") {
    const object = resolvedObject(node.object, path);
    const key = node.computed ? knownLiteral(node.property, path) : node.property.name;
    if (object && key !== undefined) {
      for (const property of [...object.properties].reverse()) {
        if (
          property.type === "SpreadElement" ||
          (property.computed && knownLiteral(property.key, path) === undefined)
        )
          return;
        const propertyKey = property.computed
          ? knownLiteral(property.key, path)
          : (property.key?.name ?? property.key?.value);
        if (propertyKey === key) return numericStatus(property.value, path, visited);
      }
    }
  }
  if (node?.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-")) {
    const value = numericStatus(node.argument, path, visited);
    return value === undefined ? undefined : node.operator === "-" ? -value : value;
  }
  if (node?.type !== "BinaryExpression") return;
  const left = numericStatus(node.left, path, visited);
  const right = numericStatus(node.right, path, visited);
  if (left === undefined || right === undefined) return;
  if (node.operator === "+") return left + right;
  if (node.operator === "-") return left - right;
  if (node.operator === "*") return left * right;
  if (node.operator === "/") return left / right;
}

function resolvedObject(node: AnyNode, path: Path): AnyNode {
  node = unwrapExpression(node);
  const object = node?.type === "Identifier" ? path.objects?.get(path.resolveBinding(node)) : node;
  return object?.type === "ObjectExpression" ? object : undefined;
}

function moduleBindings(
  root: AnyNode,
  enclosingFunction: AnyNode,
  resolveBinding: Path["resolveBinding"],
): Pick<Path, "literals" | "objects"> {
  const literals = new Map<AnyNode, { literal: unknown }>();
  const objects = new Map<AnyNode, AnyNode>();
  let containing = enclosingFunction;
  while (containing?.__doctorParent && containing.__doctorParent !== root)
    containing = containing.__doctorParent;
  if (root.type !== "Program" || !containing) return { literals, objects };
  for (const statement of root.body.slice(0, root.body.indexOf(containing))) {
    const expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;
    if (
      expression?.type === "AssignmentExpression" &&
      expression.left.type === "MemberExpression" &&
      expression.left.object.type === "Identifier"
    ) {
      const binding = resolveBinding(expression.left.object);
      const object = objects.get(binding);
      const key = expression.left.computed
        ? knownLiteral(expression.left.property, {
            outcome: "normal",
            budget: { remaining: 4096 },
            conditions: new Map(),
            resolveBinding,
            literals,
          })
        : expression.left.property.name;
      if (object && (key === "statusCode" || key === "status")) {
        if (expression.operator === "=")
          objects.set(binding, {
            ...object,
            properties: [
              ...object.properties,
              { type: "Property", key: { type: "Identifier", name: key }, value: expression.right },
            ],
          });
        else objects.delete(binding);
      } else if (object && key === undefined) objects.delete(binding);
    }
    const declarationStatement =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      declarationStatement?.type !== "VariableDeclaration" ||
      declarationStatement.kind !== "const"
    )
      continue;
    for (const declaration of declarationStatement.declarations) {
      if (declaration.id.type !== "Identifier") continue;
      const binding = resolveBinding(declaration.id);
      if (!binding) continue;
      if (declaration.init?.type === "Literal")
        literals.set(binding, { literal: declaration.init.value });
      else if (declaration.init?.type === "ObjectExpression")
        objects.set(binding, declaration.init);
    }
  }
  return { literals, objects };
}

function httpStatus(node: AnyNode, path: Path): number | "server-error" | undefined {
  node = unwrapExpression(node);
  const callee = unwrapExpression(node?.callee);
  if (
    ["NewExpression", "CallExpression"].includes(node?.type) &&
    callee?.type === "Identifier" &&
    !path.resolveBinding(callee) &&
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
  if (node?.type !== "CallExpression" || !isH3Reference(callee, "createError", path.resolveBinding))
    return;
  let options = unwrapExpression(node.arguments?.[0]);
  if (options?.type === "Identifier") options = path.objects?.get(path.resolveBinding(options));
  if (!options || (options.type === "Literal" && typeof options.value === "string")) return 500;
  if (options.type !== "ObjectExpression") return;
  const statuses = optionStatuses(options, path, new Set());
  if (statuses.has("statusCode")) return statuses.get("statusCode");
  return statuses.has("status") ? statuses.get("status") : 500;
}

function optionStatuses(
  options: AnyNode,
  path: Path,
  visited: Set<AnyNode>,
): Map<string, number | undefined> {
  const statuses = new Map<string, number | undefined>();
  if (visited.has(options)) return statuses;
  visited.add(options);
  for (const property of options.properties) {
    if (property.type === "SpreadElement") {
      const source = unwrapExpression(property.argument);
      const object =
        source?.type === "Identifier" ? path.objects?.get(path.resolveBinding(source)) : source;
      if (object?.type === "ObjectExpression" && !visited.has(object)) {
        for (const [key, status] of optionStatuses(object, path, visited))
          statuses.set(key, status);
      } else {
        statuses.set("statusCode", undefined);
        statuses.set("status", undefined);
      }
      continue;
    }
    const key = property.computed
      ? knownLiteral(property.key, path)
      : (property.key?.name ?? property.key?.value);
    if (property.computed && key === undefined) {
      statuses.set("statusCode", undefined);
      statuses.set("status", undefined);
    } else if (key === "statusCode" || key === "status") {
      statuses.set(key, numericStatus(property.value, path));
    }
  }
  visited.delete(options);
  return statuses;
}

function lexicalTDZ(node: AnyNode, path: Path): Set<AnyNode> {
  const uninitialized = new Set(path.uninitialized);
  for (const statement of node.body) {
    const patterns =
      statement.type === "VariableDeclaration" && statement.kind !== "var"
        ? statement.declarations.map((declaration: AnyNode) => declaration.id)
        : statement.type === "ClassDeclaration"
          ? [statement.id]
          : [];
    for (const pattern of patterns)
      for (const name of bindingNames(pattern)) {
        const binding =
          statement.type === "ClassDeclaration"
            ? statement.id
            : path.resolveBinding({ name } as AnyNode, pattern);
        if (binding) uninitialized.add(binding);
      }
  }
  return uninitialized;
}

function blockBindings(node: AnyNode): Set<string> {
  const names = new Set<string>();
  for (const statement of node.body) {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
      for (const declaration of statement.declarations)
        for (const name of bindingNames(declaration.id)) names.add(name);
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

function isLocalCallable(node: AnyNode): boolean {
  return isFunction(node) || node?.type === "ClassExpression";
}

function lexicalBindings(root: AnyNode) {
  type Scope = { parent?: Scope; bindings: Map<string, AnyNode>; functionScope?: boolean };
  const scopes = new Map<AnyNode, Scope>();
  const names = new Map<AnyNode, AnyNode>();
  function bind(pattern: AnyNode, scope: Scope) {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      if (!scope.bindings.has(pattern.name)) scope.bindings.set(pattern.name, pattern);
    } else if (pattern.type === "AssignmentPattern") bind(pattern.left, scope);
    else if (pattern.type === "RestElement") bind(pattern.argument, scope);
    else if (pattern.type === "ArrayPattern")
      pattern.elements.forEach((item: AnyNode) => bind(item, scope));
    else if (pattern.type === "ObjectPattern")
      pattern.properties.forEach((item: AnyNode) => bind(item.value ?? item.argument, scope));
  }
  function collect(node: AnyNode, outer: Scope) {
    if (!node?.type) return;
    if (node.type === "FunctionDeclaration" && node.id) {
      bind(node.id, outer);
      names.set(node, outer.bindings.get(node.id.name)!);
    }
    if (node.type === "ClassDeclaration") bind(node.id, outer);
    const scoped =
      isFunction(node) ||
      [
        "BlockStatement",
        "ClassDeclaration",
        "ClassExpression",
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
    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id)
      scope.bindings.set(node.id.name, node);
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
    const uninitialized = lexicalTDZ(
      { type: "BlockStatement", body: cases.flatMap((item) => item.consequent) },
      evaluated,
    );
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
      if (index >= 0) {
        const block = parent;
        prefixes.unshift(
          (path) => [{ ...path, uninitialized: lexicalTDZ(block, path) }],
          parent.body.slice(0, index),
        );
      }
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
    } else if (parent.type === "TryStatement" && child === parent.finalizer) {
      const protectedTry = { ...parent, finalizer: null };
      prefixes.unshift((path) =>
        outcomes(protectedTry, path, new Map(), conditions).map((current) => ({
          ...current,
          outcome: "normal",
          label: undefined,
          value: undefined,
        })),
      );
    } else if (parent.type === "CatchClause") {
      const handler = parent;
      const protectedBlock = parent.__doctorParent.block;
      prefixes.unshift((path) =>
        outcomes(protectedBlock, path, new Map(), conditions)
          .filter(
            (current) =>
              typeof current.outcome === "number" ||
              current.outcome === "throw" ||
              current.outcome === "server-error",
          )
          .map((current) => {
            const bindings = new Map(current.bindings);
            if (handler.param?.type === "Identifier")
              bindings.set(
                current.resolveBinding(handler.param),
                current.value && "error" in current.value
                  ? current.value.error
                  : { id: --current.budget.remaining, status: current.outcome },
              );
            return { ...current, outcome: "normal", value: undefined, bindings };
          }),
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
      prefixes.unshift((path) =>
        outcomes(parent.right, path, new Map(), conditions).flatMap((current) => {
          if (current.outcome !== "normal") return [];
          const right = unwrapExpression(parent.right);
          const elements =
            parent.type === "ForOfStatement" && current.arrayIteratorElements !== null
              ? (current.arrayIteratorElements ??
                (right.type === "ArrayExpression" ? right.elements : undefined))
              : undefined;
          const target =
            parent.left.type === "VariableDeclaration"
              ? parent.left.declarations[0].id
              : parent.left;
          if (
            parent.left.type !== "VariableDeclaration" &&
            bindingNames(target).some((name) => {
              const binding = current.resolveBinding({ name } as AnyNode, target);
              const declaration = binding?.__doctorParent?.__doctorParent;
              return declaration?.type === "VariableDeclaration" && declaration.kind === "const";
            })
          )
            return [];
          const values = elements ?? [{ type: "UnknownExpression" }];
          return values.flatMap((value: AnyNode) =>
            patternOutcomes(
              target,
              value ?? { type: "Literal", value: undefined },
              current,
              conditions,
              current,
            ),
          );
        }),
      );
    } else if (
      (parent.type === "WhileStatement" ||
        parent.type === "ForStatement" ||
        parent.type === "DoWhileStatement") &&
      child === parent.body
    ) {
      prefixes.unshift((path) => {
        const entry =
          parent.type === "ForStatement" && parent.init
            ? outcomes(parent.init, path, new Map(), conditions)
            : [path];
        const pending = [...entry];
        const entries: Path[] = [];
        const seen = new Set<string>();
        const labels = new Set<string>();
        for (
          let ancestor = parent.__doctorParent;
          ancestor?.type === "LabeledStatement";
          ancestor = ancestor.__doctorParent
        )
          if (ancestor.body === parent || ancestor.body?.type === "LabeledStatement")
            labels.add(ancestor.label.name);
        while (pending.length) {
          const current = pending.pop()!;
          if (current.outcome !== "normal") continue;
          const key = loopStateKey(current);
          if (seen.has(key)) continue;
          seen.add(key);
          const test =
            parent.type === "DoWhileStatement" && entries.length === 0
              ? { type: "Literal", value: true }
              : (parent.test ?? { type: "Literal", value: true });
          for (const { path: tested, value } of conditionPaths(
            test,
            current,
            new Map(),
            conditions,
          )) {
            if (tested.outcome !== "normal" || !value) continue;
            entries.push(tested);
            for (const body of outcomes(parent.body, tested, new Map(), conditions)) {
              if (
                body.outcome !== "normal" &&
                !(body.outcome === "continue" && (!body.label || labels.has(body.label)))
              )
                continue;
              pending.push(
                ...outcomes(
                  parent.update,
                  { ...body, outcome: "normal", label: undefined },
                  new Map(),
                  conditions,
                ),
              );
            }
          }
        }
        return entries;
      });
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
