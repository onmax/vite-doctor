import {
  nearestFunctionOrProgram,
  projectFor,
  relativePath,
  reportDoctor,
  sourceForNode,
  walkLocal,
} from "./shared.mjs";

const CODE = "NITRO0006";
const WHY = "This query object is read raw and validated separately.";
const RAW_UTILITIES = new Set(["getQuery"]);

/**
 * Port of `nitro/request/prefer-validated-query`. Doctor re-parses the file with
 * typescript-eslint to index read references per binding; this port reads the same facts from
 * oxlint's scope manager. File classification needs the framework from Project Inventory.
 */
export const preferValidatedQuery = {
  meta: { type: "suggestion", docs: { url: "https://vite-doctor.onmax.me/diagnostics/NITRO0006" } },
  create(context) {
    const project = projectFor(context);
    if (!project || !isNitroServerFile(project, relativePath(context, project))) return {};
    let bindings;
    const source = context.sourceCode.text;
    return {
      VariableDeclarator(node) {
        if (!rawInputVariable(node)) return;
        const scope = nearestFunctionOrProgram(node);
        const references = (bindings ??= variableReferences(context.sourceCode.scopeManager)).get(
          node.id.start,
        );
        if (
          !scope ||
          !references ||
          !hasValidationOfVariable(scope, references, source, node.start)
        )
          return;
        reportDoctor(context, node, CODE, WHY);
      },
    };
  },
};

function isNitroServerFile(project, path) {
  if (project.framework === "nuxt")
    return path.startsWith("server/") || path.startsWith("app/server/");
  if (project.framework !== "nitro") return false;
  return (
    /^(?:server\/)?(?:api|routes)\/.+\.[cm]?[jt]s$/.test(path) ||
    /^(?:server\/)?middleware\/.+\.[cm]?[jt]s$/.test(path)
  );
}

function rawInputVariable(node) {
  if (node.id?.type !== "Identifier") return false;
  const call = node.init?.type === "AwaitExpression" ? node.init.argument : node.init;
  if (call?.type !== "CallExpression") return false;
  const name = calleeName(call);
  return Boolean(name && RAW_UTILITIES.has(name));
}

function variableReferences(scopeManager) {
  const result = new Map();
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables) {
      const references = new Set(
        variable.references
          .filter(
            (reference) =>
              reference.isRead() && reference.from.variableScope === variable.scope.variableScope,
          )
          .map((reference) => reference.identifier.start),
      );
      for (const definition of variable.defs) {
        if (definition.type === "Variable" && definition.node.id.type === "Identifier")
          result.set(definition.node.id.start, references);
      }
    }
  }
  return result;
}

function hasValidationOfVariable(scope, references, source, after) {
  let found = false;
  walkLocal(scope.body ?? scope, (node) => {
    if (found || node.type !== "CallExpression") return;
    if (typeof node.start === "number" && node.start <= after) return;
    if (
      isDirectValidatorCall(node, references) ||
      isSchemaMethodValidatorCall(node, references, source)
    )
      found = true;
  });
  return found;
}

function referencesArgument(node, references) {
  return node.arguments?.some((arg) => arg.type === "Identifier" && references.has(arg.start));
}

function isDirectValidatorCall(node, references) {
  const name = calleeName(node);
  return (
    Boolean(name && /^(validate|validator|parse|safeParse|assert|check)\w*$/i.test(name)) &&
    referencesArgument(node, references)
  );
}

function isSchemaMethodValidatorCall(node, references, source) {
  const name = calleeName(node);
  if (name !== "parse" && name !== "safeParse" && name !== "validate") return false;
  if (!referencesArgument(node, references)) return false;
  return /\b(?:schema|validator|body|query|params|input|payload|zod|valibot|v|s)\w*\.(?:parse|safeParse|validate)$/.test(
    sourceForNode(node.callee, source),
  );
}

function calleeName(node) {
  return node?.callee?.type === "Identifier"
    ? node.callee.name
    : (node?.callee?.property?.name ?? null);
}
