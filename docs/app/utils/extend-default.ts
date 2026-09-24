import { isBoolean, isRecord } from "../../../src/core/internal/value-schema.js";
type MergeTarget = Record<string, unknown> | unknown[];

function isMergeTarget(value: unknown): value is MergeTarget {
  return Array.isArray(value) || (isRecord(value) && value.constructor === Object);
}

function mergeInto(target: MergeTarget, source: unknown, deep: boolean): MergeTarget {
  if (!isMergeTarget(source)) {
    return target;
  }

  for (const [key, value] of Object.entries(source)) {
    if (deep && isMergeTarget(value)) {
      const current = Reflect.get(target, key);
      const nextTarget = isMergeTarget(current) ? current : Array.isArray(value) ? [] : {};

      Reflect.set(target, key, mergeInto(nextTarget, value, deep));
      continue;
    }

    Reflect.set(target, key, value);
  }

  return target;
}

export default function extend(...args: unknown[]): MergeTarget {
  let deep = false;
  let index = 0;

  if (isBoolean(args[0])) {
    deep = args[0];
    index = 1;
  }

  const maybeTarget = args[index];
  const target: MergeTarget = isMergeTarget(maybeTarget) ? maybeTarget : {};

  for (const source of args.slice(index + 1)) {
    mergeInto(target, source, deep);
  }

  return target;
}
