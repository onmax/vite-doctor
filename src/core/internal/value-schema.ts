import { is, number, string, boolean, bigint, record, unknown } from "valibot";

const stringSchema = string();
const numberSchema = number();
const booleanSchema = boolean();
const bigintSchema = bigint();
const recordSchema = record(stringSchema, unknown());

export function isString(value: unknown): value is string {
  return is(stringSchema, value);
}

export function isNumber(value: unknown): value is number {
  return is(numberSchema, value);
}

export function isBoolean(value: unknown): value is boolean {
  return is(booleanSchema, value);
}

export function isBigint(value: unknown): value is bigint {
  return is(bigintSchema, value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return is(recordSchema, value);
}

export function isStringSet(value: unknown): value is Set<string> {
  return value instanceof Set && [...value].every(isString);
}

export function isStringMap(value: unknown): value is Map<string, string> {
  return value instanceof Map && [...value].every(([key, item]) => isString(key) && isString(item));
}
