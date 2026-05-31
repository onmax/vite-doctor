import type { RuleVisitor, SourceFileHandle } from "../primitives.js";
import { getNodeVisitorKeys, getTemplateVisitorKeys } from "./visitor-keys.js";

export async function runVisitor(visitor: RuleVisitor, file: SourceFileHandle) {
  if (file.sfc) await visitor.SFC?.(file.sfc);
  if (file.scriptAst)
    walkScript(file.scriptAst, (node) => {
      visitor.ScriptNode?.(node);
      if ((node as any).type === "ImportDeclaration") visitor.ImportDeclaration?.(node);
    });
  if (file.templateAst) walkTemplate(file.templateAst, (node) => visitor.TemplateNode?.(node));
}

function walkScript(node: unknown, visit: (node: unknown) => void, parent?: unknown) {
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  if (parent) setDoctorParent(typed, parent);
  visit(typed);
  for (const key of getNodeVisitorKeys(typed as Record<string, unknown>)) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkScript(child, visit, typed);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      walkScript(value, visit, typed);
    }
  }
}

function setDoctorParent(node: object, parent: unknown) {
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
  if (!node || typeof node !== "object") return;
  const typed = node as { type?: string };
  if (!typed.type) return;
  visit(typed);
  for (const key of getTemplateVisitorKeys(typed as Record<string, unknown>)) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkTemplate(child, visit);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      walkTemplate(value, visit);
    }
  }
}
