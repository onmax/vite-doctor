import { projectFor, reportDoctor } from "./shared.mjs";

const CODE = "VUE0007";
const WHY = "Destructuring a setup() props parameter creates non-reactive local values.";
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const TS_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]);
const SETUP_NAMES = namePattern(["setup", "defineComponent"]);

/**
 * Port of `vue/reactivity/no-setup-props-destructure`. Doctor re-parses every script with
 * typescript-eslint to get a scope manager; oxlint hands one over (`sourceCode.scopeManager`),
 * built lazily in JS over the AST Rust already parsed.
 */
export const noSetupPropsDestructure = {
  meta: { type: "problem", docs: { url: "https://vite-doctor.onmax.me/diagnostics/VUE0007" } },
  create(context) {
    if (!SETUP_NAMES.test(context.sourceCode.text)) return {};
    const functions = [];
    const declarations = [];
    const collectFunction = (node) => functions.push(node);
    return {
      FunctionDeclaration: collectFunction,
      FunctionExpression: collectFunction,
      ArrowFunctionExpression: collectFunction,
      VariableDeclarator(node) {
        declarations.push(node);
      },
      "Program:exit"() {
        if (!functions.length) return;
        const framework = projectFor(context)?.framework;
        for (const node of setupPropSnapshots(context, framework, functions, declarations))
          reportDoctor(context, node, CODE, WHY);
      },
    };
  },
};

function setupPropSnapshots(context, framework, functions, declarations) {
  const { scopeManager } = context.sourceCode;
  let references;
  const referenceOf = (identifier) => {
    references ??= new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference]),
      ),
    );
    return references.get(identifier);
  };
  const unwrapParent = (node) => {
    let parent = node.parent;
    while (TS_WRAPPERS.has(parent?.type)) parent = parent.parent;
    return parent;
  };
  const unwrapArgument = (node) => {
    while (TS_WRAPPERS.has(node?.type)) node = node.expression;
    return node;
  };
  const isDefineComponent = (node) => {
    const namespace =
      node?.type === "MemberExpression" &&
      (node.computed ? node.property.value : node.property.name) === "defineComponent";
    const target = namespace ? node.object : node;
    if (target?.type !== "Identifier") return false;
    const variable = referenceOf(target)?.resolved;
    if (!variable) return target.name === (namespace ? "Vue" : "defineComponent");
    return variable.defs.some((definition) => {
      const declaration = definition.parent;
      if (
        definition.type !== "ImportBinding" ||
        declaration?.type !== "ImportDeclaration" ||
        declaration.importKind === "type" ||
        (declaration.source.value !== "vue" &&
          !(framework === "nuxt" && declaration.source.value === "#imports"))
      )
        return false;
      if (namespace) return definition.node.type === "ImportNamespaceSpecifier";
      return (
        definition.node.type === "ImportSpecifier" &&
        definition.node.importKind !== "type" &&
        (definition.node.imported.type === "Identifier"
          ? definition.node.imported.name
          : definition.node.imported.value) === "defineComponent"
      );
    });
  };
  const isComponentObject = (object) => {
    if (object?.type !== "ObjectExpression") return false;
    const container = unwrapParent(object);
    if (container?.type === "ExportDefaultDeclaration") return true;
    if (container?.type === "CallExpression")
      return (
        unwrapArgument(container.arguments[0]) === object && isDefineComponent(container.callee)
      );
    if (
      container?.type !== "VariableDeclarator" ||
      container.id.type !== "Identifier" ||
      container.parent?.kind !== "const"
    )
      return false;
    return Boolean(
      referenceOf(container.id)?.resolved?.references.some(
        (reference) =>
          reference.isRead() && reference.identifier.parent?.type === "ExportDefaultDeclaration",
      ),
    );
  };
  const isComponentSetup = (node) => {
    const parent = unwrapParent(node);
    if (parent?.type === "CallExpression")
      return unwrapArgument(parent.arguments[0]) === node && isDefineComponent(parent.callee);
    if (parent?.type !== "Property" || unwrapArgument(parent.value) !== node) return false;
    const key = parent.computed ? parent.key.value : (parent.key.name ?? parent.key.value);
    return key === "setup" && isComponentObject(parent.parent);
  };
  const ownerOf = (node) => {
    let current = node.parent;
    while (current && !FUNCTIONS.has(current.type)) current = current.parent;
    return current;
  };
  const result = [];
  for (const fn of functions) {
    if (!isComponentSetup(fn)) continue;
    const first = fn.params[0];
    const parameter = first?.type === "AssignmentPattern" ? first.left : first;
    if (!parameter) continue;
    if (parameter.type === "ObjectPattern" || parameter.type === "ArrayPattern") {
      result.push(parameter);
      continue;
    }
    if (parameter.type !== "Identifier") continue;
    const variable = scopeManager
      .acquire(fn, true)
      ?.variables.find((entry) => entry.identifiers.includes(parameter));
    if (!variable) continue;
    for (const declaration of declarations) {
      if (
        ownerOf(declaration) === fn &&
        (declaration.id.type === "ObjectPattern" || declaration.id.type === "ArrayPattern") &&
        declaration.init?.type === "Identifier" &&
        referenceOf(declaration.init)?.resolved === variable
      )
        result.push(declaration);
    }
  }
  return result;
}

function namePattern(names) {
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hexDigits = (value) =>
    Array.from(value, (digit) => `[${digit.toLowerCase()}${digit.toUpperCase()}]`).join("");
  const continuation = `(?:\\\\(?:\\r\\n?|\\n|\\u2028|\\u2029))`;
  const character = (value) => {
    const code = value.charCodeAt(0);
    const hex = code.toString(16).padStart(2, "0");
    const unicode = code.toString(16).padStart(4, "0");
    return `(?:${escapeRegex(value)}|\\\\u${hexDigits(unicode)}|\\\\u\\{0*${hexDigits(code.toString(16))}\\}|\\\\x${hexDigits(hex)}|\\\\${code.toString(8)}|\\\\(?![uUxX0-7])${escapeRegex(value)})`;
  };
  const escaped = (name) =>
    `(?:${continuation}*${Array.from(name, (value) => `${character(value)}${continuation}*`).join("")})`;
  return new RegExp(names.map(escaped).join("|"));
}
