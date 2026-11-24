import type { RuleContext } from "../../../../core/index.js";
import { scriptMayName, type ScopeVariable } from "../../../../core/internal/script-scope.js";
import { AnyNode, createRule, namePattern } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";
import { matchesPrefix, templateWrites, type PropertyPath } from "./template-reads.js";
import {
  constBinding,
  indexedScript,
  memberName,
  unwrapTs,
  valueParent,
  vueApiCall,
  type IndexedScript,
} from "./vue-api.js";

const RULE_ID = "vue/watch/no-property-read-source";
const WATCH = new Set(["watch"]);
const REACTIVE = new Set(["reactive"]);

interface PropertySource {
  node: AnyNode;
  text: string;
}

/**
 * `watch(props.user, cb)` hands watch() the property's current value, not a way to read it again.
 * Only report known primitives; refs, reactive objects and getters can already be valid sources.
 */
export const noPropertyReadWatchSource = createRule({
  meta: {
    id: RULE_ID,
    title: "Watch a reactive property through a getter",
    category: "watchers",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://vuejs.org/guide/essentials/watchers.html#watch-source-types",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    if (!scriptMayName(ctx, namePattern([...WATCH]))) return;
    return {
      Program() {
        for (const source of propertySources(ctx)) {
          ctx.report(
            diagnostics.VUE0050({
              why: `watch(${source.text}, ...) reads the property once and passes its current primitive value. Vue cannot track changes to the property from that value.`,
              fix: `Pass a getter: watch(() => ${source.text}, ...).`,
            }),
            {
              ruleId: RULE_ID,
              severity: "error",
              category: "watchers",
              file: ctx.file.path,
              range: ctx.range(source.node.range[0], source.node.range[1]),
              fix: {
                kind: "suggestion",
                message: "Wrap the source in a getter.",
                edits: [
                  {
                    range: { start: source.node.range[0], end: source.node.range[1] },
                    text: `() => ${source.text}`,
                  },
                ],
              },
            },
          );
        }
      },
    };
  },
});

function propertySources(ctx: RuleContext): PropertySource[] {
  const script = indexedScript(ctx);
  if (!script) return [];
  const result: PropertySource[] = [];
  try {
    for (const call of script.nodes("CallExpression")) {
      if (!vueApiCall(script, call.callee, WATCH)) continue;
      const source = unwrapTs(call.arguments[0]);
      const candidates = source?.type === "ArrayExpression" ? source.elements : [source];
      for (const candidate of candidates) {
        const node = unwrapTs(candidate);
        if (!isPrimitiveProperty(ctx, script, node)) continue;
        result.push({
          node: candidate,
          text: ctx.file.text.slice(candidate.range[0], candidate.range[1]),
        });
      }
    }
  } catch {
    return [];
  }
  return result;
}

function isPrimitiveProperty(ctx: RuleContext, script: IndexedScript, node: AnyNode): boolean {
  const path: string[] = [];
  if (node?.type === "ChainExpression") node = node.expression;
  if (node?.type !== "MemberExpression") return false;
  while (node.type === "MemberExpression") {
    const name = memberName(node);
    if (name === undefined || /^\d+$/.test(name)) return false;
    path.unshift(name);
    node = unwrapTs(node.object);
  }
  if (node.type !== "Identifier") return false;
  const variable = script.references.get(node)?.resolved;
  const definition = variable?.defs[0];
  if (variable?.defs.length !== 1 || definition?.type !== "Variable") return false;
  const declarator = definition.node as AnyNode;
  if (constBinding(script, declarator) !== variable) return false;
  const init = unwrapTs(declarator.init);
  if (isDefineProps(script, init)) return isPrimitiveProp(script, init, path);
  if (init?.type !== "CallExpression" || !vueApiCall(script, init.callee, REACTIVE)) return false;
  let value = init.arguments[0];
  for (const key of path) value = dataProperties(value)?.get(key);
  return isPrimitiveLiteral(value) && stableProperty(ctx, script, variable, node.name, path);
}

/** `defineProps()` or `withDefaults(defineProps(), ...)`, the compiler macros. */
function isDefineProps(script: IndexedScript, node: AnyNode): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = unwrapTs(node.callee);
  if (callee?.type !== "Identifier" || script.references.get(callee)?.resolved) return false;
  if (callee.name === "withDefaults") return isDefineProps(script, unwrapTs(node.arguments[0]));
  return callee.name === "defineProps";
}

const PRIMITIVE_TYPES = new Set([
  "TSStringKeyword",
  "TSNumberKeyword",
  "TSBooleanKeyword",
  "TSBigIntKeyword",
  "TSSymbolKeyword",
  "TSNullKeyword",
  "TSUndefinedKeyword",
  "TSVoidKeyword",
]);
const PRIMITIVE_CONSTRUCTORS = new Set(["String", "Number", "Boolean", "BigInt", "Symbol"]);

function isPrimitiveProp(script: IndexedScript, call: AnyNode, path: string[]): boolean {
  if (unwrapTs(call.callee).name === "withDefaults") {
    const defaults = dataProperties(call.arguments[1]);
    if (!defaults || (defaults.has(path[0]!) && !isPrimitiveLiteral(defaults.get(path[0]!))))
      return false;
    call = unwrapTs(call.arguments[0]);
  }
  let type = call.typeArguments?.params[0];
  if (type) {
    for (const key of path) {
      if (type?.type !== "TSTypeLiteral") return false;
      const property = type.members.find(
        (member: AnyNode) =>
          member.type === "TSPropertySignature" &&
          !member.computed &&
          (member.key.name ?? member.key.value) === key,
      );
      type = property?.typeAnnotation?.typeAnnotation;
    }
    return isPrimitiveType(type);
  }
  if (path.length !== 1) return false;
  const declaration = dataProperties(call.arguments[0])?.get(path[0]!);
  const options = dataProperties(declaration);
  if (options?.has("default") && !isPrimitiveLiteral(options.get("default"))) return false;
  const constructor = unwrapTs(options ? options.get("type") : declaration);
  return (
    constructor?.type === "Identifier" &&
    PRIMITIVE_CONSTRUCTORS.has(constructor.name) &&
    !script.references.get(constructor)?.resolved
  );
}

function isPrimitiveType(node: AnyNode): boolean {
  return (
    PRIMITIVE_TYPES.has(node?.type) ||
    (node?.type === "TSLiteralType" && isPrimitiveLiteral(node.literal)) ||
    (node?.type === "TSUnionType" && node.types.every(isPrimitiveType))
  );
}

function isPrimitiveLiteral(node: AnyNode): boolean {
  node = unwrapTs(node);
  return (
    node?.type === "TemplateLiteral" ||
    (node?.type === "Literal" &&
      (node.value === null ||
        ["boolean", "bigint", "number", "string"].includes(typeof node.value)))
  );
}

function dataProperties(node: AnyNode): Map<string, AnyNode> | undefined {
  node = unwrapTs(node);
  if (node?.type !== "ObjectExpression") return undefined;
  const properties = new Map<string, AnyNode>();
  for (const property of node.properties) {
    if (property.type !== "Property" || property.kind !== "init" || property.computed)
      return undefined;
    const key = property.key.name ?? property.key.value;
    if (key === "__proto__") return undefined;
    properties.set(String(key), property.value);
  }
  return properties;
}

function stableProperty(
  ctx: RuleContext,
  script: IndexedScript,
  variable: ScopeVariable,
  name: string,
  path: PropertyPath,
): boolean {
  if (templateWrites(ctx, name).some((write) => matchesPrefix(write, path))) return false;
  for (const reference of variable.references) {
    if (reference.init) continue;
    const used: (string | undefined)[] = [];
    let node: AnyNode = reference.identifier;
    for (;;) {
      const [parent, child] = valueParent(script, node);
      if (parent?.type !== "MemberExpression" || parent.object !== child) {
        if (!matchesPrefix(used, path)) break;
        if (used.length < path.length) return false;
        if (
          (parent?.type === "AssignmentExpression" && parent.left === child) ||
          (parent?.type === "UpdateExpression" && parent.argument === child) ||
          (parent?.type === "UnaryExpression" &&
            parent.operator === "delete" &&
            parent.argument === child) ||
          (parent?.type === "Property" &&
            parent.value === child &&
            script.parent(parent)?.type === "ObjectPattern") ||
          parent?.type === "ArrayPattern" ||
          parent?.type === "RestElement" ||
          parent?.type === "AssignmentPattern" ||
          ((parent?.type === "ForInStatement" || parent?.type === "ForOfStatement") &&
            parent.left === child)
        )
          return false;
        break;
      }
      used.push(memberName(parent));
      node = parent;
    }
  }
  return true;
}
