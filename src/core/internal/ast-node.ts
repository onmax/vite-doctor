import { isString } from "./value-schema.js";

export type AstNode = Record<string, unknown> & { type: string };

export function isAstNode(value: unknown): value is AstNode {
  return value instanceof Object && isString(Reflect.get(value, "type"));
}

export function isSourceOffset(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value) && Number(value) >= 0;
}

export function stringLiteralValue(node: unknown): string | null {
  if (!isAstNode(node) || node.type !== "Literal") return null;
  const value = node.value;
  return isString(value) ? value : null;
}
