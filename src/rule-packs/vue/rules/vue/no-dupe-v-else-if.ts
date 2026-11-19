import type {
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import { findTemplateDirective, TemplateNodeType } from "../../../../core/rule-authoring.js";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import { fileScriptScope, type ScriptScope } from "../../../../core/internal/script-scope.js";
import { createRule, type AnyNode } from "./shared.js";
import { vueApiCall } from "./vue-api.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-dupe-v-else-if";

// Truthiness, `typeof`, `void` and strict equality never run user code. The other operators can
// call `valueOf` or `toString` on an object, so they only take operands known to be primitive.
const NON_COERCING_UNARY = new Set(["!", "typeof", "void"]);
const COERCING_UNARY = new Set(["-", "+", "~"]);
const STRICT_BINARY = new Set(["===", "!=="]);
const COERCING_BINARY = new Set([
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
  "ParenthesizedExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const REF_APIS = new Set(["ref", "shallowRef", "computed"]);
// The names compiler-core's `canPrefix` leaves unprefixed: `isGloballyAllowed` in @vue/shared 3.5,
// plus `require`.
const TEMPLATE_GLOBALS = new Set(
  (
    "Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,decodeURIComponent," +
    "encodeURI,encodeURIComponent,Math,Number,Date,Array,Object,Boolean,String,RegExp,Map,Set," +
    "JSON,Intl,BigInt,console,Error,Symbol,require"
  ).split(","),
);

/** `primitive` values never run user code when coerced; `value` reads may hold any value. */
type ReadKind = "primitive" | "value";

interface SetupBindings {
  /** Template names whose read returns the same value twice in one render. */
  reads: Map<string, ReadKind>;
  /** Names bound to `defineProps()`, whose one-level member reads are props proxy reads. */
  propsObjects: Set<string>;
}

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
      "Reports a v-else-if branch whose condition repeats, or is fully covered by, earlier conditions in the same v-if / v-else-if chain. Compares reads Vue returns unchanged within one render: script setup refs, shallowRefs, getter-only computeds, defineModel models, props, and primitive constants, plus operators over them that run no user code.",
    why: "Vue renders the first branch of a chain whose condition is truthy. A later branch whose condition can only be truthy when an earlier one already is never renders, which usually hides a copy-paste mistake in the condition.",
    recommendedReplacement:
      "Change the later condition to the one the branch was meant to test, or remove the branch.",
    examples: [
      {
        title: "Test a different value in each branch",
        language: "vue",
        invalid:
          "<script setup>\nimport { ref } from 'vue'\n\nconst status = ref('idle')\n</script>\n\n<template>\n  <p v-if=\"status === 'loading'\">Loading…</p>\n  <p v-else-if=\"status === 'loading'\">Failed</p>\n</template>",
        valid:
          "<script setup>\nimport { ref } from 'vue'\n\nconst status = ref('idle')\n</script>\n\n<template>\n  <p v-if=\"status === 'loading'\">Loading…</p>\n  <p v-else-if=\"status === 'error'\">Failed</p>\n</template>",
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
    let bindings: SetupBindings | undefined;
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
          bindings ??= setupBindings(ctx);
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

function setupBindings(ctx: RuleContext): SetupBindings {
  const bindings: SetupBindings = { reads: new Map(), propsObjects: new Set() };
  const setup = (ctx.file.sfc?.descriptor as SFCDescriptor | undefined)?.scriptSetup;
  const script = setup && !setup.src ? fileScriptScope(ctx) : null;
  if (!setup || !script) return bindings;
  const declared = new Map<string, number>();
  const candidates = new Map<string, ReadKind>();
  const propsObjects = new Set<string>();
  const propNames = new Set<string>();
  for (const statement of (script.ast as AnyNode).body ?? []) {
    for (const name of declaredNames(statement)) declared.set(name, (declared.get(name) ?? 0) + 1);
    if (statement.start < setup.loc.start.offset || statement.end > setup.loc.end.offset) continue;
    const bareProps =
      statement.type === "ExpressionStatement" && propsMacro(unwrap(statement.expression));
    if (bareProps) for (const name of declaredPropNames(bareProps)) propNames.add(name);
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const" || statement.declare)
      continue;
    for (const declarator of statement.declarations) {
      const init = unwrap(declarator.init);
      const props = propsMacro(init);
      if (props) {
        for (const name of declaredPropNames(props)) propNames.add(name);
        if (declarator.id.type === "Identifier") propsObjects.add(declarator.id.name);
        for (const name of destructuredProps(declarator.id)) candidates.set(name, "value");
        continue;
      }
      if (declarator.id.type !== "Identifier") continue;
      if (isPrimitiveLiteral(init)) candidates.set(declarator.id.name, "primitive");
      else if (isIdempotentRef(script, init)) candidates.set(declarator.id.name, "value");
    }
  }
  // Vue resolves a template name to the setup binding only when nothing else claims it: a second
  // declaration is ambiguous, and an allowed global such as `Math` compiles to the global inside
  // compound expressions. Names starting with `$` or `_` collide with Vue's instance properties.
  const unclaimed = (name: string) => !TEMPLATE_GLOBALS.has(name) && !/^[$_]/.test(name);
  for (const [name, kind] of candidates) {
    if (declared.get(name) === 1 && unclaimed(name)) bindings.reads.set(name, kind);
  }
  for (const name of propNames) {
    if (!declared.has(name) && unclaimed(name)) bindings.reads.set(name, "value");
  }
  for (const name of propsObjects) {
    if (declared.get(name) === 1 && unclaimed(name)) bindings.propsObjects.add(name);
  }
  return bindings;
}

function declaredNames(statement: AnyNode): string[] {
  switch (statement?.type) {
    case "ImportDeclaration":
      return statement.specifiers.map((specifier: AnyNode) => specifier.local.name);
    case "VariableDeclaration":
      return statement.declarations.flatMap((declarator: AnyNode) => patternNames(declarator.id));
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSEnumDeclaration":
      return statement.id ? [statement.id.name] : [];
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return declaredNames(statement.declaration);
    default:
      return [];
  }
}

function patternNames(pattern: AnyNode): string[] {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property: AnyNode) =>
        patternNames(property.type === "RestElement" ? property.argument : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap(patternNames);
    case "RestElement":
      return patternNames(pattern.argument);
    case "AssignmentPattern":
      return patternNames(pattern.left);
    default:
      return [];
  }
}

function propsMacro(node: AnyNode): AnyNode {
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier") return null;
  if (node.callee.name === "defineProps") return node;
  return node.callee.name === "withDefaults" ? propsMacro(unwrap(node.arguments[0])) : null;
}

function declaredPropNames(call: AnyNode): string[] {
  const type = (call.typeArguments ?? call.typeParameters)?.params?.[0];
  if (type) {
    if (type.type !== "TSTypeLiteral") return [];
    return type.members.flatMap((member: AnyNode) =>
      member.type === "TSPropertySignature" && !member.computed ? identifierKey(member.key) : [],
    );
  }
  const runtime = unwrap(call.arguments[0]);
  if (runtime?.type === "ObjectExpression") {
    return runtime.properties.flatMap((property: AnyNode) =>
      property.type === "Property" && !property.computed ? identifierKey(property.key) : [],
    );
  }
  if (runtime?.type === "ArrayExpression") return runtime.elements.flatMap(identifierKey);
  return [];
}

function identifierKey(key: AnyNode): string[] {
  if (key?.type === "Identifier") return [key.name];
  return key?.type === "Literal" &&
    typeof key.value === "string" &&
    /^[A-Za-z_$][\w$]*$/.test(key.value)
    ? [key.value]
    : [];
}

function destructuredProps(pattern: AnyNode): string[] {
  if (pattern.type !== "ObjectPattern") return [];
  return pattern.properties.flatMap((property: AnyNode) => {
    if (property.type !== "Property" || property.computed) return [];
    const value =
      property.value.type === "AssignmentPattern" ? property.value.left : property.value;
    return value.type === "Identifier" ? [value.name] : [];
  });
}

// A ref, shallowRef or getter-only computed returns its stored or cached value on every read, and
// defineModel does too unless a `get` option transforms it. customRef runs user code instead.
function isIdempotentRef(script: ScriptScope, init: AnyNode): boolean {
  if (init?.type !== "CallExpression") return false;
  if (init.callee.type === "Identifier" && init.callee.name === "defineModel") {
    return init.arguments.every((argument: AnyNode) => {
      argument = unwrap(argument);
      if (argument.type === "Literal") return typeof argument.value === "string";
      return (
        argument.type === "ObjectExpression" &&
        argument.properties.every(
          (property: AnyNode) =>
            property.type === "Property" &&
            !property.computed &&
            identifierKey(property.key)[0] !== "get",
        )
      );
    });
  }
  const api = vueApiCall(script, init.callee, REF_APIS);
  if (api === "ref" || api === "shallowRef") return true;
  return api === "computed" && FUNCTION_TYPES.has(unwrap(init.arguments[0])?.type);
}

function stableTest(
  ctx: RuleContext,
  directive: TemplateDirectiveNode,
  bindings: SetupBindings,
): AnyNode {
  const test = directive.exp && ctx.helpers.parseTemplateExpression(directive.exp);
  return test && readKind(test, bindings) ? test : null;
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

function readKind(node: AnyNode, bindings: SetupBindings): ReadKind | null {
  node = unwrap(node);
  switch (node?.type) {
    case "Identifier":
      return bindings.reads.get(node.name) ?? null;
    case "Literal":
      return isPrimitiveLiteral(node) ? "primitive" : null;
    case "MemberExpression":
      return node.object.type === "Identifier" &&
        bindings.propsObjects.has(node.object.name) &&
        propertyKey(node) !== undefined
        ? "value"
        : null;
    case "UnaryExpression": {
      const argument = readKind(node.argument, bindings);
      if (!argument) return null;
      if (NON_COERCING_UNARY.has(node.operator)) return "primitive";
      return COERCING_UNARY.has(node.operator) && argument === "primitive" ? "primitive" : null;
    }
    case "BinaryExpression": {
      const left = readKind(node.left, bindings);
      const right = left && readKind(node.right, bindings);
      if (!left || !right) return null;
      if (STRICT_BINARY.has(node.operator)) return "primitive";
      return COERCING_BINARY.has(node.operator) && left === "primitive" && right === "primitive"
        ? "primitive"
        : null;
    }
    case "LogicalExpression":
      return either(readKind(node.left, bindings), readKind(node.right, bindings));
    case "ConditionalExpression":
      return readKind(node.test, bindings)
        ? either(readKind(node.consequent, bindings), readKind(node.alternate, bindings))
        : null;
    case "TemplateLiteral":
      return node.expressions.every(
        (expression: AnyNode) => readKind(expression, bindings) === "primitive",
      )
        ? "primitive"
        : null;
    default:
      return null;
  }
}

function either(left: ReadKind | null, right: ReadKind | null): ReadKind | null {
  if (!left || !right) return null;
  return left === "primitive" && right === "primitive" ? "primitive" : "value";
}

function propertyKey(node: AnyNode): string | undefined {
  if (!node.computed) return node.property.name;
  const key = unwrap(node.property);
  return key?.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

function isEqual(left: AnyNode, right: AnyNode, truthinessOnly = false): boolean {
  const a = unwrap(left);
  const b = unwrap(right);
  if (!a || !b || a.type !== b.type) return false;
  switch (a.type) {
    case "Identifier":
      return a.name === b.name;
    case "MemberExpression":
      return (
        Boolean(a.optional) === Boolean(b.optional) &&
        isEqual(a.object, b.object) &&
        propertyKey(a) === propertyKey(b)
      );
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
