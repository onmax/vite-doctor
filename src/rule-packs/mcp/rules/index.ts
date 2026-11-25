import { noExcludedTool } from "./no-excluded-tool.js";
import { noIndentedJsonOutput } from "./no-indented-json-output.js";
import { noReducedContext } from "./no-reduced-context.js";
import { noRewrittenSchema } from "./no-rewritten-schema.js";
import { noStrippedConstraint } from "./no-stripped-constraint.js";
import { noTruncatedText } from "./no-truncated-text.js";
import { requireAnnotationTitle } from "./require-annotation-title.js";
import { requireSafetyHint } from "./require-safety-hint.js";
import { validName } from "./valid-name.js";

export { noExcludedTool } from "./no-excluded-tool.js";
export { noIndentedJsonOutput } from "./no-indented-json-output.js";
export { noReducedContext } from "./no-reduced-context.js";
export { noRewrittenSchema } from "./no-rewritten-schema.js";
export { noStrippedConstraint } from "./no-stripped-constraint.js";
export { noTruncatedText } from "./no-truncated-text.js";
export { requireAnnotationTitle } from "./require-annotation-title.js";
export { requireSafetyHint } from "./require-safety-hint.js";
export { validName } from "./valid-name.js";

export const mcpRules = [
  requireAnnotationTitle,
  requireSafetyHint,
  validName,
  noIndentedJsonOutput,
  noExcludedTool,
  noTruncatedText,
  noRewrittenSchema,
  noStrippedConstraint,
  noReducedContext,
];
