import * as v from "valibot";
import type { DoctorSerializableConfig } from "../primitives.js";

const severity = v.picklist(["blocker", "error", "warn", "info"]);
const ruleConfig = v.union([v.literal("off"), severity, v.tuple([severity, v.unknown()])]);

export const doctorConfigSchema = v.object({
  extends: v.optional(v.union([v.literal("auto"), v.array(v.string())])),
  include: v.optional(v.array(v.string())),
  exclude: v.optional(v.array(v.string())),
  rules: v.optional(v.record(v.string(), ruleConfig)),
  suppressions: v.optional(
    v.array(
      v.object({
        ruleId: v.optional(v.string()),
        fingerprint: v.optional(v.string()),
        file: v.optional(v.string()),
        reason: v.string(),
      }),
    ),
  ),
  cache: v.optional(
    v.object({
      dir: v.optional(v.string()),
      strategy: v.optional(v.literal("content-hash")),
    }),
  ),
  score: v.optional(
    v.object({
      weights: v.optional(
        v.object({
          blocker: v.optional(v.number()),
          error: v.optional(v.number()),
          warn: v.optional(v.number()),
          info: v.optional(v.number()),
        }),
      ),
    }),
  ),
});

export function parseDoctorConfig(value: unknown): DoctorSerializableConfig {
  return v.parse(doctorConfigSchema, value);
}
