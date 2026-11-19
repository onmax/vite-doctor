import type {
  RuleContext,
  TemplateDirectiveNode,
  TemplateElementNode,
} from "../../../../core/index.js";
import { findTemplateDirective, TemplateNodeType } from "../../../../core/rule-authoring.js";
import { loadTypeScript, loadVueCompilerSfc } from "../../../../core/internal/lazy-parsers.js";
import { scriptScope } from "../../../../core/internal/script-scope.js";
import type { SFCDescriptor } from "@vue/compiler-sfc";
import { createRule, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/template/no-dupe-v-else-if";

const VUE_UNPREFIXED_IDENTIFIERS = new Set(
  (
    "Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,decodeURIComponent," +
    "encodeURI,encodeURIComponent,Math,Number,Date,Array,Object,Boolean,String,RegExp,Map,Set," +
    "JSON,Intl,BigInt,console,Error,Symbol,require"
  ).split(","),
);

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
  "ParenthesizedExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

/**
 * How far a condition can be trusted to give the same result twice in one render: `PROVEN` when
 * it only reads primitive constants, `HEURISTIC` when it also reads refs, computed values, models
 * or props, which return the same value twice unless something writes to them in between.
 */
const UNKNOWN = 0;
const PROVEN = 1;
const HEURISTIC = 2;
type Stability = typeof UNKNOWN | typeof PROVEN | typeof HEURISTIC;

interface Reads {
  proven: ReadonlySet<string>;
  heuristic(): HeuristicReads;
}

interface HeuristicReads {
  /** Refs, computed values, models and props a template can read by name. */
  names: ReadonlySet<string>;
  /** Bindings holding the `defineProps()` object, such as `props`. */
  propsObjects: ReadonlySet<string>;
  /** Declared prop keys, readable as `props.key`. */
  propKeys: ReadonlySet<string>;
}

const NO_HEURISTIC_READS: HeuristicReads = {
  names: new Set(),
  propsObjects: new Set(),
  propKeys: new Set(),
};

interface Test {
  node: AnyNode;
  stability: Stability;
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

let typeScriptRegistered = false;

export const noDupeVElseIf = createRule({
  meta: {
    id: RULE_ID,
    title: "Do not repeat a condition in a v-if / v-else-if chain",
    description:
      "Reports a v-else-if branch whose condition repeats, or is fully covered by, earlier conditions in the same v-if / v-else-if chain. Conditions over primitive literals and primitive-literal script setup constants are reported as proven. Conditions that also read script setup refs and shallowRefs initialized with a literal, getter-only computed values, models without get or set options, or props are reported as heuristic-high.",
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
    let reads: Reads | undefined;
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
          reads ??= setupReads(ctx);
          const tested = stableTest(ctx, elseIf, reads);
          if (!tested) return;
          const test = tested.node;
          let stability = tested.stability;
          const walked = [test];

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

            const earlierTest = stableTest(ctx, directive, reads);
            if (!earlierTest) return;
            const earlier = earlierTest.node;
            stability = Math.max(stability, earlierTest.stability) as Stability;
            walked.push(earlier);
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
                report(
                  ctx,
                  node,
                  elseIf,
                  test,
                  condition,
                  stability === HEURISTIC ? { reads, tests: walked } : null,
                );
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
  heuristicReads: { reads: Reads; tests: AnyNode[] } | null,
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
  const names = heuristicReads ? readNames(heuristicReads.tests, heuristicReads.reads) : [];
  const neverRenders = heuristicReads
    ? `never renders as long as ${listNames(names)} ${names.length === 1 ? "returns" : "return"} the same value each time one render reads ${names.length === 1 ? "it" : "them"}, which holds for plain refs, computed values and props.`
    : "never renders.";

  ctx.report(
    diagnostics.VUE0043({
      why: `<${element.tag} v-else-if="${source}"> ${neverRenders} ${reason}`,
      fix: `Change v-else-if="${source}" to the condition this <${element.tag}> was meant to test, or remove the branch if it is no longer needed.`,
    }),
    {
      ruleId: RULE_ID,
      severity: "warn",
      category: "template",
      file: ctx.file.path,
      range: ctx.range(elseIf.exp!.loc.start.offset, elseIf.exp!.loc.end.offset),
      ...(heuristicReads ? { confidence: "heuristic-high" as const } : {}),
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

function setupReads(ctx: RuleContext): Reads {
  const sfc = ctx.file.sfc;
  const descriptor = sfc?.descriptor as SFCDescriptor | undefined;
  const setup = descriptor?.scriptSetup;
  if (!setup || setup.src) return { proven: new Set(), heuristic: () => NO_HEURISTIC_READS };
  const script = sfc?.getScriptAst("merged") as AnyNode;
  const statements: AnyNode[] = script?.body ?? [];
  const declared = new Map<string, number>();
  for (const statement of statements) {
    for (const name of declaredNames(statement)) declared.set(name, (declared.get(name) ?? 0) + 1);
  }
  const setupStatements = statements.filter(
    (statement) =>
      statement.start >= setup.loc.start.offset && statement.end <= setup.loc.end.offset,
  );
  const readable = (name: string) =>
    !VUE_UNPREFIXED_IDENTIFIERS.has(name) && !/^[$_]/.test(name) && (declared.get(name) ?? 0) <= 1;

  const proven = new Set<string>();
  for (const declaration of constDeclarators(setupStatements)) {
    if (
      declaration.id.type === "Identifier" &&
      readable(declaration.id.name) &&
      declared.get(declaration.id.name) === 1 &&
      isPrimitiveLiteral(unwrap(declaration.init))
    ) {
      proven.add(declaration.id.name);
    }
  }

  let heuristic: HeuristicReads | undefined;
  return {
    proven,
    heuristic: () =>
      (heuristic ??= heuristicSetupReads(ctx, descriptor!, statements, setupStatements, readable)),
  };
}

/**
 * Refs, computed values, models and props, resolved through the binding types Vue's compiler
 * reports, then narrowed to initializers whose reads return the same value until something writes
 * to them: `customRef`, `toRef`, and a ref wrapping another value can run a getter on every read.
 */
function heuristicSetupReads(
  ctx: RuleContext,
  descriptor: SFCDescriptor,
  statements: AnyNode[],
  setupStatements: AnyNode[],
  readable: (name: string) => boolean,
): HeuristicReads {
  const declarators = constDeclarators(setupStatements);
  const propsCall = setupStatements
    .flatMap((statement) =>
      statement.type === "VariableDeclaration" && !statement.declare
        ? statement.declarations.map((declaration: AnyNode) => declaration.init)
        : statement.type === "ExpressionStatement"
          ? [statement.expression]
          : [],
    )
    .map(definePropsCall)
    .find(Boolean);
  const compiled = compileSetup(ctx, descriptor, propsCall);
  if (!compiled) return NO_HEURISTIC_READS;
  const { bindings, propKeys, primitivePropKeys } = compiled;

  const setup = descriptor.scriptSetup!;
  const setupScope = descriptor.script
    ? scriptScope(ctx, setup.content, /^(jsx|tsx)$/.test(setup.lang ?? "") ? "tsx" : "ts")
    : null;
  const setupVariables = setupScope?.scopeManager.scopes.find(
    (scope) => scope.type === "module",
  )?.set;
  const vueImports = new Map<string, string>();
  for (const statement of statements) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== "vue" ||
      statement.importKind === "type"
    )
      continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
        const local = specifier.local.name;
        if (statement.start < setup.loc.start.offset || statement.end > setup.loc.end.offset) {
          if (!setupVariables || setupVariables.get(local)?.isValueVariable) continue;
        }
        vueImports.set(local, specifier.imported.name ?? specifier.imported.value);
      }
    }
  }

  const names = new Set<string>();
  const propsObjects = new Set<string>();
  for (const declaration of declarators) {
    const init = unwrap(declaration.init);
    const props = definePropsCall(init);
    if (props && declaration.id.type === "ObjectPattern") {
      for (const property of declaration.id.properties) {
        if (property.type !== "Property") continue;
        const key = staticKey(property);
        const local =
          property.value.type === "AssignmentPattern" ? property.value.left : property.value;
        if (key === undefined || local.type !== "Identifier" || !readable(local.name)) continue;
        const binding = bindings[local.name];
        if (
          binding === "props" ||
          binding === "props-aliased" ||
          (binding === "setup-const" && primitivePropKeys.has(key))
        ) {
          names.add(local.name);
        }
      }
    }
    if (declaration.id.type !== "Identifier" || !readable(declaration.id.name)) continue;
    const name = declaration.id.name;
    if (bindings[name] === "setup-ref" && isRepeatableRef(init, vueImports)) names.add(name);
    // Vue reports `defineProps()` as setup-reactive-const and `withDefaults()` as setup-const.
    if ((bindings[name] === "setup-reactive-const" || bindings[name] === "setup-const") && props) {
      propsObjects.add(name);
    }
  }

  for (const key of propKeys) {
    if (bindings[key] === "props" && readable(key)) names.add(key);
  }
  return { names, propsObjects, propKeys };
}

function compileSetup(
  ctx: RuleContext,
  descriptor: SFCDescriptor,
  propsCall: AnyNode,
): {
  bindings: Record<string, string | undefined>;
  propKeys: Set<string>;
  primitivePropKeys: Set<string>;
} | null {
  const sfc = loadVueCompilerSfc();
  if (!typeScriptRegistered) {
    sfc.registerTS(() => loadTypeScript());
    typeScriptRegistered = true;
  }
  const inputs = new Set([descriptor.filename]);
  const options = {
    id: ctx.file.hash,
    isProd: false,
    fs: {
      fileExists(file: string) {
        const exists = ctx.fs.stat(file)?.isFile() ?? false;
        if (exists) inputs.add(file);
        return exists;
      },
      readFile(file: string) {
        inputs.add(file);
        return ctx.fs.readText(file);
      },
      realpath(file: string) {
        const path = ctx.fs.realpath(file) ?? file;
        inputs.add(path);
        return path;
      },
    },
  };
  try {
    const compiled = sfc.compileScript(descriptor, options);
    for (const dep of compiled.deps ?? []) inputs.add(dep);
    if (!compiled.bindings) return null;
    let propKeys = runtimePropKeys(unwrap(propsCall?.arguments[0]));
    const primitivePropKeys = new Set<string>();
    if (propsCall?.typeArguments) {
      const setup = descriptor.scriptSetup!;
      const statements = compiled.scriptSetupAst ?? [];
      for (const statement of statements) {
        const expressions =
          statement.type === "VariableDeclaration"
            ? statement.declarations.map((declaration) => declaration.init)
            : statement.type === "ExpressionStatement"
              ? [statement.expression]
              : [];
        for (const expression of expressions) {
          const call = definePropsCall(expression);
          if (call?.start !== propsCall.start - setup.loc.start.offset) continue;
          const type = call.typeParameters?.params[0];
          if (!type) continue;
          const resolved = sfc.resolveTypeElements(
            {
              filename: descriptor.filename,
              source: setup.content,
              ast: [...(compiled.scriptAst ?? []), ...statements],
              options,
              error(message) {
                throw new Error(message);
              },
              warn() {},
              helper: (key) => `_${key}`,
              getString: (node) => setup.content.slice(node.start ?? 0, node.end ?? 0),
              propsTypeDecl: type,
              propsRuntimeDefaults: undefined,
              propsDestructuredBindings: {},
              emitsTypeDecl: undefined,
              isCE: false,
            },
            type,
          );
          propKeys = new Set(Object.keys(resolved.props));
          for (const [key, prop] of Object.entries(resolved.props)) {
            if (
              prop.type === "TSPropertySignature" &&
              isPrimitivePropType(prop.typeAnnotation?.typeAnnotation)
            ) {
              primitivePropKeys.add(key);
            }
          }
        }
      }
    }
    return {
      bindings: compiled.bindings as Record<string, string | undefined>,
      propKeys,
      primitivePropKeys,
    };
  } catch {
    return null;
  } finally {
    // Type scopes and resolution configs are cached even when compilation throws.
    for (const file of inputs) sfc.invalidateTypeCache(file);
  }
}

function isPrimitivePropType(node: AnyNode): boolean {
  if (node?.type === "TSUnionType") return node.types.every(isPrimitivePropType);
  return /^(TSBoolean|TSString|TSNumber|TSBigInt|TSSymbol|TSNull|TSUndefined)Keyword$/.test(
    node?.type ?? "",
  );
}

function constDeclarators(statements: AnyNode[]): AnyNode[] {
  return statements
    .filter(
      (statement) =>
        statement.type === "VariableDeclaration" &&
        statement.kind === "const" &&
        !statement.declare,
    )
    .flatMap((statement) => statement.declarations);
}

function isRepeatableRef(init: AnyNode, vueImports: ReadonlyMap<string, string>): boolean {
  if (init?.type !== "CallExpression" || init.callee.type !== "Identifier") return false;
  const args: AnyNode[] = init.arguments;
  if (init.callee.name === "defineModel") {
    return args.length <= 2 && args.every(isModelArgument);
  }
  switch (vueImports.get(init.callee.name)) {
    case "ref":
    case "shallowRef": {
      if (args.length === 0) return true;
      const value = unwrap(args[0]);
      return (
        args.length === 1 &&
        (isPrimitiveLiteral(value) ||
          value?.type === "ArrayExpression" ||
          value?.type === "ObjectExpression")
      );
    }
    case "computed": {
      const getter = unwrap(args[0]);
      return (
        args.length === 1 &&
        (getter?.type === "ArrowFunctionExpression" || getter?.type === "FunctionExpression") &&
        !getter.async &&
        !getter.generator
      );
    }
    default:
      return false;
  }
}

function isModelArgument(argument: AnyNode): boolean {
  const node = unwrap(argument);
  if (node?.type === "Literal") return typeof node.value === "string";
  return (
    node?.type === "ObjectExpression" &&
    node.properties.every(
      (property: AnyNode) =>
        property.type === "Property" &&
        !property.computed &&
        !["get", "set"].includes(property.key.name ?? property.key.value),
    )
  );
}

function definePropsCall(node: AnyNode): AnyNode {
  node = unwrap(node);
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier") return undefined;
  if (node.callee.name === "defineProps") return node;
  if (node.callee.name !== "withDefaults") return undefined;
  const inner = unwrap(node.arguments[0]);
  if (
    inner?.type === "CallExpression" &&
    inner.callee.type === "Identifier" &&
    inner.callee.name === "defineProps"
  )
    return inner;
}

function staticKey(property: AnyNode): string | undefined {
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && ["string", "number"].includes(typeof property.key.value)) {
    return String(property.key.value);
  }
}

function runtimePropKeys(node: AnyNode): Set<string> {
  if (node?.type === "ArrayExpression") {
    return new Set(
      node.elements.flatMap((item: AnyNode) =>
        item?.type === "Literal" && typeof item.value === "string" ? [item.value] : [],
      ),
    );
  }
  if (node?.type === "ObjectExpression") {
    return new Set(
      node.properties.flatMap((property: AnyNode) => {
        const key = property.type === "Property" ? staticKey(property) : undefined;
        return key === undefined ? [] : [key];
      }),
    );
  }
  return new Set();
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

function stableTest(ctx: RuleContext, directive: TemplateDirectiveNode, reads: Reads): Test | null {
  const node = directive.exp && ctx.helpers.parseTemplateExpression(directive.exp);
  if (!node) return null;
  const stability = stabilityOf(node, reads);
  return stability === UNKNOWN ? null : { node, stability };
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

function all(...levels: Stability[]): Stability {
  return levels.includes(UNKNOWN) ? UNKNOWN : (Math.max(...levels) as Stability);
}

function stabilityOf(node: AnyNode, reads: Reads, requirePrimitive = false): Stability {
  node = unwrap(node);
  switch (node?.type) {
    case "Identifier":
      if (reads.proven.has(node.name)) return PROVEN;
      return !requirePrimitive && reads.heuristic().names.has(node.name) ? HEURISTIC : UNKNOWN;
    case "MemberExpression":
      return !requirePrimitive && isPropsMember(node, reads) ? HEURISTIC : UNKNOWN;
    case "Literal":
      return isPrimitiveLiteral(node) ? PROVEN : UNKNOWN;
    case "UnaryExpression":
      return PRIMITIVE_UNARY.has(node.operator)
        ? stabilityOf(node.argument, reads, ["-", "+", "~"].includes(node.operator))
        : UNKNOWN;
    case "BinaryExpression": {
      if (!PRIMITIVE_BINARY.has(node.operator)) return UNKNOWN;
      const coerces =
        node.operator !== "===" &&
        node.operator !== "!==" &&
        !(
          ["==", "!="].includes(node.operator) &&
          [node.left, node.right].some((operand) => {
            const value = unwrap(operand);
            return value.type === "Literal" && value.value === null && value.bigint === undefined;
          })
        );
      return all(stabilityOf(node.left, reads, coerces), stabilityOf(node.right, reads, coerces));
    }
    case "LogicalExpression":
      return all(
        stabilityOf(node.left, reads, requirePrimitive),
        stabilityOf(node.right, reads, requirePrimitive),
      );
    case "ConditionalExpression":
      return all(
        stabilityOf(node.test, reads),
        stabilityOf(node.consequent, reads, requirePrimitive),
        stabilityOf(node.alternate, reads, requirePrimitive),
      );
    case "TemplateLiteral":
      return all(
        PROVEN,
        ...node.expressions.map((expression: AnyNode) => stabilityOf(expression, reads, true)),
      );
    default:
      return UNKNOWN;
  }
}

/** `props.key`, one level deep, on the object `defineProps()` returns. */
function isPropsMember(node: AnyNode, reads: Reads): boolean {
  const object = unwrap(node.object);
  if (node.computed || node.property.type !== "Identifier" || object?.type !== "Identifier") {
    return false;
  }
  const { propsObjects, propKeys } = reads.heuristic();
  return propsObjects.has(object.name) && propKeys.has(node.property.name);
}

function readNames(tests: AnyNode[], reads: Reads): string[] {
  const names = new Set<string>();
  const visit = (node: AnyNode) => {
    node = unwrap(node);
    switch (node?.type) {
      case "Identifier":
        if (!reads.proven.has(node.name)) names.add(node.name);
        return;
      case "MemberExpression":
        names.add(`${unwrap(node.object).name}.${node.property.name}`);
        return;
      case "UnaryExpression":
        return visit(node.argument);
      case "BinaryExpression":
      case "LogicalExpression":
        visit(node.left);
        return visit(node.right);
      case "ConditionalExpression":
        visit(node.test);
        visit(node.consequent);
        return visit(node.alternate);
      case "TemplateLiteral":
        return node.expressions.forEach(visit);
    }
  };
  tests.forEach(visit);
  return [...names];
}

function listNames(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length <= 1
    ? (quoted[0] ?? "")
    : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
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
        !a.computed &&
        !b.computed &&
        Boolean(a.optional) === Boolean(b.optional) &&
        a.property.name === b.property.name &&
        isEqual(a.object, b.object)
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
