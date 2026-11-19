import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, report, type AnyNode } from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";
import {
  REALM_CLASSES,
  crossRealmOrigin,
  hasRealmSafeAlternative,
  realmSafeFix,
  type LocalEvidence,
  type Origin,
} from "./cross-realm.js";

const ruleId = "typescript/boundaries/no-cross-realm-prototype-identity";

const PLAIN_OBJECT_FIX =
  "Check for a plain object without comparing prototypes: const prototype = Object.getPrototypeOf(value); prototype === null || Object.getPrototypeOf(prototype) === null.";

type Intrinsic = { className: string; form: "prototype" | "constructor" };
type Foreign = { origin: Origin; subject: AnyNode };

export const noCrossRealmPrototypeIdentity = createRule({
  meta: {
    id: ruleId,
    title: "Do not compare prototypes of values from another realm",
    description:
      "Report prototype and constructor identity checks against built-in classes on values that may come from another JavaScript realm.",
    why: "Every realm has its own Object.prototype, Array.prototype and built-in constructors. A plain object or array created by the Vite module runner, workerd or miniflare, or a Vitest environment has that realm's prototype, so Object.getPrototypeOf(value) === Object.prototype or value.constructor === Array is false and the check rejects or misroutes it. This rule only reports values that crossed a boundary in this file: parameters typed unknown or any, results of calling a parameter, and module namespaces from import() or ssrLoadModule().",
    recommendedReplacement:
      "Avoid realm identity: use Array.isArray(value) for arrays, Object.getPrototypeOf(prototype) === null for plain objects, or a tag shared by the implementations you support where applicable. Narrow only to the capabilities a member check verifies. If you need full class semantics, validate or normalize the value at the integration boundary.",
    examples: [
      {
        title: "Check plain objects without Object.prototype",
        language: "ts",
        invalid:
          "export function isPlainObject(value: unknown): value is Record<string, unknown> {\n  if (typeof value !== 'object' || value === null) return false\n  const prototype = Object.getPrototypeOf(value)\n  return prototype === Object.prototype || prototype === null\n}",
        valid:
          "export function isPlainObject(value: unknown): value is Record<string, unknown> {\n  if (typeof value !== 'object' || value === null) return false\n  const prototype = Object.getPrototypeOf(value)\n  return prototype === null || Object.getPrototypeOf(prototype) === null\n}",
      },
    ],
    category: "boundaries",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "structural-review",
    docsUrl:
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/instanceof#instanceof_and_multiple_realms",
    requires: { script: true },
    prefilter: { names: ["prototype", "constructor"] },
  },
  create(ctx) {
    if (!isTypeScriptSource(ctx)) return;
    let evidence: LocalEvidence;

    // `Object.prototype` or `Array`, read from the global scope.
    function intrinsic(node: AnyNode): Intrinsic | undefined {
      const value = expression(node, true);
      if (value?.type === "Identifier")
        return isGlobalClass(value) ? { className: value.name, form: "constructor" } : undefined;
      if (
        value?.type === "MemberExpression" &&
        !value.computed &&
        value.property?.name === "prototype" &&
        isGlobalClass(expression(value.object, true))
      )
        return { className: expression(value.object, true).name, form: "prototype" };
      return undefined;
    }

    function isGlobalClass(node: AnyNode): boolean {
      return (
        node?.type === "Identifier" &&
        Object.hasOwn(REALM_CLASSES, node.name) &&
        !evidence.binding(node)
      );
    }

    // The prototype of a value from another realm, and that prototype's own prototypes, belong to
    // the same realm.
    function foreignPrototype(node: AnyNode, depth = 0): Foreign | undefined {
      const value = expression(node, true);
      if (depth > 4) return undefined;
      if (value?.type === "CallExpression") {
        const callee = expression(value.callee, true);
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          callee.property?.name !== "getPrototypeOf" ||
          !["Object", "Reflect"].includes(expression(callee.object, true)?.name) ||
          evidence.binding(expression(callee.object, true))
        )
          return undefined;
        return foreignValue(value.arguments?.[0], depth + 1);
      }
      if (value?.type !== "Identifier") return undefined;
      const binding = evidence.binding(value);
      if (!binding || binding.written || binding.kind !== "const" || !binding.init)
        return undefined;
      if (binding.node.start >= value.start) return undefined;
      return foreignPrototype(binding.init, depth + 1);
    }

    function foreignValue(node: AnyNode, depth: number): Foreign | undefined {
      const origin = crossRealmOrigin(evidence, node);
      if (origin) return { origin, subject: expression(node, true) };
      return foreignPrototype(node, depth);
    }

    function foreignConstructor(node: AnyNode): Foreign | undefined {
      const value = expression(node, true);
      if (value?.type !== "MemberExpression" || value.computed) return undefined;
      if (value.property?.name !== "constructor") return undefined;
      return foreignValue(value.object, 0);
    }

    return {
      Program(node: AnyNode) {
        evidence = createLocalEvidence(node);
      },
      BinaryExpression(node: AnyNode) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        for (const [value, other] of [
          [node.left, node.right],
          [node.right, node.left],
        ]) {
          const target = intrinsic(other);
          if (!target) continue;
          const foreign =
            target.form === "prototype" ? foreignPrototype(value) : foreignConstructor(value);
          if (!foreign) continue;
          const { className, form } = target;
          if (
            foreign.subject?.type === "Identifier" &&
            hasRealmSafeAlternative(node, className, foreign.subject.name)
          )
            return;
          const compared = form === "prototype" ? `${className}.prototype` : className;
          report(
            ctx,
            node,
            ruleId,
            `This ${foreign.origin} can come from another realm (Vite module runner, workerd, or a Vitest environment), where its ${form} is that realm's ${compared}, so comparing it with this realm's ${compared} is false.`,
            className === "Object"
              ? PLAIN_OBJECT_FIX
              : `Replace the ${form === "prototype" ? compared : `${className} constructor`} comparison with ${realmSafeFix(className)}`,
          );
          return;
        }
      },
    };
  },
});
