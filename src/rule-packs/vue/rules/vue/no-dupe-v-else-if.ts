import type {
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import { findTemplateDirective, TemplateNodeType } from "../../../../core/rule-authoring.js";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-dupe-v-else-if";

const STABLE_UNARY = new Set(["!", "-", "+", "typeof"]);
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
      "Reports a v-else-if branch whose condition repeats, or is fully covered by, earlier conditions in the same v-if / v-else-if chain. Only conditions whose value cannot change between the two evaluations are compared: identifiers, literals, member chains and operators over them.",
    why: "Vue renders the first branch of a chain whose condition is truthy. A later branch whose condition can only be truthy when an earlier one already is never renders, which usually hides a copy-paste mistake in the condition.",
    recommendedReplacement:
      "Change the later condition to the one the branch was meant to test, or remove the branch.",
    examples: [
      {
        title: "Test a different value in each branch",
        language: "vue",
        invalid:
          "<template>\n  <p v-if=\"status === 'loading'\">Loading…</p>\n  <p v-else-if=\"status === 'loading'\">Failed</p>\n</template>",
        valid:
          "<template>\n  <p v-if=\"status === 'loading'\">Loading…</p>\n  <p v-else-if=\"status === 'error'\">Failed</p>\n</template>",
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
    return {
      template: {
        element(node, parent) {
          if (!parent) return;
          const elseIf = findTemplateDirective(node, "else-if");
          const test = elseIf && stableTest(ctx, elseIf);
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
            if (sibling.type !== TemplateNodeType.ELEMENT) return;
            const vIf = findTemplateDirective(sibling, "if");
            const directive = vIf ?? findTemplateDirective(sibling, "else-if");
            if (!directive) return;

            const earlier = directive.exp && ctx.helpers.parseTemplateExpression(directive.exp);
            // A write between the two evaluations can change what the later condition reads.
            if (earlier && writes(earlier)) return;
            if (earlier && isStable(earlier)) {
              const branch: Branch = { directive, test: earlier };
              const earlierOperands = split(earlier, "||").map((operand) => split(operand, "&&"));
              for (const condition of conditions) {
                condition.remaining = condition.remaining.filter((operand) => {
                  const covered = earlierOperands.some((earlierAnd) =>
                    earlierAnd.every((part) =>
                      operand.andOperands.some((candidate) => isEqual(part, candidate)),
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
  const source = elseIf.exp!.content.trim();
  const branches = [...condition.coveredBy].sort(
    (a, b) => a.directive.loc.start.offset - b.directive.loc.start.offset,
  );
  const described = branches.map(describeBranch);
  const earlier =
    described.length === 1
      ? `the earlier ${described[0]}`
      : `one of the earlier ${described.slice(0, -1).join(", ")} or ${described.at(-1)}`;
  const repeats = branches.length === 1 && isEqual(branches[0]!.test, test);
  const operand = ctx.file.text.slice(condition.node.start, condition.node.end);
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

function stableTest(ctx: RuleContext, directive: TemplateDirectiveNode): AnyNode {
  const test = directive.exp && ctx.helpers.parseTemplateExpression(directive.exp);
  return test && isStable(test) ? test : null;
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

/** True when the expression reads the same value each time it is evaluated within one render. */
function isStable(node: AnyNode): boolean {
  node = unwrap(node);
  switch (node?.type) {
    case "Identifier":
    case "Literal":
    case "ThisExpression":
      return true;
    case "MemberExpression":
      return isStable(node.object) && (!node.computed || isStable(node.property));
    case "UnaryExpression":
      return STABLE_UNARY.has(node.operator) && isStable(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isStable(node.left) && isStable(node.right);
    case "ConditionalExpression":
      return isStable(node.test) && isStable(node.consequent) && isStable(node.alternate);
    case "TemplateLiteral":
      return node.expressions.every(isStable);
    default:
      return false;
  }
}

function writes(node: AnyNode): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(writes);
  if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key.startsWith("_")) continue;
    if (value && typeof value === "object" && writes(value)) return true;
  }
  return false;
}

/** Structural equality on stable expressions; `&&` and `||` are commutative in a boolean test. */
function isEqual(left: AnyNode, right: AnyNode): boolean {
  const a = unwrap(left);
  const b = unwrap(right);
  if (!a || !b || a.type !== b.type) return false;
  switch (a.type) {
    case "Identifier":
      return a.name === b.name;
    case "ThisExpression":
      return true;
    case "Literal":
      if (a.regex || b.regex)
        return a.regex?.pattern === b.regex?.pattern && a.regex?.flags === b.regex?.flags;
      if (a.bigint !== undefined || b.bigint !== undefined) return a.bigint === b.bigint;
      return Object.is(a.value, b.value);
    case "MemberExpression":
      return (
        a.computed === b.computed &&
        Boolean(a.optional) === Boolean(b.optional) &&
        isEqual(a.object, b.object) &&
        (a.computed ? isEqual(a.property, b.property) : a.property.name === b.property.name)
      );
    case "UnaryExpression":
      return a.operator === b.operator && isEqual(a.argument, b.argument);
    case "BinaryExpression":
      return a.operator === b.operator && isEqual(a.left, b.left) && isEqual(a.right, b.right);
    case "LogicalExpression":
      return (
        a.operator === b.operator &&
        ((isEqual(a.left, b.left) && isEqual(a.right, b.right)) ||
          (a.operator !== "??" && isEqual(a.left, b.right) && isEqual(a.right, b.left)))
      );
    case "ConditionalExpression":
      return (
        isEqual(a.test, b.test) &&
        isEqual(a.consequent, b.consequent) &&
        isEqual(a.alternate, b.alternate)
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
