import { requireAnnotationTitle } from "./require-annotation-title.js";
import { requireSafetyHint } from "./require-safety-hint.js";
import { validName } from "./valid-name.js";

export { requireAnnotationTitle } from "./require-annotation-title.js";
export { requireSafetyHint } from "./require-safety-hint.js";
export { validName } from "./valid-name.js";

export const mcpRules = [requireAnnotationTitle, requireSafetyHint, validName];
