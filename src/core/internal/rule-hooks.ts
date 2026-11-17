import { doctorInternalDiagnostics } from "../internal-diagnostic-handles.js";
import type { DoctorRule, RuleLifecycleHooks, RuleVisitor } from "../primitives.js";
import { templateNodeKinds } from "./template.js";
import { scriptNodeTypes } from "./visitor-keys.js";

export type UnknownRuleHookReason =
  | "removed-script-node"
  | "removed-template-node"
  | "lifecycle-on-file"
  | "node-on-lifecycle"
  | "unknown";

const LIFECYCLE_HOOKS = new Set<string>([
  "onWorkspaceStart",
  "onProjectStart",
  "NuxtManifest",
  "onProjectEnd",
  "onWorkspaceEnd",
] satisfies Array<Exclude<keyof RuleLifecycleHooks, "SFC">>);

let knownHooks: string[] | undefined;
let knownTemplateHooks: string[] | undefined;

/**
 * Throws DOC0034 when `create()` returned a hook Doctor never calls for the Rule's execution kind,
 * because such a Rule would otherwise report nothing without any sign that it is broken.
 */
export function assertKnownRuleHooks(rule: DoctorRule, visitor: RuleVisitor): void {
  const execution = rule.meta.execution ?? "file";
  const fileRule = execution === "file";
  for (const [key, value] of Object.entries(visitor)) {
    if (key === "template" && value && typeof value === "object") {
      if (!fileRule) fail(rule, "template", "node-on-lifecycle");
      for (const [kind, handler] of Object.entries(value)) {
        if (typeof handler !== "function" || isTemplateHook(kind)) continue;
        fail(rule, `template.${kind}`, "unknown", closest(kind, templateHooks()));
      }
      continue;
    }
    if (typeof value !== "function") continue;
    if (LIFECYCLE_HOOKS.has(key)) {
      if (fileRule) fail(rule, key, "lifecycle-on-file");
      continue;
    }
    if (key === "SFC" || isScriptHook(key)) {
      if (!fileRule) fail(rule, key, "node-on-lifecycle");
      continue;
    }
    if (key === "ScriptNode") fail(rule, key, "removed-script-node");
    if (key === "TemplateNode") fail(rule, key, "removed-template-node");
    fail(rule, key, "unknown", closest(key, ruleHooks()));
  }
}

function fail(
  rule: DoctorRule,
  hook: string,
  reason: UnknownRuleHookReason,
  suggestion?: string,
): never {
  throw doctorInternalDiagnostics.DOC0034({
    ruleId: rule.meta.id,
    hook,
    execution: rule.meta.execution ?? "file",
    reason,
    suggestion,
  });
}

function isScriptHook(key: string): boolean {
  return scriptNodeTypes.has(key.endsWith(":exit") ? key.slice(0, -5) : key);
}

function isTemplateHook(key: string): boolean {
  return templateNodeKinds.has(key.endsWith(":exit") ? key.slice(0, -5) : key);
}

function ruleHooks(): string[] {
  return (knownHooks ??= [
    ...LIFECYCLE_HOOKS,
    "SFC",
    "template",
    ...[...scriptNodeTypes].flatMap((type) => [type, `${type}:exit`]),
  ]);
}

function templateHooks(): string[] {
  return (knownTemplateHooks ??= [...templateNodeKinds].flatMap((kind) => [kind, `${kind}:exit`]));
}

function closest(input: string, candidates: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(input.length / 4)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
