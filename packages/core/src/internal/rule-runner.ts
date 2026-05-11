import { visitorKeys } from "oxc-parser";
import type { RuleVisitor, SourceFileHandle } from "../primitives.js";

export async function runVisitor(visitor: RuleVisitor, file: SourceFileHandle) {
  if (file.sfc) visitor.SFC?.(file.sfc);
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
  const keys = typed.type ? visitorKeys[typed.type] : undefined;
  for (const key of keys ?? []) {
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
  for (const key of getTemplateVisitorKeys(typed.type)) {
    const value = (typed as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) walkTemplate(child, visit);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      walkTemplate(value, visit);
    }
  }
}

function getTemplateVisitorKeys(type: string): string[] {
  if (visitorKeys[type]) return visitorKeys[type];
  switch (type) {
    case "Program":
      return ["body", "templateBody"];
    case "VDocumentFragment":
    case "VElement":
      return ["children", "startTag", "endTag"];
    case "VStartTag":
      return ["attributes"];
    case "VAttribute":
      return ["key", "value"];
    case "VDirective":
      return ["key", "value"];
    case "VExpressionContainer":
      return ["expression", "references"];
    case "VForExpression":
      return ["left", "right"];
    default:
      return [];
  }
}
