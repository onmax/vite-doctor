import type { DoctorRule, RuleContext } from "../../../../core/index.js";
import { createEslintVueRule, createRule, type AnyNode } from "./shared.js";

const RULE_ID = "vue/props/no-unused-props";

const PROPS_HELPERS_ESLINT_FOLLOWS = new Set(["toRefs", "toRef"]);

export const noUnusedProps = withCompleteReferences(
  createEslintVueRule({
    doctorId: RULE_ID,
    eslintId: "vue/no-unused-properties",
    eslintOptions: () => ({ groups: ["props"] }),
    templateReferences: true,
    meta: {
      id: RULE_ID,
      title: "Remove props the component never reads",
      category: "props",
      severity: "warn",
      fixable: false,
      docsUrl: "https://eslint.vuejs.org/rules/no-unused-properties.html",
      requires: { sfc: true, vue: true },
    },
  }),
);

/**
 * eslint-plugin-vue only sees reads it can follow. It treats the props object passed to an
 * unknown function, such as useVModel(props) or reactiveOmit(props, 'class'), as reading
 * nothing, and it cannot read src or Pug templates. Those files are skipped.
 */
function withCompleteReferences(rule: DoctorRule): DoctorRule {
  return createRule({
    meta: rule.meta,
    create(ctx) {
      const template = (
        ctx.file.sfc?.descriptor as { template?: { src?: string; lang?: string; content?: string } }
      )?.template;
      if (template && (template.src || (template.lang && template.lang !== "html"))) return;
      const propsNames = propsObjectNames(ctx);
      if (propsNames === null) return;
      if (templateUsesWholeProps(template?.content ?? "", propsNames)) return;
      return rule.create(ctx);
    },
  });
}

/** Names bound to the whole props object, or `null` when one escapes to code eslint cannot follow. */
function propsObjectNames(ctx: RuleContext): Set<string> | null {
  const program = ctx.file.sfc?.getScriptAst("merged");
  if (!program) return new Set();
  const names = new Set<string>();
  const declarations = new Set<AnyNode>();
  walk(program, null, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      isPropsMacro(node.init)
    ) {
      names.add(node.id.name);
      declarations.add(node.id);
    }
    const setup = setupFunction(node);
    const param = setup?.params?.[0];
    if (param?.type === "Identifier") {
      names.add(param.name);
      declarations.add(param);
    }
  });
  if (names.size === 0) return names;
  const followedHelpers = vueImportsOf(program, PROPS_HELPERS_ESLINT_FOLLOWS);

  let escapes = false;
  walk(program, null, (node, parent) => {
    if (escapes || node.type !== "Identifier" || !names.has(node.name) || declarations.has(node))
      return;
    if (!parent) return;
    if (parent.type === "MemberExpression" && parent.object === node) return;
    if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
      return;
    if (
      parent.type === "VariableDeclarator" &&
      parent.init === node &&
      parent.id?.type === "ObjectPattern"
    )
      return;
    if (
      parent.type === "CallExpression" &&
      parent.arguments?.[0] === node &&
      parent.callee?.type === "Identifier" &&
      followedHelpers.has(parent.callee.name)
    )
      return;
    if (parent.type.startsWith("TS")) return;
    escapes = true;
  });
  return escapes ? null : names;
}

// eslint follows toRefs(props) only when the helper is imported from vue, not auto-imported.
function vueImportsOf(program: AnyNode, imported: Set<string>): Set<string> {
  const locals = new Set<string>();
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.source?.value !== "vue") continue;
    for (const specifier of statement.specifiers ?? []) {
      const name = specifier.imported?.name ?? specifier.imported?.value;
      if (specifier.type === "ImportSpecifier" && imported.has(name))
        locals.add(specifier.local.name);
    }
  }
  return locals;
}

function isPropsMacro(node: AnyNode): boolean {
  if (node?.type !== "CallExpression" || node.callee?.type !== "Identifier") return false;
  if (node.callee.name === "defineProps") return true;
  return node.callee.name === "withDefaults" && isPropsMacro(node.arguments?.[0]);
}

function setupFunction(node: AnyNode): AnyNode {
  if (node.type !== "Property" || node.computed) return null;
  if ((node.key?.name ?? node.key?.value) !== "setup") return null;
  const value = node.value;
  return value?.type === "FunctionExpression" || value?.type === "ArrowFunctionExpression"
    ? value
    : null;
}

// A whole-props value in the template, such as fn(props), is a read eslint does not count.
function templateUsesWholeProps(template: string, names: Set<string>): boolean {
  for (const name of ["$props", ...names]) {
    const escaped = name.replace(/\$/g, "\\$");
    const pattern = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(?!\\s*(?:\\?\\.|\\.|\\[))`);
    if (pattern.test(template)) return true;
  }
  return false;
}

function walk(
  node: AnyNode,
  parent: AnyNode,
  visit: (node: AnyNode, parent: AnyNode) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, parent, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("_") || key === "parent") continue;
    if (value && typeof value === "object") walk(value, node, visit);
  }
}
