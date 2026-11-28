import { fileTextScope, type ScopeReference } from "../../../core/internal/script-scope.js";
import {
  type AnyNode,
  createRule,
  nearestFunctionOrProgram,
  report,
  walkScriptLocal,
} from "./shared.js";
import { isNitroRuntimeFile } from "./server-layout.js";

const RULE_ID = "nitro/cache/no-module-scope-response-cache";
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const LOOP_TYPES = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
const BLOCK_TYPES = new Set([
  "BlockStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "SwitchCase",
  "StaticBlock",
]);
const WRAPPERS = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);
const RELATIONAL = new Set(["<", "<=", ">", ">="]);
const CLOCK_CALLS = new Set(["Date.now", "performance.now"]);

interface CacheBinding {
  name: string;
  kind: "variable" | "map";
  declarator: AnyNode;
  reads: boolean;
  writes: boolean;
  expires: boolean;
}

export const noModuleScopeResponseCache = createRule({
  meta: {
    id: RULE_ID,
    title: "Cache upstream responses with defineCachedFunction",
    category: "cache",
    severity: "warn",
    confidence: "heuristic-high",
    fixable: "suggestion",
    docsUrl: "https://nitro.build/docs/cache",
    requires: { script: true, nitro: true },
  },
  create(ctx) {
    if (!/\b(?:Date|performance)\.now\b|\.getTime\b/.test(ctx.file.text)) return;
    if (!isNitroRuntimeFile(ctx)) return;
    return {
      Program(program: AnyNode) {
        const bindings = moduleBindings(program);
        if (!bindings.size) return;
        const helpers = cacheHelpers(program);
        let references: Map<number, ScopeReference> | undefined;
        const scopeReferences = () =>
          (references ??= new Map(
            Array.from(
              fileTextScope(ctx)?.references.values() ?? [],
              (reference) => [reference.identifier.range[0], reference] as const,
            ),
          ));
        walkScriptLocal(program, (node) => {
          if (node.type !== "Identifier") return;
          const binding = bindings.get(node.name);
          if (!binding || node === binding.declarator.id) return;
          const owner = nearestFunctionOrProgram(node);
          if (!owner || owner.type === "Program" || !resolvesToModuleBinding(node, node.name))
            return;
          const access = bindingAccess(node, binding, helpers);
          binding.reads ||= access.reads;
          // Filling the cache from async code is what makes it a response cache rather than,
          // say, a synchronous rate-limit window.
          binding.writes ||= access.writes && isAsyncCode(owner);
          binding.expires ||=
            access.expires ||
            comparesWithClock(owner, (item) => cachedEntryOf(item, [node])) ||
            (access.reads && ageControlsReuse(owner, node, binding, scopeReferences));
        });
        for (const binding of bindings.values()) {
          if (!binding.reads || !binding.writes || !binding.expires) continue;
          report(
            ctx,
            binding.declarator.id,
            RULE_ID,
            "warn",
            "cache",
            `${binding.name} is a hand-rolled TTL cache at module scope. It lives in one server instance or isolate, grows with every new key, cannot be invalidated through Nitro's cache storage, and hands the stored value to every later caller with the same key, including values that a request-scoped (user-authorized) client fetched.`,
            "Wrap the upstream call in defineCachedFunction() with a maxAge and a getKey that covers every input that changes the response, including the user or tenant when the upstream client is authorized per request. If the cached value cannot be serialized to cache storage, such as compiled validators, keep it in memory and suppress this diagnostic with the reason.",
          );
        }
      },
    };
  },
});

function moduleBindings(program: AnyNode) {
  const bindings = new Map<string, CacheBinding>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      const kind = isNew(declarator.init, "Map")
        ? "map"
        : declaration.kind === "const"
          ? null
          : "variable";
      if (!kind) continue;
      bindings.set(declarator.id.name, {
        name: declarator.id.name,
        kind,
        declarator,
        reads: false,
        writes: false,
        expires: false,
      });
    }
  }
  return bindings;
}

interface CacheHelper {
  reads: Set<number>;
  writes: Set<number>;
  expires: Set<number>;
}

// Caches often go through small read/write helpers that take the Map as a parameter.
function cacheHelpers(program: AnyNode) {
  const helpers = new Map<string, CacheHelper>();
  for (const statement of program.body ?? []) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    const fn =
      declaration?.type === "FunctionDeclaration"
        ? declaration
        : declaration?.type === "VariableDeclaration" &&
            declaration.declarations.length === 1 &&
            FUNCTION_TYPES.has(unwrap(declaration.declarations[0].init)?.type)
          ? unwrap(declaration.declarations[0].init)
          : null;
    const name =
      declaration?.type === "FunctionDeclaration"
        ? declaration.id?.name
        : declaration?.declarations?.[0]?.id?.name;
    if (!fn || !name) continue;
    const helper: CacheHelper = { reads: new Set(), writes: new Set(), expires: new Set() };
    fn.params.forEach((param: AnyNode, index: number) => {
      if (param.type !== "Identifier") return;
      const references: AnyNode[] = [];
      walkScriptLocal(fn.body, (node) => {
        if (
          node.type === "Identifier" &&
          node.name === param.name &&
          isValueReference(node) &&
          resolvesToBinding(node, param.name, fn)
        )
          references.push(node);
      });
      for (const reference of references) {
        const method = mapMethod(reference);
        if (method === "get" || method === "has") helper.reads.add(index);
        if (method === "set") helper.writes.add(index);
      }
      if (references.length && comparesWithClock(fn, (node) => cachedEntryOf(node, references)))
        helper.expires.add(index);
    });
    if (helper.reads.size || helper.writes.size) helpers.set(name, helper);
  }
  return helpers;
}

function bindingAccess(node: AnyNode, binding: CacheBinding, helpers: Map<string, CacheHelper>) {
  const access = { reads: false, writes: false, expires: false };
  const parent = node.__doctorParent;
  if (binding.kind === "variable") {
    if (parent?.type === "AssignmentExpression" && parent.left === node) access.writes = true;
    else access.reads = isValueReference(node);
    return access;
  }
  const method = mapMethod(node);
  if (method === "get" || method === "has") access.reads = true;
  if (method === "set") access.writes = true;
  if (parent?.type === "CallExpression" && parent.callee?.type === "Identifier") {
    const helper = helpers.get(parent.callee.name);
    const index = parent.arguments.indexOf(node);
    if (helper && index >= 0) {
      access.reads = helper.reads.has(index);
      access.writes = helper.writes.has(index);
      access.expires = helper.expires.has(index);
    }
  }
  return access;
}

// The function, or a function it is nested in, is async or a promise continuation.
function isAsyncCode(fn: AnyNode) {
  for (let current = fn; current; current = current.__doctorParent) {
    if (!FUNCTION_TYPES.has(current.type)) continue;
    if (current.async) return true;
    const call = current.__doctorParent;
    const callee = call?.type === "CallExpression" ? unwrap(call.callee) : null;
    if (
      callee?.type === "MemberExpression" &&
      call.arguments.includes(current) &&
      ["then", "catch", "finally"].includes(callee.property?.name)
    )
      return true;
  }
  return false;
}

function mapMethod(node: AnyNode) {
  const member = node.__doctorParent;
  if (member?.type !== "MemberExpression" || member.object !== node || member.computed) return null;
  const call = member.__doctorParent;
  if (call?.type !== "CallExpression" || call.callee !== member) return null;
  return member.property?.name ?? null;
}

// The entry read from the cache, such as `cached` in `const cached = cache.get(key)`.
function cachedEntryOf(node: AnyNode, references: AnyNode[]) {
  if (references.includes(node)) return true;
  if (node.type !== "Identifier") return false;
  return references.some((reference) => {
    const call = reference.__doctorParent?.__doctorParent;
    const declarator = call?.__doctorParent;
    return (
      declarator?.type === "VariableDeclarator" &&
      unwrap(declarator.init) === call &&
      declarator.id?.type === "Identifier" &&
      declarator.id.name === node.name &&
      resolvesToBinding(node, node.name, nearestFunctionOrProgram(declarator), declarator)
    );
  });
}

// A relational comparison between a clock reading and a value derived from the cache, such as
// `cached.expiresAt > Date.now()`, in the function that owns the cache access.
function comparesWithClock(fn: AnyNode, isCacheValue: (node: AnyNode) => boolean) {
  return clockComparisons(fn).expirySides.some((side) =>
    mentions(side, (node) => isCacheValue(node) && readsEntryField(node)),
  );
}

// `entry.expiresAt`, not `lastCall` or `hits.get(ip)`: the expiry is a field of the cached entry.
function readsEntryField(node: AnyNode) {
  let current = node;
  while (current.__doctorParent && WRAPPERS.has(current.__doctorParent.type))
    current = current.__doctorParent;
  const member = current.__doctorParent;
  if (member?.type !== "MemberExpression" || member.object !== current) return false;
  if (member.property?.name === "get" && member.__doctorParent?.callee === member)
    return readsEntryField(member.__doctorParent);
  return !["get", "has", "size"].includes(member.property?.name);
}

interface ClockComparisons {
  expirySides: AnyNode[];
  ages: { comparison: AnyNode; timestamp: AnyNode; freshWhenTrue: boolean }[];
}

const comparisonsByFunction = new WeakMap<object, ClockComparisons>();

function clockComparisons(fn: AnyNode): ClockComparisons {
  const cached = comparisonsByFunction.get(fn);
  if (cached) return cached;
  const found: ClockComparisons = { expirySides: [], ages: [] };
  const clocks = clockLocals(fn);
  walkFunctionBody(fn.body, (node) => {
    if (node.type !== "BinaryExpression" || !RELATIONAL.has(node.operator)) return;
    const leftClock = readsClock(node.left, clocks);
    if (!leftClock && !readsClock(node.right, clocks)) return;
    const clockSide = unwrap(leftClock ? node.left : node.right);
    found.expirySides.push(leftClock ? node.right : node.left);
    if (
      clockSide?.type === "BinaryExpression" &&
      clockSide.operator === "-" &&
      readsClock(clockSide.left, clocks) &&
      !readsClock(clockSide.right, clocks)
    ) {
      found.ages.push({
        comparison: node,
        timestamp: unwrap(clockSide.right),
        freshWhenTrue: (leftClock ? ["<", "<="] : [">", ">="]).includes(node.operator),
      });
    }
  });
  comparisonsByFunction.set(fn, found);
  return found;
}

type ScopeReferences = () => Map<number, ScopeReference>;

function ageControlsReuse(
  fn: AnyNode,
  reference: AnyNode,
  binding: CacheBinding,
  scopeReferences: ScopeReferences,
) {
  if (binding.kind === "map" && mapMethod(reference) !== "get") return false;
  return clockComparisons(fn).ages.some(({ comparison, timestamp, freshWhenTrue }) => {
    const timestampField = fieldName(timestamp);
    const entry = unwrap(timestamp?.object);
    if (!timestampField || !entry || !cachedEntryOf(entry, [reference])) return false;
    const paths = freshnessPaths(comparison, freshWhenTrue);
    if (!paths) return false;
    const payload = unwrap(straightLineReturn(paths.hit)?.argument);
    const field = fieldName(payload);
    const returnedEntry = unwrap(payload?.object);
    if (!field || field === timestampField || returnedEntry?.type !== "Identifier") return false;
    if (
      binding.kind === "map"
        ? !cachedEntryOf(returnedEntry, [reference])
        : returnedEntry.name !== binding.name ||
          !resolvesToModuleBinding(returnedEntry, binding.name)
    )
      return false;
    const key =
      binding.kind === "map" ? reference.__doctorParent.__doctorParent.arguments[0] : null;
    return refreshesPayload(
      fn,
      paths.refresh,
      binding,
      key,
      field,
      scopeReferences,
      paths.mustReturn,
    );
  });
}

function fieldName(node: AnyNode): string | undefined {
  return node?.type === "MemberExpression" && !node.computed ? node.property?.name : undefined;
}

function freshnessPaths(comparison: AnyNode, freshWhenTrue: boolean) {
  let current = comparison;
  for (let parent = current.__doctorParent; parent; parent = current.__doctorParent) {
    if (parent.type === "IfStatement" && parent.test === current) {
      const branch = branchStatements(parent.consequent);
      const block = parent.__doctorParent;
      const other = parent.alternate
        ? branchStatements(parent.alternate)
        : block?.type === "BlockStatement"
          ? block.body.slice(block.body.indexOf(parent) + 1)
          : [];
      return {
        hit: freshWhenTrue ? branch : other,
        refresh: freshWhenTrue ? other : branch,
        mustReturn: !freshWhenTrue && !parent.alternate,
      };
    }
    if (parent.type === "UnaryExpression" && parent.operator === "!") {
      freshWhenTrue = !freshWhenTrue;
    } else if (
      !WRAPPERS.has(parent.type) &&
      !(parent.type === "LogicalExpression" && parent.operator === (freshWhenTrue ? "&&" : "||"))
    )
      break;
    current = parent;
  }
  return null;
}

function branchStatements(branch: AnyNode): AnyNode[] {
  return branch.type === "BlockStatement" ? branch.body : [branch];
}

function isStraightLine(statement: AnyNode) {
  return (
    statement.type === "VariableDeclaration" ||
    (statement.type === "ExpressionStatement" &&
      unwrap(statement.expression)?.type === "CallExpression")
  );
}

function straightLineReturn(statements: AnyNode[]) {
  for (const statement of statements) {
    if (statement.type === "ReturnStatement") return statement;
    if (!isStraightLine(statement)) break;
  }
  return null;
}

function refreshesPayload(
  fn: AnyNode,
  statements: AnyNode[],
  binding: CacheBinding,
  key: AnyNode,
  field: string,
  scopeReferences: ScopeReferences,
  mustReturn: boolean,
) {
  const locals: AnyNode[] = [];
  for (let index = 0; index < statements.length; index++) {
    const statement = statements[index];
    if (statement.type === "VariableDeclaration") {
      if (statement.kind === "const") locals.push(...statement.declarations);
      continue;
    }
    const write = statement.type === "ExpressionStatement" ? unwrap(statement.expression) : null;
    const target = binding.kind === "map" ? unwrap(write?.callee)?.object : write?.left;
    if (
      target?.type !== "Identifier" ||
      target.name !== binding.name ||
      !resolvesToModuleBinding(target, binding.name)
    ) {
      if (isStraightLine(statement)) continue;
      return false;
    }
    const entry =
      binding.kind === "map"
        ? mapMethod(target) === "set" &&
          sameKey(fn, key, write.arguments[0], scopeReferences) &&
          unwrap(write.arguments[1])
        : write.type === "AssignmentExpression" && write.operator === "=" && unwrap(write.right);
    if (entry?.type !== "ObjectExpression") return false;
    const property = entry.properties.findLast(
      (item: AnyNode) =>
        item.type === "SpreadElement" ||
        item.computed ||
        item.key?.name === field ||
        item.key?.value === field,
    );
    const stored =
      property?.type === "Property" && !property.computed ? unwrap(property.value) : null;
    const value =
      stored?.type === "Identifier"
        ? unwrap(
            locals.findLast(
              (local) =>
                local.id?.type === "Identifier" &&
                local.id.name === stored.name &&
                resolvesToBinding(stored, stored.name, fn, local),
            )?.init,
          )
        : stored;
    return (
      value?.type === "AwaitExpression" &&
      unwrap(value.argument)?.type === "CallExpression" &&
      (!mustReturn || straightLineReturn(statements.slice(index + 1)) !== null)
    );
  }
  return false;
}

function sameKey(fn: AnyNode, read: AnyNode, write: AnyNode, scopeReferences: ScopeReferences) {
  const first = unwrap(read);
  const second = unwrap(write);
  if (first?.type === "Identifier" && second?.type === "Identifier" && first.name === second.name) {
    const references = scopeReferences();
    const variable = references.get(first.start)?.resolved;
    if (!variable || variable !== references.get(second.start)?.resolved) return false;
    if (variable.defs.some((definition) => definition.type === "ImportBinding")) return false;
    const writes = variable.references.filter((reference) => reference.isWrite());
    if (!writes.length) return true;
    if (hasLoopKeyWrite(fn, read, writes) || hasLoopKeyWrite(fn, write, writes)) return false;
    const [definition] = variable.defs;
    if (
      variable.defs.length === 1 &&
      definition?.type === "Variable" &&
      definition.parent.kind === "const" &&
      writes.every((reference) => reference.init)
    )
      return true;
    return (
      variable.scope.variableScope.block.range[0] === fn.start &&
      writesBeforeLookup(fn, read, write, writes)
    );
  }
  return first?.type === "Literal" && second?.type === "Literal" && first.value === second.value;
}

function hasLoopKeyWrite(fn: AnyNode, access: AnyNode, writes: ScopeReference[]) {
  for (
    let parent = access.__doctorParent;
    parent && parent !== fn;
    parent = parent.__doctorParent
  ) {
    if (
      LOOP_TYPES.has(parent.type) &&
      writes.some(
        ({ identifier }) =>
          parent.start <= identifier.range[0] && identifier.range[1] <= parent.end,
      )
    )
      return true;
  }
  return false;
}

function writesBeforeLookup(fn: AnyNode, read: AnyNode, write: AnyNode, writes: ScopeReference[]) {
  const declarator = read.__doctorParent?.__doctorParent;
  const declaration = declarator?.__doctorParent;
  const lookupBlock = declaration?.__doctorParent;
  if (
    declarator?.type !== "VariableDeclarator" ||
    declaration?.type !== "VariableDeclaration" ||
    lookupBlock?.type !== "BlockStatement" ||
    write.start < declaration.end ||
    write.end > lookupBlock.end
  )
    return false;

  const prefixes: [number, number][] = [[declaration.start, declarator.start]];
  for (
    let statement = declaration;
    statement && statement !== fn;
    statement = statement.__doctorParent
  ) {
    const block = statement.__doctorParent;
    if (block?.type === "BlockStatement") prefixes.push([block.start, statement.start]);
  }
  return writes.every(
    (reference) =>
      reference.from.variableScope.block.range[0] === fn.start &&
      prefixes.some(
        ([start, end]) =>
          start <= reference.identifier.range[0] && reference.identifier.range[1] <= end,
      ),
  );
}

function walkFunctionBody(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkFunctionBody(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  if (node !== node.__doctorParent && FUNCTION_TYPES.has(node.type)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkFunctionBody(child, visit);
    } else if (value && typeof value === "object") {
      walkFunctionBody(value, visit);
    }
  }
}

function clockLocals(fn: AnyNode) {
  const names = new Set<string>();
  walkFunctionBody(fn.body, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      nearestFunctionOrProgram(node) === fn &&
      readsClock(node.init, names)
    )
      names.add(node.id.name);
  });
  return names;
}

function readsClock(node: AnyNode, locals: Set<string>) {
  return mentions(node, (item) => {
    if (item.type === "Identifier" && locals.has(item.name) && isValueReference(item)) return true;
    if (item.type !== "CallExpression") return false;
    const callee = unwrap(item.callee);
    if (CLOCK_CALLS.has(memberName(callee))) return true;
    return memberName(callee) === "getTime" && isNew(callee.object, "Date");
  });
}

function mentions(node: AnyNode, predicate: (node: AnyNode) => boolean) {
  let found = false;
  walkScriptLocal(node, (item) => {
    if (!found && predicate(item)) found = true;
  });
  return found;
}

function resolvesToModuleBinding(node: AnyNode, name: string) {
  return resolvesToBinding(node, name, null);
}

// `node` refers to the `name` bound by `owner` (a function's parameter), or by the module when
// `owner` is null, rather than to a nearer declaration.
function resolvesToBinding(
  node: AnyNode,
  name: string,
  owner: AnyNode,
  expectedDeclarator?: AnyNode,
) {
  for (let current = node.__doctorParent; current; current = current.__doctorParent) {
    if (current === owner || current.type === "Program") return true;
    if (FUNCTION_TYPES.has(current.type)) {
      if (current.id?.name === name && current.type === "FunctionExpression") return false;
      if (current.params?.some((param: AnyNode) => bindsName(param, name))) return false;
      if (declaresVar(current.body, name)) return false;
    } else if (BLOCK_TYPES.has(current.type) || current.type === "CatchClause") {
      if (current.type === "CatchClause" && bindsName(current.param, name)) return false;
      const statements =
        current.type === "BlockStatement" || current.type === "StaticBlock"
          ? current.body
          : current.type === "SwitchCase"
            ? current.consequent
            : [current.init ?? current.left];
      if (
        statements.some(
          (statement: AnyNode) =>
            declaresLexical(statement, name) && !containsNode(statement, expectedDeclarator),
        )
      )
        return false;
    }
  }
  return false;
}

function containsNode(root: AnyNode, target?: AnyNode): boolean {
  if (!target) return false;
  if (root === target) return true;
  for (const [key, value] of Object.entries(root)) {
    if (key === "__doctorParent") continue;
    if (Array.isArray(value)) {
      if (value.some((child) => child && typeof child === "object" && containsNode(child, target)))
        return true;
    } else if (value && typeof value === "object" && containsNode(value, target)) {
      return true;
    }
  }
  return false;
}

function declaresLexical(statement: AnyNode, name: string): boolean {
  if (!statement) return false;
  if (statement.type === "VariableDeclaration")
    return statement.declarations.some((item: AnyNode) => bindsName(item.id, name));
  return (
    (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
    statement.id?.name === name
  );
}

function declaresVar(body: AnyNode, name: string) {
  let found = false;
  walkScriptLocal(body, (node) => {
    if (found || node.type !== "VariableDeclaration" || node.kind !== "var") return;
    if (nearestFunctionOrProgram(node) !== body.__doctorParent) return;
    found = node.declarations.some((item: AnyNode) => bindsName(item.id, name));
  });
  return found;
}

function bindsName(pattern: AnyNode, name: string): boolean {
  if (!pattern) return false;
  if (pattern.type === "Identifier") return pattern.name === name;
  if (pattern.type === "AssignmentPattern") return bindsName(pattern.left, name);
  if (pattern.type === "RestElement") return bindsName(pattern.argument, name);
  if (pattern.type === "ArrayPattern")
    return pattern.elements.some((item: AnyNode) => bindsName(item, name));
  if (pattern.type === "ObjectPattern")
    return pattern.properties.some((item: AnyNode) => bindsName(item.value ?? item.argument, name));
  if (pattern.type === "TSParameterProperty") return bindsName(pattern.parameter, name);
  return false;
}

function isValueReference(node: AnyNode) {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  if (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
    return false;
  return !(parent?.type === "VariableDeclarator" && parent.id === node);
}

function memberName(node: AnyNode): string {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression" && !node.computed)
    return node.object?.type === "Identifier"
      ? `${node.object.name}.${node.property?.name}`
      : (node.property?.name ?? "");
  return "";
}

function isNew(node: AnyNode, name: string) {
  const value = unwrap(node);
  return (
    value?.type === "NewExpression" &&
    value.callee?.type === "Identifier" &&
    value.callee.name === name
  );
}

function unwrap(node: AnyNode): AnyNode {
  while (node && WRAPPERS.has(node.type)) node = node.expression;
  return node;
}
