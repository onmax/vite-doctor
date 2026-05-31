import * as oxcParser from "oxc-parser";

type VisitorKeyMap = Record<string, readonly string[]>;

const parserVisitorKeys = isVisitorKeyMap((oxcParser as { visitorKeys?: unknown }).visitorKeys)
  ? (oxcParser as { visitorKeys: VisitorKeyMap }).visitorKeys
  : {};
const ignoredFallbackKeys = new Set([
  "__doctorParent",
  "comments",
  "end",
  "loc",
  "parent",
  "range",
  "start",
  "tokens",
]);

export function getNodeVisitorKeys(node: { type?: string } & Record<string, unknown>): string[] {
  const keys = node.type ? parserVisitorKeys[node.type] : undefined;
  if (keys) return [...keys];
  return Object.keys(node).filter(
    (key) => !ignoredFallbackKeys.has(key) && isTraversableChild(node[key]),
  );
}

export function getTemplateVisitorKeys(
  node: { type?: string } & Record<string, unknown>,
): string[] {
  switch (node.type) {
    case "Program":
      return ["body", "templateBody"];
    case "VDocumentFragment":
    case "VElement":
      return ["children", "startTag", "endTag"];
    case "VStartTag":
      return ["attributes"];
    case "VAttribute":
    case "VDirective":
      return ["key", "value"];
    case "VExpressionContainer":
      return ["expression", "references"];
    case "VForExpression":
      return ["left", "right"];
    default:
      return getNodeVisitorKeys(node);
  }
}

function isVisitorKeyMap(value: unknown): value is VisitorKeyMap {
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(
    (keys) => Array.isArray(keys) && keys.every((key) => typeof key === "string"),
  );
}

function isTraversableChild(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(isAstNode);
  return isAstNode(value);
}

function isAstNode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { type?: unknown }).type === "string";
}
