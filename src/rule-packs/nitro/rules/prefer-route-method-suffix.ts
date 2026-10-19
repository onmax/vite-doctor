import {
  type AnyNode,
  createRule,
  nearestFunctionOrProgram,
  report,
  walkScriptLocal,
} from "./shared.js";
import {
  isNitroRouteFile,
  isInIfStatementTest,
  methodChecks,
  routeMethodSuffix,
  routePathWithMethodSuffix,
  singleMethodCheck,
  type MethodCheck,
} from "./request-helpers.js";

const RULE_ID = "nitro/request/prefer-route-method-suffix";

export const preferRouteMethodSuffix = createRule({
  meta: {
    id: "nitro/request/prefer-route-method-suffix",
    title: "Use Nitro route method suffixes",
    description:
      "File-routed Nitro handlers should use HTTP method filename suffixes instead of manual request method gates.",
    why: "Nitro's file router can bind handlers to HTTP methods before user code runs, which keeps unsupported methods out of the handler and makes the route contract visible in the filesystem.",
    recommendedReplacement:
      "Use route files such as server/api/user.get.ts or server/api/user.post.ts instead of checking request.method inside the handler.",
    examples: [
      {
        title: "Move method gates into the route filename",
        language: "ts",
        invalid:
          "export default defineEventHandler((event) => {\n  if (getMethod(event) !== 'POST') throw createError({ statusCode: 405 })\n  return createUser(event)\n})",
        valid:
          "// server/api/user.post.ts\nexport default defineEventHandler((event) => {\n  return createUser(event)\n})",
      },
    ],
    category: "request",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/routing#specific-request-method",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!isNitroRouteFile(ctx)) return;

    return {
      IfStatement(node: AnyNode) {
        if (!branchExits(node.consequent) && !branchExits(node.alternate)) return;
        const checks = methodChecks(node.test, ctx.file.text, node);
        if (!checks.length) return;
        reportMethodCheck(node.test ?? node, checks, wholeHandlerAllowed(node, checks));
      },
      BinaryExpression(node: AnyNode) {
        if (isInIfStatementTest(node) || !selectsResponse(node)) return;
        const check = singleMethodCheck(node, ctx.file.text, node);
        if (!check) return;
        reportMethodCheck(node, [check], false);
      },
    };

    function reportMethodCheck(node: AnyNode, checks: MethodCheck[], wholeHandler: boolean) {
      const methods = methodsFromChecks(checks);
      const suffix = routeMethodSuffix(ctx.file.relativePath);
      const suggestion =
        suffix && isRedundantSuffix(suffix, methods)
          ? `Remove the manual method guard; .${suffix.toLowerCase()}.ts already constrains this route.`
          : methodSuffixSuggestion(ctx.file.relativePath, methods, wholeHandler);
      report(
        ctx,
        node,
        RULE_ID,
        "warn",
        "request",
        `This file-routed Nitro handler checks ${formatMethods(methods)} manually.`,
        suggestion,
      );
    }
  },
});

function formatMethods(methods: string[]) {
  return methods.length === 1 ? methods[0]! : methods.join("/");
}

function isRedundantSuffix(suffix: string | null, methods: string[]) {
  return methods.length === 1 && methods[0] === suffix;
}

function methodSuffixSuggestion(relativePath: string, methods: string[], wholeHandler: boolean) {
  const paths = methods.map((method) =>
    routePathWithMethodSuffix(relativePath, method.toLowerCase()),
  );
  if (wholeHandler && paths.length === 1)
    return `Move this handler to ${paths[0]} and remove the manual method guard.`;
  if (wholeHandler)
    return `Split this handler into ${formatList(paths)} and remove the manual method guard.`;
  if (paths.length === 1)
    return `Move the ${methods[0]}-specific branch to ${paths[0]} and keep other method behavior in method-suffixed route files.`;
  return `Move the method-specific branches to ${formatList(paths)} and keep other method behavior in method-suffixed route files.`;
}

function formatList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function methodsFromChecks(checks: MethodCheck[]) {
  return [...new Set(checks.map((check) => check.method))];
}

function wholeHandlerAllowed(node: AnyNode, checks: MethodCheck[]) {
  return checks.every((check) => check.isNegative) && branchExits(node.consequent);
}

function selectsResponse(node: AnyNode, seen = new Set<AnyNode>()): boolean {
  let condition = node;
  while (condition.__doctorParent && isConditionWrapper(condition.__doctorParent))
    condition = condition.__doctorParent;
  const parent = condition.__doctorParent;
  if (parent?.type === "ConditionalExpression" && parent.test === condition)
    return isReturnedValue(parent, seen);
  if (parent?.type === "IfStatement" && parent.test === condition)
    return branchExits(parent.consequent) || branchExits(parent.alternate);
  if (parent?.type === "VariableDeclarator" && parent.init === condition)
    return someReference(parent, seen, (reference) => selectsResponse(reference, seen));
  return false;
}

function isConditionWrapper(node: AnyNode) {
  return (
    node.type === "LogicalExpression" ||
    node.type === "ParenthesizedExpression" ||
    (node.type === "UnaryExpression" && node.operator === "!") ||
    isTypeExpressionWrapper(node)
  );
}

function isTypeExpressionWrapper(node: AnyNode) {
  return (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSTypeAssertion"
  );
}

function isReturnedValue(node: AnyNode, seen: Set<AnyNode>): boolean {
  const parent = node.__doctorParent;
  if (!parent) return false;
  if (
    parent.type === "ParenthesizedExpression" ||
    parent.type === "AwaitExpression" ||
    parent.type === "ChainExpression" ||
    isTypeExpressionWrapper(parent)
  )
    return isReturnedValue(parent, seen);
  if (parent.type === "ConditionalExpression" && parent.test !== node)
    return isReturnedValue(parent, seen);
  if (parent.type === "CallExpression" && parent.callee === node)
    return isReturnedValue(parent, seen);
  if (isInvokedMember(parent, node)) return isReturnedValue(parent.__doctorParent, seen);
  if (parent.type === "ReturnStatement") return true;
  if (parent.type === "VariableDeclarator" && parent.init === node)
    return someReference(parent, seen, (reference) => isReturnedValue(reference, seen));
  return parent.type === "ArrowFunctionExpression" && parent.body === node;
}

function isInvokedMember(member: AnyNode, object: AnyNode) {
  return (
    (member.type === "MemberExpression" || member.type === "StaticMemberExpression") &&
    member.object === object &&
    member.__doctorParent?.type === "CallExpression" &&
    member.__doctorParent.callee === member
  );
}

function someReference(
  declarator: AnyNode,
  seen: Set<AnyNode>,
  predicate: (reference: AnyNode) => boolean,
): boolean {
  const declaration = declarator.__doctorParent;
  if (declarator.id?.type !== "Identifier" || declaration?.kind !== "const") return false;
  if (seen.has(declarator)) return false;
  seen.add(declarator);
  const name = declarator.id.name;
  const scope = nearestFunctionOrProgram(declarator);
  let found = false;
  walkScriptLocal(scope, (node) => {
    if (
      !found &&
      node.type === "Identifier" &&
      node.name === name &&
      (node.start < declarator.start || node.start >= declarator.end) &&
      isValueReference(node) &&
      nearestFunctionOrProgram(node) === scope &&
      resolvesTo(node, declaration) &&
      predicate(node)
    )
      found = true;
  });
  return found;
}

function isValueReference(node: AnyNode) {
  const parent = node.__doctorParent;
  if (
    (parent?.type === "MemberExpression" || parent?.type === "StaticMemberExpression") &&
    parent.property === node &&
    !parent.computed
  )
    return false;
  return !(parent?.type === "Property" && parent.key === node && !parent.shorthand);
}

function resolvesTo(reference: AnyNode, declaration: AnyNode) {
  const home = declaration.__doctorParent;
  for (let scope = reference.__doctorParent; scope; scope = scope.__doctorParent) {
    if (scope === home) return true;
    if (scopeDeclares(scope, reference.name)) return false;
  }
  return false;
}

function scopeDeclares(scope: AnyNode, name: string): boolean {
  switch (scope.type) {
    case "BlockStatement":
    case "StaticBlock":
      return scope.body?.some((statement: AnyNode) => statementDeclares(statement, name));
    case "SwitchStatement":
      return scope.cases?.some((item: AnyNode) =>
        item.consequent?.some((statement: AnyNode) => statementDeclares(statement, name)),
      );
    case "ForStatement":
      return statementDeclares(scope.init, name);
    case "ForInStatement":
    case "ForOfStatement":
      return statementDeclares(scope.left, name);
    case "CatchClause":
      return patternDeclares(scope.param, name);
    default:
      return false;
  }
}

function statementDeclares(statement: AnyNode, name: string): boolean {
  if (statement?.type === "VariableDeclaration")
    return statement.declarations?.some((item: AnyNode) => patternDeclares(item.id, name));
  return (
    (statement?.type === "FunctionDeclaration" || statement?.type === "ClassDeclaration") &&
    statement.id?.name === name
  );
}

function patternDeclares(pattern: AnyNode, name: string): boolean {
  if (!pattern) return false;
  switch (pattern.type) {
    case "Identifier":
      return pattern.name === name;
    case "AssignmentPattern":
      return patternDeclares(pattern.left, name);
    case "RestElement":
      return patternDeclares(pattern.argument, name);
    case "ArrayPattern":
      return pattern.elements?.some((item: AnyNode) => patternDeclares(item, name));
    case "ObjectPattern":
      return pattern.properties?.some((item: AnyNode) =>
        patternDeclares(item.type === "RestElement" ? item : item.value, name),
      );
    default:
      return false;
  }
}

function branchExits(node: AnyNode): boolean {
  if (!node) return false;
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return true;
  if (node.type === "IfStatement")
    return branchExits(node.consequent) && branchExits(node.alternate);
  if (node.type === "TryStatement") {
    if (node.finalizer && branchExits(node.finalizer)) return true;
    return branchExits(node.block) && (!node.handler || branchExits(node.handler.body));
  }
  if (node.type !== "BlockStatement") return false;
  return branchExits(node.body?.at(-1));
}
