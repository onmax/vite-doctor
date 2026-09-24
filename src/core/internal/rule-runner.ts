import type { RuleVisitor, SourceFileHandle } from "../primitives.js";
import { isAstNode } from "./ast-node.js";
import { getNodeVisitorKeys, getTemplateVisitorKeys } from "./visitor-keys.js";

export async function runVisitor(visitor: RuleVisitor, file: SourceFileHandle) {
  if (file.sfc) await visitor.SFC?.(file.sfc);
  if (file.scriptAst && (visitor.ScriptNode || visitor.ImportDeclaration))
    walkScript(file.scriptAst, (node) => {
      visitor.ScriptNode?.(node);
      if (isAstNode(node) && node.type === "ImportDeclaration") visitor.ImportDeclaration?.(node);
    });
  if (file.templateAst && visitor.TemplateNode)
    walkTemplate(file.templateAst, (node) => visitor.TemplateNode?.(node));
}

function walkScript(node: unknown, visit: (node: unknown) => void, parent?: unknown) {
  if (!isAstNode(node)) return;
  if (parent) setDoctorParent(node, parent);
  visit(node);
  for (const key of getNodeVisitorKeys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walkScript(child, visit, node);
    } else if (isAstNode(value)) {
      walkScript(value, visit, node);
    }
  }
}

function setDoctorParent(node: { type?: string }, parent: unknown) {
  try {
    Object.defineProperty(node, "__doctorParent", {
      value: parent,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Some parser nodes may be frozen by future parser versions.
  }
}

function walkTemplate(node: unknown, visit: (node: unknown) => void) {
  if (!isAstNode(node)) return;
  visit(node);
  for (const key of getTemplateVisitorKeys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walkTemplate(child, visit);
    } else if (isAstNode(value)) {
      walkTemplate(value, visit);
    }
  }
}
