import { createRule } from "../../../core/index.js";
import { isTypeScriptSource, report, type AnyNode } from "./shared.js";
import { createLocalEvidence, expression } from "./local-evidence.js";

const ruleId = "typescript/boundaries/no-inherited-key-lookup";

type Evidence = ReturnType<typeof createLocalEvidence>;
// `record`: a string index signature filled by someone else, so every key is a lookup into caller data.
// `literal`: an object literal written in this file, a lookup table whose keys are in the source.
type RecordKind = "record" | "literal";
type KeyKind = "safe" | "unknown" | "broad";
type Lookup = { node: AnyNode; kind: "in" | "read"; record: AnyNode; key: AnyNode; text: Text };
type Text = { record: string; key: string };

const ITERATION_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);
const OWN_KEY_SOURCES = new Set(["keys", "entries", "getOwnPropertyNames"]);
const SAFE_TYPEOF = new Set(["string", "number", "boolean", "bigint", "symbol"]);
const PICK_METHODS = new Set(["at", "find", "findLast"]);
const KEY_LIST_METHODS = new Set(["filter", "sort", "toSorted", "slice", "reverse", "toReversed"]);
const STRING_KEY_METHODS = new Set(["toLowerCase", "toUpperCase", "trim", "toLocaleLowerCase"]);
const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);
// Properties an inherited Object.prototype function has. Reading any other property off it gives
// undefined, the same as a missing entry.
const FUNCTION_MEMBERS = new Set([
  ...PROTOTYPE_NAMES,
  ...Object.getOwnPropertyNames(Function.prototype),
  "prototype",
]);
const PROTOTYPE_KEYS = PROTOTYPE_NAMES.map((key) => key.toLowerCase());

export const noInheritedKeyLookup = createRule({
  meta: {
    id: ruleId,
    title: "Do not look up runtime keys in plain-object records",
    description:
      "Report `key in record` and `record[key]` reads where the record is a plain object and the key is runtime data, so Object.prototype keys such as toString and constructor match.",
    why: 'A plain object inherits Object.prototype. When the key comes from config, a request, a file name, or another record, "toString" in record is true and record["constructor"] returns a function, so the code accepts a name nobody configured or calls the wrong value. This rule reports membership tests and reads on values typed Record<string, T>, a string index signature, or object, and on object-literal lookup tables. It skips known keys, null-prototype records, lookups protected by a matching own-key guard, and uses that treat inherited entries like missing entries.',
    recommendedReplacement:
      "Check Object.hasOwn(record, key) before trusting the key, or keep the entries in a Map or an Object.create(null) record.",
    examples: [
      {
        title: "Check own keys before using a configured name",
        language: "ts",
        invalid:
          "export function useStore(stores: Record<string, Store>, name: string): Store {\n  const store = stores[name]\n  if (!store) throw new Error(`Unknown store: ${name}`)\n  return store\n}",
        valid:
          "export function useStore(stores: Record<string, Store>, name: string): Store {\n  const store = Object.hasOwn(stores, name) ? stores[name] : undefined\n  if (!store) throw new Error(`Unknown store: ${name}`)\n  return store\n}",
      },
    ],
    category: "boundaries",
    severity: "warn",
    confidence: "heuristic-medium",
    fixable: "suggestion",
    docsUrl:
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/hasOwn",
    requires: { script: true },
  },
  create(ctx) {
    if (!isTypeScriptSource(ctx)) return;
    let evidence: Evidence;
    let types: Map<string, AnyNode[]>;
    const lookups: Lookup[] = [];

    function globalReference(node: AnyNode, names: string[]): string | undefined {
      if (node?.type !== "TSTypeReference" || node.typeName?.type !== "Identifier") return;
      const name = node.typeName.name;
      return names.includes(name) && evidence.globalType(node, name) ? name : undefined;
    }

    function localType(node: AnyNode): AnyNode {
      if (node?.type !== "TSTypeReference" || node.typeName?.type !== "Identifier") return;
      const found = types.get(node.typeName.name);
      if (found?.length !== 1 || found[0].typeParameters?.params?.length) return;
      return found[0];
    }

    function annotatedKey(node: AnyNode, depth = 0): KeyKind {
      if (!node || depth > 8) return "unknown";
      if (
        ["TSStringKeyword", "TSAnyKeyword", "TSUnknownKeyword"].includes(node.type) ||
        globalReference(node, ["PropertyKey"])
      )
        return "broad";
      if (
        [
          "TSNumberKeyword",
          "TSSymbolKeyword",
          "TSBigIntKeyword",
          "TSBooleanKeyword",
          "TSNullKeyword",
          "TSUndefinedKeyword",
          "TSNeverKeyword",
        ].includes(node.type)
      )
        return "safe";
      if (node.type === "TSLiteralType")
        return PROTOTYPE_NAMES.includes(node.literal?.value) ? "broad" : "safe";
      if (
        node.type === "TSParenthesizedType" ||
        (node.type === "TSTypeOperator" && node.operator === "unique")
      )
        return annotatedKey(node.typeAnnotation, depth + 1);
      if (node.type === "TSUnionType") {
        const parts = node.types.map((part: AnyNode) => annotatedKey(part, depth + 1));
        return parts.includes("broad")
          ? "broad"
          : parts.every((part: KeyKind) => part === "safe")
            ? "safe"
            : "unknown";
      }
      if (
        node.type === "TSTypeOperator" &&
        node.operator === "keyof" &&
        node.typeAnnotation?.type === "TSTypeQuery"
      ) {
        const binding = stableBinding(node.typeAnnotation.exprName);
        if (isRecordType(binding?.annotation, depth + 1)) return "broad";
        if (binding?.kind === "const" && !binding.annotation && literalKeys(binding.init))
          return "safe";
      }
      const declaration = localType(node);
      return declaration?.type === "TSTypeAliasDeclaration"
        ? annotatedKey(declaration.typeAnnotation, depth + 1)
        : "unknown";
    }

    function stringKeyType(node: AnyNode, depth = 0): boolean {
      if (!node || depth > 8) return false;
      if (node.type === "TSStringKeyword" || globalReference(node, ["PropertyKey"])) return true;
      if (node.type === "TSUnionType")
        return node.types.some((part: AnyNode) => stringKeyType(part, depth + 1));
      if (node.type === "TSParenthesizedType") return stringKeyType(node.typeAnnotation, depth + 1);
      const declaration = localType(node);
      return (
        declaration?.type === "TSTypeAliasDeclaration" &&
        stringKeyType(declaration.typeAnnotation, depth + 1)
      );
    }

    function hasStringIndex(members: AnyNode[] | undefined): boolean {
      return !!members?.some(
        (member: AnyNode) =>
          member.type === "TSIndexSignature" &&
          stringKeyType(member.parameters?.[0]?.typeAnnotation?.typeAnnotation),
      );
    }

    function isRecordType(node: AnyNode, depth = 0): boolean {
      if (!node || depth > 8) return false;
      if (node.type === "TSParenthesizedType") return isRecordType(node.typeAnnotation, depth + 1);
      if (node.type === "TSObjectKeyword") return true;
      if (node.type === "TSTypeLiteral") return hasStringIndex(node.members);
      if (node.type === "TSUnionType") {
        const parts = node.types.filter(
          (part: AnyNode) => !["TSNullKeyword", "TSUndefinedKeyword"].includes(part.type),
        );
        return parts.length > 0 && parts.every((part: AnyNode) => isRecordType(part, depth + 1));
      }
      if (globalReference(node, ["Record"])) {
        const [key] = node.typeArguments?.params ?? [];
        return stringKeyType(key);
      }
      if (globalReference(node, ["Readonly", "Partial", "Required", "NonNullable"]))
        return isRecordType(node.typeArguments?.params?.[0], depth + 1);
      const declaration = localType(node);
      if (declaration?.type === "TSTypeAliasDeclaration")
        return isRecordType(declaration.typeAnnotation, depth + 1);
      if (declaration?.type === "TSInterfaceDeclaration")
        return hasStringIndex(declaration.body?.body);
      return false;
    }

    function typeMembers(node: AnyNode, depth = 0): AnyNode[] | undefined {
      if (!node || depth > 8) return;
      if (node.type === "TSParenthesizedType") return typeMembers(node.typeAnnotation, depth + 1);
      if (node.type === "TSTypeLiteral") return node.members;
      const declaration = localType(node);
      if (declaration?.type === "TSTypeAliasDeclaration")
        return typeMembers(declaration.typeAnnotation, depth + 1);
      if (declaration?.type === "TSInterfaceDeclaration") return declaration.body?.body;
    }

    function nullPrototype(node: AnyNode): boolean {
      const value = expression(node, true);
      if (value?.type === "ObjectExpression")
        return value.properties.some(
          (property: AnyNode) =>
            property.type === "Property" &&
            !property.computed &&
            !property.shorthand &&
            (property.key?.name ?? property.key?.value) === "__proto__" &&
            property.value?.type === "Literal" &&
            property.value.value === null,
        );
      if (value?.type !== "CallExpression") return false;
      const callee = expression(value.callee);
      return (
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        callee.object?.type === "Identifier" &&
        callee.object.name === "Object" &&
        !evidence.binding(callee.object) &&
        ((callee.property?.name === "create" &&
          value.arguments?.[0]?.type === "Literal" &&
          value.arguments[0].value === null) ||
          (callee.property?.name === "assign" && nullPrototype(value.arguments?.[0])))
      );
    }

    function recordKind(node: AnyNode, kind: "in" | "read"): RecordKind | undefined {
      const value = expression(node);
      // `(value as Record<string, unknown>)[key]` is how a property reader reads any member of an
      // unknown value, inherited methods included, so only a membership test is reported there.
      if (value?.type === "TSAsExpression" || value?.type === "TSTypeAssertion")
        return kind === "in" && isRecordType(value.typeAnnotation) ? "record" : undefined;
      if (value?.type === "Identifier") {
        const binding = evidence.binding(value);
        if (!binding || binding.kind === "ambiguous" || binding.kind === "other") return;
        const init = binding.kind === "parameter" ? undefined : expression(binding.init);
        if (stableBinding(value) && (nullPrototype(init) || moduleLoad(init))) return;
        if (binding.annotation) {
          if (!isRecordType(binding.annotation)) return;
          return init?.type === "ObjectExpression" ? "literal" : "record";
        }
        if (!init) return;
        return initializerKind(init);
      }
      if (
        value?.type === "MemberExpression" &&
        !value.computed &&
        value.property?.type === "Identifier"
      ) {
        const owner = expression(value.object);
        if (owner?.type !== "Identifier") return;
        const binding = evidence.binding(owner);
        if (!binding?.annotation || binding.kind === "ambiguous") return;
        const member = typeMembers(binding.annotation)?.find(
          (item: AnyNode) =>
            item.type === "TSPropertySignature" &&
            !item.computed &&
            (item.key?.name ?? item.key?.value) === value.property.name,
        );
        return isRecordType(member?.typeAnnotation?.typeAnnotation) ? "record" : undefined;
      }
    }

    function initializerKind(node: AnyNode): RecordKind | undefined {
      const value = expression(node);
      if (value?.type === "ObjectExpression") return "literal";
      if (value?.type === "CallExpression" && value.callee?.type === "Identifier") {
        const binding = evidence.binding(value.callee);
        const declaration = binding && evidence.parent(binding.node);
        if (declaration?.type === "FunctionDeclaration" && declaration.id === binding!.node)
          return isRecordType(declaration.returnType?.typeAnnotation) ? "record" : undefined;
      }
      if (value?.type === "TSAsExpression" || value?.type === "TSTypeAssertion") {
        const annotation = value.typeAnnotation;
        if (
          annotation?.type === "TSTypeReference" &&
          annotation.typeName?.type === "Identifier" &&
          annotation.typeName.name === "const"
        )
          return initializerKind(value.expression);
        return isRecordType(annotation) ? "record" : undefined;
      }
    }

    // A module namespace has a null prototype.
    function moduleLoad(node: AnyNode): boolean {
      let value = expression(node, true);
      return (
        value?.type === "AwaitExpression" &&
        expression(value.argument, true)?.type === "ImportExpression"
      );
    }

    function describe(node: AnyNode): string | undefined {
      const value = expression(node, true);
      if (value?.type === "Identifier") return value.name;
      if (value?.type === "ThisExpression") return "this";
      if (value?.type === "Literal" && typeof value.value === "string")
        return JSON.stringify(value.value);
      if (value?.type === "MemberExpression") {
        const object = describe(value.object);
        if (!object) return;
        if (!value.computed) return `${object}.${value.property?.name}`;
        const property = describe(value.property);
        return property ? `${object}[${property}]` : undefined;
      }
    }

    // `const source = value as Record<string, unknown>` reads the same object as `value`.
    function aliasOf(node: AnyNode): AnyNode {
      let value = expression(node, true);
      for (let depth = 0; depth < 4 && value?.type === "Identifier"; depth++) {
        const binding = evidence.binding(value);
        const init = binding?.kind === "const" ? expression(binding.init, true) : undefined;
        if (!init || !["Identifier", "MemberExpression"].includes(init.type)) break;
        value = init;
      }
      return value;
    }

    function sameRecord(node: AnyNode, record: AnyNode): boolean {
      const left = describe(node);
      if (left !== undefined && left === describe(record)) return true;
      const alias = describe(aliasOf(node));
      return alias !== undefined && alias === describe(aliasOf(record));
    }

    function numeric(node: AnyNode): boolean {
      const value = expression(node, true);
      if (value?.type === "Literal") return typeof value.value === "number";
      if (value?.type === "UpdateExpression") return true;
      if (value?.type === "UnaryExpression") return ["-", "+", "~"].includes(value.operator);
      if (value?.type === "BinaryExpression")
        return (
          ["-", "*", "/", "%", "**", "|", "&", "^", "<<", ">>", ">>>"].includes(value.operator) ||
          (value.operator === "+" && numeric(value.left) && numeric(value.right))
        );
      if (value?.type === "MemberExpression" && !value.computed)
        return value.property?.name === "length";
      if (value?.type === "Identifier") {
        const binding = evidence.binding(value);
        return binding?.annotation?.type === "TSNumberKeyword";
      }
      return false;
    }

    function literalList(node: AnyNode, depth = 0): boolean {
      const value = expression(node, true);
      if (!value || depth > 4) return false;
      if (value.type === "ArrayExpression")
        return value.elements.every((element: AnyNode) => {
          if (element?.type === "SpreadElement") return literalList(element.argument, depth + 1);
          return keyKind(element, undefined, depth + 1) === "safe";
        });
      if (value.type === "NewExpression" && value.callee?.name === "Set")
        return literalList(value.arguments?.[0], depth + 1);
      if (value.type === "Identifier") {
        const binding = evidence.binding(value);
        if (binding?.kind !== "const" || binding.written || !binding.init) return false;
        return literalList(binding.init, depth + 1);
      }
      return false;
    }

    // `{ apiKey: "API_KEY", from: "FROM" }`: an object literal whose own keys are all in the source.
    function literalKeys(node: AnyNode, depth = 0): boolean {
      const value = expression(node, true);
      if (value?.type === "Identifier" && depth < 3) {
        const binding = evidence.binding(value);
        return (
          binding?.kind === "const" && !binding.written && literalKeys(binding.init, depth + 1)
        );
      }
      return (
        value?.type === "ObjectExpression" &&
        value.properties.every((property: AnyNode) => {
          if (property.type !== "Property" || property.computed) return false;
          const name = property.key?.name ?? property.key?.value;
          return typeof name === "string" && !PROTOTYPE_NAMES.includes(name);
        })
      );
    }

    // Where the elements of an iterated collection come from, relative to the looked-up record.
    function iteratedKeys(collection: AnyNode, record: AnyNode, depth: number): KeyKind {
      const value = expression(collection, true);
      if (!value || depth > 6) return "unknown";
      if (value.type === "Identifier") {
        const binding = evidence.binding(value);
        if (binding?.kind === "const" && !binding.written && binding.init)
          return iteratedKeys(binding.init, record, depth + 1);
      }
      if (value.type === "CallExpression") {
        const callee = expression(value.callee);
        if (
          callee?.type === "MemberExpression" &&
          !callee.computed &&
          KEY_LIST_METHODS.has(callee.property?.name)
        )
          return iteratedKeys(callee.object, record, depth + 1);
        if (
          callee?.type === "MemberExpression" &&
          !callee.computed &&
          callee.object?.type === "Identifier" &&
          callee.object.name === "Object" &&
          OWN_KEY_SOURCES.has(callee.property?.name)
        ) {
          const source = value.arguments?.[0];
          if (record && sameRecord(source, record)) return "safe";
          return literalKeys(source) ? "safe" : "broad";
        }
      }
      return literalList(value, depth) ? "safe" : "unknown";
    }

    // The first key a for-of head or iteration callback binds: `key` or `[key]`.
    function firstKey(pattern: AnyNode, name: string): boolean {
      if (pattern?.type === "Identifier") return pattern.name === name;
      if (pattern?.type === "ArrayPattern")
        return pattern.elements[0]?.type === "Identifier" && pattern.elements[0].name === name;
      return false;
    }

    // The collection that `list.map(fn)` or a similar method iterates with `fn`.
    function iteratedBy(fn: AnyNode): AnyNode {
      let value = fn;
      let call = evidence.parent(value);
      while (call && expression(call) === value && call !== value) {
        value = call;
        call = evidence.parent(call);
      }
      const callee = call?.type === "CallExpression" ? expression(call.callee) : undefined;
      if (
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        ITERATION_METHODS.has(callee.property?.name) &&
        call.arguments?.[0] === value
      )
        return callee.object;
    }

    // `[{ name: "a" }, { name: "b" }]` or `[["a", 1], ["b", 2]]`: every element spells `field` as a
    // literal.
    function literalField(list: AnyNode, field: string | number, depth = 0): boolean {
      const value = expression(list, true);
      if (value?.type === "Identifier" && depth < 3) {
        const binding = evidence.binding(value);
        return (
          binding?.kind === "const" &&
          !binding.written &&
          literalField(binding.init, field, depth + 1)
        );
      }
      return (
        value?.type === "ArrayExpression" &&
        value.elements.length > 0 &&
        value.elements.every((element: AnyNode) => {
          const item =
            typeof field === "number"
              ? element?.type === "ArrayExpression"
                ? element.elements[field]
                : undefined
              : element?.type === "ObjectExpression"
                ? element.properties.find(
                    (property: AnyNode) =>
                      property.type === "Property" &&
                      !property.computed &&
                      (property.key?.name ?? property.key?.value) === field,
                  )?.value
                : undefined;
          return (
            item?.type === "Literal" &&
            typeof item.value === "string" &&
            !PROTOTYPE_NAMES.includes(item.value)
          );
        })
      );
    }

    function boundKey(binding: AnyNode, record: AnyNode, depth: number): KeyKind {
      const declarator = evidence.parent(binding.node);
      const pattern = declarator?.type === "ArrayPattern" ? declarator : binding.node;
      const holder = evidence.parent(pattern);
      if (holder?.type === "VariableDeclarator") {
        const declaration = evidence.parent(holder);
        const loop = evidence.parent(declaration);
        if (loop?.left !== declaration) return "unknown";
        if (loop.type === "ForOfStatement" && tupleKey(loop.right, pattern, binding.node))
          return "safe";
        if (firstKey(pattern, binding.node.name)) {
          if (loop.type === "ForInStatement")
            return record && sameRecord(loop.right, record) ? "safe" : "broad";
          if (loop.type === "ForOfStatement") return iteratedKeys(loop.right, record, depth);
        }
        return "unknown";
      }
      if (binding.kind !== "parameter") return "unknown";
      const fn = binding.owner;
      const collection = iteratedBy(fn);
      if (!collection) return "unknown";
      const objectPattern =
        declarator?.type === "Property" ? evidence.parent(declarator) : undefined;
      if (objectPattern?.type === "ObjectPattern" && fn.params?.[0] === objectPattern) {
        const field = declarator.key?.name ?? declarator.key?.value;
        return !declarator.computed && literalField(collection, field) ? "safe" : "unknown";
      }
      if (
        declarator?.type === "ArrayPattern" &&
        fn.params?.[0] === declarator &&
        tupleKey(collection, declarator, binding.node)
      )
        return "safe";
      if (!firstKey(fn.params?.[0], binding.node.name)) return "unknown";
      return iteratedKeys(collection, record, depth);
    }

    function tupleKey(list: AnyNode, pattern: AnyNode, name: AnyNode): boolean {
      if (pattern?.type !== "ArrayPattern") return false;
      const index = pattern.elements.indexOf(name);
      return index >= 0 && literalField(list, index);
    }

    function keyKind(node: AnyNode, record: AnyNode, depth = 0): KeyKind {
      const value = expression(node);
      if (!value || depth > 6) return "unknown";
      if (value.type === "TSAsExpression" || value.type === "TSTypeAssertion")
        return keyKind(value.expression, record, depth + 1);
      if (value.type === "Literal" || value.type === "PrivateIdentifier") return "safe";
      if (value.type === "TemplateLiteral") return templateCanBeInherited(value) ? "broad" : "safe";
      if (symbolCall(value)) return "safe";
      if (numeric(value)) return "safe";
      if (regexGroupKey(value)) return "safe";
      const picked = pickedKey(value, record, depth);
      if (picked) return picked;
      if (value.type !== "Identifier") return "unknown";
      const binding = evidence.binding(value);
      if (!binding || binding.kind === "ambiguous") return "unknown";
      // Imports and declarations are named constants, such as an env variable name or a symbol.
      if (binding.kind === "other") return "safe";
      const annotation = binding.annotation;
      if (annotation) return annotatedKey(annotation);
      if (
        (binding.kind === "const" || (binding.kind === "let" && !binding.written)) &&
        binding.init &&
        binding.node.start < value.start
      )
        return keyKind(binding.init, record, depth + 1);
      return boundKey(binding, record, depth);
    }

    // `keys[0]`, `keys.at(-1)` or `keys.find(...)`: one element of a key list.
    function pickedKey(node: AnyNode, record: AnyNode, depth: number): KeyKind | undefined {
      let list: AnyNode;
      let callback: AnyNode;
      let method: string | undefined;
      if (node.type === "MemberExpression" && node.computed && numeric(node.property)) {
        list = node.object;
      } else if (node.type === "CallExpression") {
        const callee = expression(node.callee);
        if (callee?.type !== "MemberExpression" || callee.computed) return;
        method = callee.property?.name;
        if (!method || !PICK_METHODS.has(method)) return;
        list = callee.object;
        callback = expression(node.arguments?.[0]);
      } else return;
      const kind = iteratedKeys(list, record, depth + 1);
      if (kind === "safe") return "safe";
      if (
        callback &&
        evidence.isArray(list) &&
        (method === "find" || method === "findLast") &&
        callbackGuards(callback, record, node)
      )
        return "safe";
      return kind;
    }

    // `candidates.find((candidate) => Object.hasOwn(record, candidate))`
    function callbackGuards(callback: AnyNode, record: AnyNode, pick: AnyNode): boolean {
      if (!["ArrowFunctionExpression", "FunctionExpression"].includes(callback?.type)) return false;
      const parameter = callback.params?.[0];
      if (parameter?.type !== "Identifier") return false;
      const body = callback.body;
      const result =
        body.type === "BlockStatement" &&
        body.body.length === 1 &&
        body.body[0].type === "ReturnStatement"
          ? body.body[0].argument
          : body;
      const guard = ownGuard(expression(result));
      return (
        !!guard &&
        evidence.owner(record) === evidence.owner(pick) &&
        sameStableValue(guard.record, record) &&
        sameStableValue(guard.key, parameter)
      );
    }

    function regexLiteral(node: AnyNode, depth = 0): AnyNode {
      const value = expression(node, true);
      if (value?.type === "Literal" && value.regex) return value.regex;
      if (value?.type !== "Identifier" || depth > 2) return;
      const binding = evidence.binding(value);
      if (binding?.kind === "const" && !binding.written)
        return regexLiteral(binding.init, depth + 1);
    }

    // The regex a match array comes from: `re.exec(text)` or `text.match(re)`.
    function matchedRegex(node: AnyNode): AnyNode {
      const value = expression(node, true);
      if (value?.type !== "CallExpression") return;
      const callee = expression(value.callee);
      if (callee?.type !== "MemberExpression" || callee.computed) return;
      if (callee.property?.name === "exec") return regexLiteral(callee.object);
      if (callee.property?.name === "match") return regexLiteral(value.arguments?.[0]);
    }

    // A capture group that can only match listed words, such as `(s|m|h)`.
    function groupWords(regex: AnyNode, group: number): string[] | undefined {
      const pattern: string = regex.pattern ?? "";
      let count = 0;
      let inClass = false;
      for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index];
        if (char === "\\") {
          index++;
          continue;
        }
        if (inClass) {
          if (char === "]") inClass = false;
          continue;
        }
        if (char === "[") inClass = true;
        if (char !== "(") continue;
        const named =
          pattern.startsWith("?<", index + 1) && !/^\?<[=!]/.test(pattern.slice(index + 1));
        if (pattern[index + 1] === "?" && !named) continue;
        if (++count !== group) continue;
        const end = pattern.indexOf(")", index);
        let body = pattern.slice(index + 1, end);
        if (named) body = body.slice(body.indexOf(">") + 1);
        if (!/^[\w$-]+(?:\|[\w$-]+)*$/.test(body)) return;
        return body.split("|");
      }
    }

    function safeWords(regex: AnyNode, group: number): boolean {
      const words = groupWords(regex, group);
      return !!words?.every((word) => !PROTOTYPE_KEYS.includes(word.toLowerCase()));
    }

    // A key captured by a regex group that only matches listed words cannot name an inherited key.
    function regexGroupKey(node: AnyNode): boolean {
      let value = expression(node, true);
      while (
        value?.type === "CallExpression" &&
        !value.arguments?.length &&
        value.callee?.type === "MemberExpression" &&
        !value.callee.computed &&
        STRING_KEY_METHODS.has(value.callee.property?.name)
      )
        value = expression(value.callee.object, true);
      if (
        value?.type === "LogicalExpression" &&
        value.operator === "??" &&
        keyKind(value.right, undefined, 5) === "safe"
      )
        value = expression(value.left, true);
      if (
        value?.type === "MemberExpression" &&
        value.computed &&
        value.property?.type === "Literal" &&
        typeof value.property.value === "number"
      ) {
        const array = expression(value.object, true);
        const binding = array?.type === "Identifier" ? evidence.binding(array) : undefined;
        if (binding?.kind !== "const" || binding.written) return false;
        const regex = matchedRegex(binding.init);
        return !!regex && safeWords(regex, value.property.value);
      }
      if (value?.type !== "Identifier") return false;
      const binding = evidence.binding(value);
      if (!binding || binding.written) return false;
      const pattern = evidence.parent(binding.node);
      if (pattern?.type === "ArrayPattern") {
        const declarator = evidence.parent(pattern);
        if (declarator?.type !== "VariableDeclarator" || declarator.id !== pattern) return false;
        const regex = matchedRegex(declarator.init);
        return !!regex && safeWords(regex, pattern.elements.indexOf(binding.node));
      }
      if (binding.kind !== "parameter") return false;
      // `text.replace(/(a|b)/g, (match, group) => ...)` passes the groups after the match.
      const fn = binding.owner;
      const index = fn.params?.indexOf(binding.node) ?? -1;
      const call = evidence.parent(fn);
      const callee = call?.type === "CallExpression" ? expression(call.callee) : undefined;
      if (
        index < 1 ||
        call?.type !== "CallExpression" ||
        call.arguments?.[1] !== fn ||
        callee?.type !== "MemberExpression" ||
        !["replace", "replaceAll"].includes(callee.property?.name)
      )
        return false;
      const regex = regexLiteral(call.arguments[0]);
      return !!regex && safeWords(regex, index);
    }

    function calleeText(node: AnyNode): string {
      const value = expression(node);
      if (value?.type === "Identifier") return value.name;
      if (value?.type === "MemberExpression" && !value.computed)
        return `${calleeText(value.object)}.${value.property?.name}`;
      return "";
    }

    // `${name}.webhook` can never spell toString or constructor; `${name}` can.
    function templateCanBeInherited(node: AnyNode): boolean {
      const parts: string[] = node.quasis.map((quasi: AnyNode) =>
        (quasi.value?.cooked ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      );
      const pattern = new RegExp(`^${parts.join(".*")}$`);
      return PROTOTYPE_NAMES.some((name) => pattern.test(name));
    }

    function symbolCall(node: AnyNode): boolean {
      if (node?.type !== "CallExpression") return false;
      const callee = expression(node.callee);
      const symbol = callee?.type === "MemberExpression" ? callee.object : callee;
      return symbol?.type === "Identifier" && symbol.name === "Symbol" && !evidence.binding(symbol);
    }

    function safeCheck(current: AnyNode): AnyNode {
      const parent = evidence.parent(current);
      if (arrayGuard(parent) && parent.arguments[0] === current) return parent;
      if (parent?.type === "UnaryExpression" && parent.operator === "typeof") {
        const comparison = evidence.parent(parent);
        const other = comparison?.left === parent ? comparison?.right : comparison?.left;
        if (
          comparison?.type === "BinaryExpression" &&
          ["===", "=="].includes(comparison.operator) &&
          other?.type === "Literal" &&
          SAFE_TYPEOF.has(other.value)
        )
          return comparison;
      }
      const comparison = parent?.type === "CallExpression" ? evidence.parent(parent) : parent;
      if (comparison?.type !== "BinaryExpression" || comparison.operator !== "===") return;
      const other =
        comparison.left === parent || comparison.left === current
          ? comparison.right
          : comparison.left;
      if (
        parent?.type === "CallExpression" &&
        parent.arguments[0] === current &&
        globalPath(parent.callee, "Object.prototype.toString.call") &&
        other?.type === "Literal" &&
        [
          "[object String]",
          "[object Number]",
          "[object Boolean]",
          "[object Array]",
          "[object Symbol]",
          "[object BigInt]",
        ].includes(other.value)
      )
        return comparison;
      if (
        parent?.type === "CallExpression" &&
        stringConversion(parent) &&
        sameStableValue(other, current)
      )
        return comparison;
      if (stringConversion(other) && sameStableValue(other.arguments[0], current))
        return comparison;
    }

    function stringConversion(node: AnyNode): boolean {
      return (
        node?.type === "CallExpression" &&
        node.arguments?.length === 1 &&
        globalPath(node.callee, "String")
      );
    }

    function arrayGuard(node: AnyNode): boolean {
      return node?.type === "CallExpression" && globalPath(node.callee, "Array.isArray");
    }

    function safeReferences(declaration: AnyNode): boolean {
      const references = evidence.references(declaration);
      if (!references.length || references.some((reference) => evidence.written(reference)))
        return false;
      const checks = new Set(references.map(safeCheck).filter(Boolean));
      return references.every(
        (reference) =>
          safeCheck(reference) ||
          onPath(reference, (test, truth) => truth && checks.has(test), true),
      );
    }

    function helperAcceptsSafely(call: AnyNode, argument: AnyNode): boolean {
      if (call?.type !== "CallExpression" || call.callee?.type !== "Identifier") return false;
      const binding = stableBinding(call.callee);
      if (!binding) return false;
      const declaration = evidence.parent(binding.node);
      const fn =
        binding.kind === "other" && declaration?.type === "FunctionDeclaration"
          ? declaration
          : binding.kind === "const"
            ? expression(binding.init)
            : undefined;
      if (
        !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(fn?.type)
      )
        return false;
      const parameter = fn.params?.[call.arguments.indexOf(argument)];
      return parameter?.type === "Identifier" && safeReferences(parameter);
    }

    function lookupRead(node: AnyNode): boolean {
      let current = node;
      let parent = evidence.parent(current);
      while (
        parent &&
        [
          "ChainExpression",
          "ParenthesizedExpression",
          "TSNonNullExpression",
          "TSAsExpression",
          "TSTypeAssertion",
          "TSSatisfiesExpression",
        ].includes(parent.type)
      ) {
        current = parent;
        parent = evidence.parent(current);
      }
      if (safeCheck(current) || helperAcceptsSafely(parent, current)) return false;
      if (
        parent?.type === "MemberExpression" &&
        parent.object === current &&
        parent.optional &&
        !parent.computed &&
        !FUNCTION_MEMBERS.has(parent.property?.name) &&
        evidence.parent(parent)?.callee !== parent
      )
        return false;
      let holder = current;
      let declarator = parent;
      while (declarator?.type === "ConditionalExpression" && declarator.test !== holder) {
        holder = declarator;
        declarator = evidence.parent(holder);
      }
      if (
        declarator?.type === "VariableDeclarator" &&
        declarator.init === holder &&
        declarator.id?.type === "Identifier" &&
        safeReferences(declarator.id)
      )
        return false;
      if (
        parent?.type === "AssignmentExpression" &&
        parent.left === current &&
        parent.operator === "="
      )
        return false;
      if (parent?.type === "SpreadElement" && evidence.parent(parent)?.type === "ObjectExpression")
        return false;
      if (parent?.type === "BinaryExpression" && ["===", "!=="].includes(parent.operator)) {
        const other = expression(parent.left === current ? parent.right : parent.left, true);
        if (other?.type === "Literal" && other.value !== null && !other.regex) return false;
      }
      if (parent?.type === "UnaryExpression" && parent.operator === "delete") return false;
      if (["ForInStatement", "ForOfStatement"].includes(parent?.type) && parent.left === current)
        return false;
      return true;
    }

    function stableBinding(node: AnyNode) {
      const value = expression(node, true);
      if (value?.type !== "Identifier") return;
      const binding = evidence.binding(value);
      if (!binding || binding.written || binding.kind === "ambiguous") return;
      if (
        binding.kind !== "const" &&
        evidence.references(binding.node).some((reference) => evidence.written(reference))
      )
        return;
      return binding;
    }

    function sameStableValue(left: AnyNode, right: AnyNode): boolean {
      left = expression(left, true);
      right = expression(right, true);
      if (!left || !right || left.type !== right.type) return false;
      if (left.type === "Identifier") {
        const binding = stableBinding(left);
        return !!binding && binding === stableBinding(right);
      }
      if (left.type === "Literal") return left.value === right.value;
      return (
        left.type === "MemberExpression" &&
        !left.computed &&
        !right.computed &&
        left.object?.type === "Identifier" &&
        left.property?.name === right.property?.name &&
        !evidence.propertyWritten(left.object.name, left.property?.name) &&
        sameStableValue(left.object, right.object)
      );
    }

    function globalPath(node: AnyNode, path: string): boolean {
      if (calleeText(node) !== path) return false;
      let root = expression(node);
      while (root?.type === "MemberExpression") root = expression(root.object);
      return root?.type === "Identifier" && !evidence.binding(root);
    }

    function ownGuard(node: AnyNode): { record: AnyNode; key: AnyNode } | undefined {
      if (node?.type !== "CallExpression" || node.optional) return;
      if (
        globalPath(node.callee, "Object.hasOwn") ||
        globalPath(node.callee, "Object.prototype.hasOwnProperty.call")
      ) {
        const [record, key] = node.arguments ?? [];
        if (record && key) return { record, key };
      }
    }

    function safeAllowlist(node: AnyNode, method: string, use: AnyNode): boolean {
      let value = expression(node, true);
      if (value?.type === "Identifier") {
        const binding = stableBinding(value);
        if (binding?.kind !== "const") return false;
        if (
          evidence
            .references(binding.node)
            .some((reference) => reference !== value && !allowlistMember(reference, method))
        )
          return false;
        if (binding.node.start >= use.start) return false;
        value = expression(binding.init, true);
      }
      if (method === "has") {
        if (value?.type !== "NewExpression" || !globalPath(value.callee, "Set")) return false;
        value = expression(value.arguments[0], true);
      }
      return (
        value?.type === "ArrayExpression" &&
        value.elements.every(
          (item: AnyNode) =>
            item?.type === "Literal" &&
            (typeof item.value === "number" ||
              (typeof item.value === "string" && !PROTOTYPE_NAMES.includes(item.value))),
        )
      );
    }

    function allowlistMember(reference: AnyNode, method: string): boolean {
      const member = evidence.parent(reference);
      const call = evidence.parent(member);
      return (
        member?.type === "MemberExpression" &&
        member.object === reference &&
        !member.computed &&
        member.property?.name === method &&
        call?.type === "CallExpression" &&
        call.callee === member
      );
    }

    function guardMatches(test: AnyNode, lookup: Lookup): boolean {
      const guard = ownGuard(test);
      if (guard)
        return (
          sameStableValue(guard.record, lookup.record) && sameStableValue(guard.key, lookup.key)
        );
      if (arrayGuard(test) && lookup.kind === "read") {
        const read = expression(test.arguments[0]);
        return (
          read?.type === "MemberExpression" &&
          read.computed &&
          sameStableValue(read.object, lookup.record) &&
          sameStableValue(read.property, lookup.key)
        );
      }
      const callee = expression(test?.callee);
      if (test?.type !== "CallExpression" || callee?.type !== "MemberExpression" || callee.computed)
        return false;
      const method = callee.property?.name;
      return (
        ["includes", "has"].includes(method) &&
        sameStableValue(test.arguments[0], lookup.key) &&
        safeAllowlist(callee.object, method, test)
      );
    }

    function implies(
      node: AnyNode,
      truth: boolean,
      match: (test: AnyNode, truth: boolean) => boolean,
      stableSubject = false,
    ): boolean {
      const test = expression(node, true);
      if (test?.type === "UnaryExpression" && test.operator === "!")
        return implies(test.argument, !truth, match, stableSubject);
      if (
        test?.type === "LogicalExpression" &&
        (truth ? test.operator === "&&" : test.operator === "||")
      )
        return (
          implies(test.right, truth, match, stableSubject) ||
          ((stableSubject || canCarryGuard(test.right)) &&
            implies(test.left, truth, match, stableSubject))
        );
      return !!test && match(test, truth);
    }

    function canCarryGuard(node: AnyNode): boolean {
      const value = expression(node, true);
      if (["Literal", "Identifier"].includes(value?.type)) return true;
      if (value?.type === "UnaryExpression" && ["!", "typeof"].includes(value.operator))
        return canCarryGuard(value.argument);
      return (
        ["BinaryExpression", "LogicalExpression"].includes(value?.type) &&
        ["===", "!==", "&&", "||"].includes(value.operator) &&
        canCarryGuard(value.left) &&
        canCarryGuard(value.right)
      );
    }

    function exits(node: AnyNode): boolean {
      if (node?.type === "BlockStatement" && node.body.length === 1) return exits(node.body[0]);
      return ["ReturnStatement", "ThrowStatement", "ContinueStatement", "BreakStatement"].includes(
        node?.type,
      );
    }

    function canCarryGuardPastDeclarator(declaration: AnyNode): boolean {
      return (
        declaration.id.type === "Identifier" &&
        (!declaration.init || expression(declaration.init, true)?.type === "Literal")
      );
    }

    function canCarryGuardPastStatement(statement: AnyNode): boolean {
      return (
        statement.type === "EmptyStatement" ||
        (statement.type === "VariableDeclaration" &&
          ["const", "let"].includes(statement.kind) &&
          statement.declarations.every(canCarryGuardPastDeclarator))
      );
    }

    function safePrefix(
      siblings: AnyNode[],
      child: AnyNode,
      safe: (node: AnyNode) => boolean = canCarryGuard,
    ): boolean {
      const index = siblings.indexOf(child);
      return index >= 0 && siblings.slice(0, index).every(safe);
    }

    function canCarryGuardInto(parent: AnyNode, child: AnyNode): boolean {
      switch (parent.type) {
        case "VariableDeclaration":
          return (
            parent.declarations[0] === child ||
            (["const", "let", "var"].includes(parent.kind) &&
              safePrefix(parent.declarations, child, canCarryGuardPastDeclarator))
          );
        case "VariableDeclarator":
          return parent.init === child;
        case "SequenceExpression":
          return safePrefix(parent.expressions, child);
        case "LogicalExpression":
        case "BinaryExpression":
          return parent.left === child || (parent.right === child && canCarryGuard(parent.left));
        case "AssignmentExpression":
          return (
            parent.left === child ||
            (parent.right === child && expression(parent.left, true)?.type === "Identifier")
          );
        case "IfStatement":
        case "ConditionalExpression":
          return parent.test === child || canCarryGuard(parent.test);
        case "MemberExpression":
          return parent.object === child || (parent.computed && canCarryGuard(parent.object));
        case "CallExpression":
        case "NewExpression":
          return (
            parent.callee === child ||
            (canCarryGuard(parent.callee) && safePrefix(parent.arguments, child))
          );
        case "ForStatement":
          return parent.init === child;
        case "ForInStatement":
        case "ForOfStatement":
          return parent.right === child;
        case "SwitchStatement":
          return parent.discriminant === child;
        case "TryStatement":
          return parent.block === child;
        case "LabeledStatement":
        case "ReturnStatement":
        case "ThrowStatement":
        case "ExpressionStatement":
        case "ChainExpression":
        case "ParenthesizedExpression":
        case "UnaryExpression":
        case "UpdateExpression":
        case "TSAsExpression":
        case "TSNonNullExpression":
        case "TSSatisfiesExpression":
        case "TSTypeAssertion":
          return true;
        default:
          return false;
      }
    }

    function onPath(
      node: AnyNode,
      match: (test: AnyNode, truth: boolean) => boolean,
      stableSubject = false,
    ): boolean {
      const owner = evidence.owner(node);
      for (let current = node; current && current !== owner;) {
        const parent = evidence.parent(current);
        if (!parent || parent === owner) break;
        if (["IfStatement", "ConditionalExpression"].includes(parent.type)) {
          if (parent.consequent === current && implies(parent.test, true, match, stableSubject))
            return true;
          if (parent.alternate === current && implies(parent.test, false, match, stableSubject))
            return true;
        }
        if (parent.type === "LogicalExpression" && parent.right === current) {
          if (
            ["&&", "||"].includes(parent.operator) &&
            implies(parent.left, parent.operator === "&&", match, stableSubject)
          )
            return true;
        }
        if (["BlockStatement", "Program"].includes(parent.type)) {
          const index = parent.body.indexOf(current);
          if (index < 0) return false;
          for (let offset = index - 1; offset >= 0; offset--) {
            const previous = parent.body[offset];
            if (canCarryGuardPastStatement(previous)) continue;
            if (
              previous.type === "IfStatement" &&
              !previous.alternate &&
              exits(previous.consequent) &&
              implies(previous.test, false, match, stableSubject)
            )
              return true;
            return false;
          }
        } else if (!stableSubject && !canCarryGuardInto(parent, current)) return false;
        current = parent;
      }
      return false;
    }

    function testsForInheritedKey(lookup: Lookup): boolean {
      if (lookup.kind !== "in") return false;
      const parent = evidence.parent(lookup.node);
      return (
        parent?.type === "LogicalExpression" &&
        parent.operator === "&&" &&
        parent.left === lookup.node &&
        implies(
          parent.right,
          true,
          (test, truth) => !truth && !!ownGuard(test) && guardMatches(test, lookup),
        )
      );
    }

    function consider(node: AnyNode, kind: "in" | "read", record: AnyNode, key: AnyNode) {
      if (!recordKind(record, kind)) return;
      const keyShape = keyKind(key, record);
      if (keyShape === "safe") return;
      lookups.push({
        node,
        kind,
        record,
        key,
        text: { record: describe(record) ?? "this record", key: describe(key) ?? "the key" },
      });
    }

    return {
      Program(node: AnyNode) {
        evidence = createLocalEvidence(node);
        types = new Map();
        for (const statement of node.body ?? []) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (
            ["TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(declaration?.type) &&
            declaration.id?.name
          )
            types.set(declaration.id.name, [
              ...(types.get(declaration.id.name) ?? []),
              declaration,
            ]);
        }
      },
      BinaryExpression(node: AnyNode) {
        if (node.operator !== "in") return;
        consider(node, "in", node.right, node.left);
      },
      MemberExpression(node: AnyNode) {
        if (!node.computed || !lookupRead(node)) return;
        consider(node, "read", node.object, node.property);
      },
      "Program:exit"() {
        const membership = new Map<AnyNode, Lookup>();
        const ordered = [...lookups].sort(
          (left, right) =>
            (left.kind === right.kind ? 0 : left.kind === "in" ? -1 : 1) ||
            left.node.start - right.node.start,
        );
        for (const lookup of ordered) {
          if (
            testsForInheritedKey(lookup) ||
            onPath(lookup.node, (test, truth) => truth && guardMatches(test, lookup))
          )
            continue;
          if (lookup.kind === "in") membership.set(lookup.node, lookup);
          else if (
            onPath(lookup.node, (test, truth) => {
              const earlier = truth ? membership.get(test) : undefined;
              return (
                !!earlier &&
                sameStableValue(earlier.record, lookup.record) &&
                sameStableValue(earlier.key, lookup.key)
              );
            })
          )
            continue;
          const { record, key } = lookup.text;
          report(
            ctx,
            lookup.node,
            ruleId,
            lookup.kind === "in"
              ? `\`${key} in ${record}\` is also true when ${key} is an inherited key such as "toString" or "constructor", because ${record} is a plain object that inherits Object.prototype.`
              : `${record}[${key}] returns an inherited Object.prototype member when ${key} is a key such as "toString" or "constructor", so the code treats a function as a configured entry.`,
            lookup.kind === "in"
              ? `Replace the in check with Object.hasOwn(${record}, ${key}), or keep the entries in a Map or an Object.create(null) record.`
              : `Read the entry only when Object.hasOwn(${record}, ${key}) is true, or keep the entries in a Map or an Object.create(null) record.`,
          );
        }
      },
    };
  },
});
