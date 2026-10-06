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

const PROGRAM_TEMPLATE_KEYS = ["body", "templateBody"] as const;
const ELEMENT_KEYS = ["children", "startTag", "endTag"] as const;
const START_TAG_KEYS = ["attributes"] as const;
const ATTRIBUTE_KEYS = ["key", "value"] as const;
const EXPRESSION_CONTAINER_KEYS = ["expression", "references"] as const;
const FOR_EXPRESSION_KEYS = ["left", "right"] as const;

export function getNodeVisitorKeys(
  node: { type?: string } & Record<string, unknown>,
): readonly string[] {
  const keys = node.type ? parserVisitorKeys[node.type] : undefined;
  if (keys) return keys;
  return Object.keys(node).filter(
    (key) => !ignoredFallbackKeys.has(key) && isTraversableChild(node[key]),
  );
}

export function getTemplateVisitorKeys(
  node: { type?: string } & Record<string, unknown>,
): readonly string[] {
  switch (node.type) {
    case "Program":
      return PROGRAM_TEMPLATE_KEYS;
    case "VDocumentFragment":
    case "VElement":
      return ELEMENT_KEYS;
    case "VStartTag":
      return START_TAG_KEYS;
    case "VAttribute":
    case "VDirective":
      return ATTRIBUTE_KEYS;
    case "VExpressionContainer":
      return EXPRESSION_CONTAINER_KEYS;
    case "VForExpression":
      return FOR_EXPRESSION_KEYS;
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
