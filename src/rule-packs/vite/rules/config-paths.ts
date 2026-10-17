import { createRule } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import {
  isViteConfigFile,
  memberPath,
  propertyName,
  staticString,
  type AnyNode,
} from "./shared.js";

const nodeSideImports = new Set(["vite", "vite-plus", "vitest/config"]);

export const noUrlPathnameAsFsPath = createRule({
  meta: {
    id: "vite/config/no-url-pathname-as-fs-path",
    title: "Convert import.meta.url URLs with fileURLToPath",
    category: "config",
    severity: "warn",
    docsUrl: "https://nodejs.org/api/url.html#urlfileurltopathurl-options",
    requires: { script: true },
    prefilter: { names: ["pathname"] },
  },
  create(ctx) {
    let inScope = isViteConfigFile(ctx.file.relativePath);
    const urlBindings = new Map<string, AnyNode>();
    const shadowParams = (node: AnyNode) => {
      for (const param of node.params)
        if (param.type === "Identifier") urlBindings.set(param.name, null);
    };
    return {
      Program(node: AnyNode) {
        inScope ||= node.body.some(
          (statement: AnyNode) =>
            statement.type === "ImportDeclaration" &&
            nodeSideImports.has(String(statement.source.value)),
        );
      },
      VariableDeclarator(node: AnyNode) {
        if (!inScope || node.id.type !== "Identifier") return;
        const name = node.id.name;
        const isConst = node.__doctorParent?.kind === "const";
        urlBindings.set(
          name,
          urlBindings.has(name) || !isConst || !isModuleFileUrl(node.init) ? null : node.init,
        );
      },
      ArrowFunctionExpression: shadowParams,
      FunctionExpression: shadowParams,
      FunctionDeclaration: shadowParams,
      "MemberExpression:exit"(node: AnyNode) {
        if (!inScope) return;
        const property = node.computed ? staticString(node.property) : propertyName(node.property);
        if (property !== "pathname") return;
        const object = unwrap(node.object);
        if (
          !isModuleFileUrl(object) &&
          !(object?.type === "Identifier" && urlBindings.get(object.name))
        )
          return;
        ctx.report(
          diagnostics.VITE0027({
            why: "URL.pathname keeps percent-encoding, such as %20 for spaces, and on Windows it returns /C:/... instead of a drive path, so the resolved file or alias target does not exist.",
            fix: 'Convert the URL with fileURLToPath(new URL(..., import.meta.url)) from "node:url".',
          }),
          { file: ctx.file.path, range: ctx.range(node) },
        );
      },
    };
  },
});

function isModuleFileUrl(input: AnyNode): boolean {
  const node = unwrap(input);
  if (node?.type !== "NewExpression" || node.callee.type !== "Identifier") return false;
  if (node.callee.name !== "URL") return false;
  const base = node.arguments.length === 1 ? node.arguments[0] : node.arguments[1];
  return node.arguments.length <= 2 && memberPath(base) === "import.meta.url";
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}
