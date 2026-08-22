import { codeForRuleId, diagnosticForCode, type RuleContext } from "../../../core/index.js";
import { doctorInternalDiagnostics } from "../../../core/internal-diagnostic-handles.js";
import { diagnosticCodesByRuleId, diagnostics } from "../diagnostics.js";

export type AnyNode = any;

export function isTypeScriptSource(ctx: RuleContext): boolean {
  if (/\.(?:[cm]?ts|tsx)$/i.test(ctx.file.relativePath)) return true;
  if (!ctx.file.isVueSfc) return false;
  const descriptor = (ctx.sfc ?? ctx.file.sfc)?.descriptor as
    | { script?: { lang?: string }; scriptSetup?: { lang?: string } }
    | undefined;
  return [descriptor?.script, descriptor?.scriptSetup].some((block) =>
    /^(?:ts|tsx)$/i.test(block?.lang ?? ""),
  );
}

export function report(ctx: RuleContext, node: AnyNode, ruleId: string, why: string, fix: string) {
  const code = codeForRuleId(diagnosticCodesByRuleId, ruleId);
  if (!code) throw doctorInternalDiagnostics.DOC0013({ ruleId });
  const diagnostic = diagnosticForCode(diagnostics, code);
  if (!diagnostic) throw doctorInternalDiagnostics.DOC0013({ ruleId, code });
  ctx.helpers.report(ctx, node, diagnostic({ why, fix }), {
    ruleId,
    severity: ctx.severity,
    category: ruleId.split("/")[1] ?? "types",
  });
}

export function parentOf(node: AnyNode): AnyNode {
  return node?.__doctorParent ?? node?.parent;
}

export function isTypeAssertion(node: AnyNode): boolean {
  return node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion";
}

export function isConstAssertion(node: AnyNode): boolean {
  const annotation = node?.typeAnnotation;
  return (
    annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier" &&
    annotation.typeName.name === "const"
  );
}

export function isOutermostTypeAssertion(node: AnyNode): boolean {
  let current = node;
  let parent = parentOf(node);
  while (parent?.type === "ParenthesizedExpression" && parent.expression === current) {
    current = parent;
    parent = parentOf(parent);
  }
  return !isTypeAssertion(parent) || parent.expression !== current;
}

export function unwrapExpression(node: AnyNode): AnyNode {
  let current = node;
  while (
    current &&
    [
      "AwaitExpression",
      "ChainExpression",
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
    ].includes(current.type)
  ) {
    current = current.argument ?? current.expression;
  }
  return current;
}

export function unwrapParentheses(node: AnyNode): AnyNode {
  let current = node;
  while (current?.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

export function collectTypeIdentifiers(node: AnyNode, names = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return names;
  if (Array.isArray(node)) {
    for (const child of node) collectTypeIdentifiers(child, names);
    return names;
  }
  if (node.type === "TSTypeReference" && node.typeName?.type === "Identifier") {
    names.add(node.typeName.name);
  }
  if (node.type === "Identifier" && parentOf(node)?.type === "TSTypeQuery") {
    names.add(node.name);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent" || key === "parent") continue;
    collectTypeIdentifiers(value, names);
  }
  return names;
}

export function parameterType(parameter: AnyNode): AnyNode {
  if (!parameter) return null;
  if (parameter.type === "TSParameterProperty") return parameterType(parameter.parameter);
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation?.typeAnnotation ?? parameterType(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation?.typeAnnotation ?? parameterType(parameter.left);
  }
  return parameter.typeAnnotation?.typeAnnotation ?? null;
}

export function typeResolvesToKeyword(
  node: AnyNode,
  keyword: string,
  aliases: ReadonlyMap<string, AnyNode>,
  seen = new Set<string>(),
): boolean {
  if (!node) return false;
  if (node.type === keyword) return true;
  if (node.type === "TSParenthesizedType") {
    return typeResolvesToKeyword(node.typeAnnotation, keyword, aliases, seen);
  }
  if (node.type === "TSUnionType") {
    return (node.types ?? []).some((item: AnyNode) =>
      typeResolvesToKeyword(item, keyword, aliases, seen),
    );
  }
  if (
    node.type !== "TSTypeReference" ||
    node.typeName?.type !== "Identifier" ||
    node.typeArguments?.params?.length
  ) {
    return false;
  }
  const name = node.typeName.name;
  if (seen.has(name)) return false;
  const alias = aliases.get(name);
  if (!alias) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  return typeResolvesToKeyword(alias, keyword, aliases, nextSeen);
}
