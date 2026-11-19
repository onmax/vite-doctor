import type {
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import { findTemplateDirective, TemplateNodeType } from "../../../../core/rule-authoring.js";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-dupe-v-else-if";

const PRIMITIVE_UNARY = new Set(["!", "-", "+", "~", "typeof", "void"]);
const PRIMITIVE_BINARY = new Set([
  "===",
  "!==",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
]);
const TRANSPARENT = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

interface Branch {
  directive: TemplateDirectiveNode;
  test: AnyNode;
}

interface OrOperand {
  andOperands: AnyNode[];
}

interface Condition {
  node: AnyNode;
  remaining: OrOperand[];
  coveredBy: Set<Branch>;
}

export const noDupeVElseIf = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not repeat a condition in a v-if / v-else-if chain",
    description:
      "Reports a v-else-if branch whose condition repeats, or is fully covered by, earlier conditions in the same v-if / v-else-if chain. Compares primitive literals, top-level script setup constants initialized with primitive literals, and supported expressions over them.",
    why: "Vue renders the first branch of a chain whose condition is truthy. A later branch whose condition can only be truthy when an earlier one already is never renders, which usually hides a copy-paste mistake in the condition.",
    recommendedReplacement:
      "Change the later condition to the one the branch was meant to test, or remove the branch.",
    examples: [
      {
        title: "Test a different value in each branch",
        language: "vue",
        invalid:
          "<script setup>\nconst status = 'loading'\n</script>\n\n<template>\n  <p v-if=\"status === 'loading'\">Loading…</p>\n  <p v-else-if=\"status === 'loading'\">Failed</p>\n</template>",
        valid:
          "<script setup>\nconst status = 'loading'\n</script>\n\n<template>\n  <p v-if=\"status === 'loading'\">Loading…</p>\n  <p v-else-if=\"status === 'error'\">Failed</p>\n</template>",
      },
    ],
    category: "template",
    severity: "warn",
    confidence: "proven",
    fixable: false,
    docsUrl: "https://vuejs.org/guide/essentials/conditional.html#v-else-if",
    requires: { template: true, vue: true },
  },
  create(ctx) {
    const scoped = new WeakSet<TemplateElementNode>();
    let bindings: ReadonlySet<string> | undefined;
    return {
      template: {
        element(node, parent) {
          if (!parent) return;
          if (
            hasTemplateScope(node) ||
            (parent.type === TemplateNodeType.ELEMENT && scoped.has(parent))
          ) {
            scoped.add(node);
            return;
          }
          const elseIf = findTemplateDirective(node, "else-if");
          if (!elseIf) return;
          bindings ??= primitiveSetupBindings(ctx);
          const test = stableTest(ctx, elseIf, bindings);
          if (!test) return;

          const conditions: Condition[] = (
            isLogical(test, "&&") ? [...split(test, "&&"), test] : [test]
          ).map((condition) => ({
            node: condition,
            remaining: split(condition, "||").map((operand) => ({
              andOperands: split(operand, "&&"),
            })),
            coveredBy: new Set(),
          }));

          const siblings = parent.children;
          for (let index = siblings.indexOf(node) - 1; index >= 0; index--) {
            const sibling = siblings[index]!;
            if (sibling.type === TemplateNodeType.COMMENT) continue;
            if (sibling.type === TemplateNodeType.TEXT && !sibling.content.trim()) continue;
            if (sibling.type !== TemplateNodeType.ELEMENT || hasTemplateScope(sibling)) return;
            const vIf = findTemplateDirective(sibling, "if");
            const directive = vIf ?? findTemplateDirective(sibling, "else-if");
            if (!directive) return;

            const earlier = stableTest(ctx, directive, bindings);
            if (!earlier) return;
            const branch: Branch = { directive, test: earlier };
            const earlierOperands = split(earlier, "||").map((operand) => split(operand, "&&"));
            for (const condition of conditions) {
              condition.remaining = condition.remaining.filter((operand) => {
                const covered = earlierOperands.some((earlierAnd) =>
                  earlierAnd.every((part) =>
                    operand.andOperands.some((candidate) => isEqual(part, candidate, true)),
                  ),
                );
                if (covered) condition.coveredBy.add(branch);
                return !covered;
              });
              if (condition.remaining.length === 0) {
                report(ctx, node, elseIf, test, condition);
                return;
              }
            }
            if (vIf) return;
          }
        },
      },
    };
  },
});

function report(
  ctx: RuleContext,
  element: TemplateElementNode,
  elseIf: TemplateDirectiveNode,
  test: AnyNode,
  condition: Condition,
) {
  const { content, loc } = elseIf.exp!;
  const source = content.trim();
  const branches = [...condition.coveredBy].sort(
    (a, b) => a.directive.loc.start.offset - b.directive.loc.start.offset,
  );
  const described = branches.map(describeBranch);
  const earlier =
    described.length === 1
      ? `the earlier ${described[0]}`
      : `one of the earlier ${described.slice(0, -1).join(", ")} or ${described.at(-1)}`;
  const repeats = branches.length === 1 && isEqual(branches[0]!.test, test, true);
  const contentStart = loc.start.offset + Math.max(loc.source.indexOf(content), 0);
  const operand = content.slice(
    condition.node.start - contentStart,
    condition.node.end - contentStart,
  );
  const reason = repeats
    ? `It repeats the condition of the earlier ${described[0]} in the same chain, so Vue only reaches this branch after that condition was falsy.`
    : condition.node === test
      ? `Whenever it is truthy, ${earlier} in the same chain is truthy too, so Vue renders that branch instead.`
      : `It requires "${operand}", which is only truthy when ${earlier} in the same chain is truthy too, so Vue renders that branch instead.`;

  ctx.report(
    diagnostics.VUE0043({
      why: `<${element.tag} v-else-if="${source}"> never renders. ${reason}`,
      fix: `Change v-else-if="${source}" to the condition this <${element.tag}> was meant to test, or remove the branch if it is no longer needed.`,
    }),
    {
      ruleId: RULE_ID,
      severity: "warn",
      category: "template",
      file: ctx.file.path,
      range: ctx.range(elseIf.exp!.loc.start.offset, elseIf.exp!.loc.end.offset),
    },
  );
}

function describeBranch(branch: Branch): string {
  const name = branch.directive.name === "if" ? "v-if" : "v-else-if";
  return `${name}="${branch.directive.exp!.content.trim()}" on line ${branch.directive.loc.start.line}`;
}

function hasTemplateScope(node: TemplateElementNode): boolean {
  return Boolean(findTemplateDirective(node, "for") || findTemplateDirective(node, "slot"));
}

function primitiveSetupBindings(ctx: RuleContext): ReadonlySet<string> {
  const bindings = new Set<string>();
  const sfc = ctx.file.sfc;
  const setup = (sfc?.descriptor as SFCDescriptor | undefined)?.scriptSetup;
  if (!setup || setup.src) return bindings;
  const script = sfc?.getScriptAst("merged") as AnyNode;
  for (const statement of script?.body ?? []) {
    if (
      statement.start < setup.loc.start.offset ||
      statement.end > setup.loc.end.offset ||
      statement.type !== "VariableDeclaration" ||
      statement.kind !== "const" ||
      statement.declare
    )
      continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === "Identifier" && isPrimitiveLiteral(unwrap(declaration.init))) {
        bindings.add(declaration.id.name);
      }
    }
  }
  return bindings;
}

function stableTest(
  ctx: RuleContext,
  directive: TemplateDirectiveNode,
  bindings: ReadonlySet<string>,
): AnyNode {
  const test = directive.exp && ctx.helpers.parseTemplateExpression(directive.exp);
  return test && isStable(test, bindings) ? test : null;
}

function unwrap(node: AnyNode): AnyNode {
  while (node && TRANSPARENT.has(node.type)) node = node.expression;
  return node;
}

function isLogical(node: AnyNode, operator: "&&" | "||"): boolean {
  const inner = unwrap(node);
  return inner?.type === "LogicalExpression" && inner.operator === operator;
}

function split(node: AnyNode, operator: "&&" | "||"): AnyNode[] {
  const inner = unwrap(node);
  return isLogical(inner, operator)
    ? [...split(inner.left, operator), ...split(inner.right, operator)]
    : [node];
}

function isPrimitiveLiteral(node: AnyNode): boolean {
  return (
    node?.type === "Literal" &&
    !node.regex &&
    (node.bigint !== undefined ||
      node.value === null ||
      typeof node.value === "string" ||
      typeof node.value === "number" ||
      typeof node.value === "boolean")
  );
}

function isStable(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  node = unwrap(node);
  switch (node?.type) {
    case "Identifier":
      return bindings.has(node.name);
    case "Literal":
      return isPrimitiveLiteral(node);
    case "UnaryExpression":
      return PRIMITIVE_UNARY.has(node.operator) && isStable(node.argument, bindings);
    case "BinaryExpression":
      return (
        PRIMITIVE_BINARY.has(node.operator) &&
        isStable(node.left, bindings) &&
        isStable(node.right, bindings)
      );
    case "LogicalExpression":
      return isStable(node.left, bindings) && isStable(node.right, bindings);
    case "ConditionalExpression":
      return (
        isStable(node.test, bindings) &&
        isStable(node.consequent, bindings) &&
        isStable(node.alternate, bindings)
      );
    case "TemplateLiteral":
      return node.expressions.every((expression: AnyNode) => isStable(expression, bindings));
    default:
      return false;
  }
}

function isEqual(left: AnyNode, right: AnyNode, truthinessOnly = false): boolean {
  const a = unwrap(left);
  const b = unwrap(right);
  if (!a || !b || a.type !== b.type) return false;
  switch (a.type) {
    case "Identifier":
      return a.name === b.name;
    case "Literal":
      if (a.bigint !== undefined || b.bigint !== undefined) return a.bigint === b.bigint;
      return Object.is(a.value, b.value);
    case "UnaryExpression":
      return a.operator === b.operator && isEqual(a.argument, b.argument, a.operator === "!");
    case "BinaryExpression":
      return a.operator === b.operator && isEqual(a.left, b.left) && isEqual(a.right, b.right);
    case "LogicalExpression": {
      const canSwap = truthinessOnly && (a.operator === "&&" || a.operator === "||");
      return (
        a.operator === b.operator &&
        ((isEqual(a.left, b.left, canSwap) && isEqual(a.right, b.right, truthinessOnly)) ||
          (canSwap && isEqual(a.left, b.right, true) && isEqual(a.right, b.left, true)))
      );
    }
    case "ConditionalExpression":
      return (
        isEqual(a.test, b.test, true) &&
        isEqual(a.consequent, b.consequent, truthinessOnly) &&
        isEqual(a.alternate, b.alternate, truthinessOnly)
      );
    case "TemplateLiteral":
      return (
        a.quasis.length === b.quasis.length &&
        a.quasis.every(
          (quasi: AnyNode, index: number) => quasi.value.cooked === b.quasis[index].value.cooked,
        ) &&
        a.expressions.every((expression: AnyNode, index: number) =>
          isEqual(expression, b.expressions[index]),
        )
      );
    default:
      return false;
  }
}
