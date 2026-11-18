import type { RuleContext } from "../../../../core/index.js";
import type { AnyNode } from "./shared.js";
import { indexedScript, vueApiCall } from "./vue-api.js";

/** Prove a render branch cannot run until a false ref is enabled after mount. */
export function isPostMountBranch(ctx: RuleContext, node: AnyNode): boolean {
  const script = indexedScript(ctx);
  if (!script) return false;
  for (
    let child = node, parent = node.__doctorParent;
    parent;
    child = parent, parent = parent.__doctorParent
  ) {
    if (parent.type !== "ConditionalExpression" || parent.consequent !== child) continue;
    const test = parent.test;
    if (
      test.type !== "MemberExpression" ||
      test.computed ||
      test.property.name !== "value" ||
      test.object.type !== "Identifier"
    )
      continue;
    const variable = script.references.get(
      script.nodes("Identifier").find((id) => id.range?.[0] === test.object.start),
    )?.resolved;
    const declaration = variable?.defs[0]?.node as AnyNode;
    const init = declaration?.init;
    if (
      init?.type !== "CallExpression" ||
      !vueApiCall(script, init.callee, new Set(["ref", "shallowRef"])) ||
      init.arguments[0]?.value !== false
    )
      continue;
    let enabled = false;
    const safe = variable!.references.every((reference) => {
      const member = script.parent(reference.identifier);
      if (member?.type !== "MemberExpression" || member.object !== reference.identifier)
        return Boolean(reference.init);
      if (member.computed || member.property.name !== "value") return false;
      const assignment = script.parent(member);
      if (
        assignment?.type === "UpdateExpression" ||
        (assignment?.type === "UnaryExpression" && assignment.operator === "delete")
      )
        return false;
      if (assignment?.type !== "AssignmentExpression" || assignment.left !== member) return true;
      const fn = script.owner(assignment);
      const call = fn && script.parent(fn);
      const mounted =
        call?.type === "CallExpression" && vueApiCall(script, call.callee, new Set(["onMounted"]));
      if (mounted && assignment.operator === "=" && assignment.right.value === true) {
        enabled = true;
        return true;
      }
      return false;
    });
    if (safe && enabled) return true;
  }
  return false;
}
