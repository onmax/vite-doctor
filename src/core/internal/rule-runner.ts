import type { RuleVisitor, SourceFileHandle } from "../primitives.js";
import { getNodeVisitorKeys, getTemplateVisitorKeys } from "./visitor-keys.js";

type AstNode = Record<string, unknown> & { type: string };

export function runVisitor(visitor: RuleVisitor, file: SourceFileHandle): Promise<void> {
  return runVisitors([visitor], file);
}

export async function runVisitors(
  visitors: readonly RuleVisitor[],
  file: SourceFileHandle,
): Promise<void> {
  if (file.sfc) {
    for (const visitor of visitors) await visitor.SFC?.(file.sfc);
  }
  if (file.scriptAst) {
    const scriptVisitors = visitors.filter(
      (visitor) => visitor.ScriptNode !== undefined || visitor.ImportDeclaration !== undefined,
    );
    if (scriptVisitors.length > 0) dispatchScript(file.scriptAst, scriptVisitors);
  }
  if (file.templateAst) {
    const templateVisitors = visitors.filter((visitor) => visitor.TemplateNode !== undefined);
    if (templateVisitors.length > 0) dispatchTemplate(file.templateAst, templateVisitors);
  }
}

function dispatchScript(root: unknown, visitors: readonly RuleVisitor[]) {
  // Linking every parent before any visitor runs lets rules walk up from nodes the walk has not
  // reached yet, which they could rely on before only because earlier rules had already walked.
  const nodes: AstNode[] = [];
  collectScriptNodes(root, undefined, nodes);
  for (const node of nodes) {
    const isImport = node.type === "ImportDeclaration";
    for (const visitor of visitors) {
      visitor.ScriptNode?.(node);
      if (isImport) visitor.ImportDeclaration?.(node);
    }
  }
}

function collectScriptNodes(node: unknown, parent: AstNode | undefined, nodes: AstNode[]) {
  if (!node || typeof node !== "object") return;
  const typed = node as AstNode;
  if (!typed.type) return;
  if (parent) setDoctorParent(typed, parent);
  nodes.push(typed);
  for (const key of getNodeVisitorKeys(typed)) {
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const child of value) collectScriptNodes(child, typed, nodes);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      collectScriptNodes(value, typed, nodes);
    }
  }
}

function setDoctorParent(node: AstNode, parent: AstNode) {
  if ((node as { __doctorParent?: unknown }).__doctorParent === parent) return;
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

function dispatchTemplate(node: unknown, visitors: readonly RuleVisitor[]) {
  if (!node || typeof node !== "object") return;
  const typed = node as AstNode;
  if (!typed.type) return;
  for (const visitor of visitors) visitor.TemplateNode!(typed);
  for (const key of getTemplateVisitorKeys(typed)) {
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const child of value) dispatchTemplate(child, visitors);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      dispatchTemplate(value, visitors);
    }
  }
}
