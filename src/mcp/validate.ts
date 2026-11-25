import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DRAFT_07 = "http://json-schema.org/draft-07/schema";

// Formats stay off: no client documents checking `format: "regex"` and the like, and a false
// exclusion costs more than a missed one.
let draft2020: ValidateFunction | undefined;
let draft07: ValidateFunction | undefined;

/** Meta-schema errors against draft 2020-12, as `pointer message` lines; empty when valid. */
export function draft2020Errors(schema: unknown): string[] {
  draft2020 ??= new Ajv2020({ strict: false, validateFormats: false }).getSchema(DRAFT_2020_12)!;
  return errors(draft2020, schema);
}

/** Meta-schema errors against draft-07, as `pointer message` lines; empty when valid. */
export function draft07Errors(schema: unknown): string[] {
  draft07 ??= new Ajv({ strict: false, validateFormats: false }).getSchema(DRAFT_07)!;
  return errors(draft07, schema);
}

/** Whether `$schema` is absent or names draft 2020-12. */
export function declaresDraft2020OrNothing(schema: { $schema?: unknown }): boolean {
  if (schema.$schema === undefined) return true;
  return typeof schema.$schema === "string" && schema.$schema.replace(/#$/, "") === DRAFT_2020_12;
}

function errors(validate: ValidateFunction, schema: unknown): string[] {
  if (validate(schema)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
