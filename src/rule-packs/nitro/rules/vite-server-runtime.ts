import { dirname, normalize, relative, resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import {
  analyzeScript,
  scopeDialect,
  type ScriptScope,
} from "../../../core/internal/script-scope.js";
import { parseScript, parseScriptResult } from "../../../core/internal/script.js";
import { owningWorkspacePackage } from "../../../core/internal/workspace-packages.js";
import {
  isPackageRuntimeSource,
  isTypeOnlyModuleReference,
  objectProperty,
  sourceFile,
  walk,
  type OwningPackage,
} from "./nitro-package.js";
import type { AnyNode } from "./shared.js";

const SCRIPT_GLOB = "**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx}";
const SOURCE_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/.output/**", "**/.nitro/**"];
const FS_MODULES = /^(?:node:)?fs(?:\/promises)?$/;
const HOOKS = ["config", "configResolved"];
const INTERPOLATION = "__doctor_unknown_interpolation__";

export function isViteServerRuntime(ctx: RuleContext, owner: OwningPackage): boolean {
  const key = `nitro:vite-server-runtime:${owner.dir}`;
  const cached = ctx.cache.get<Set<string>>(key);
  if (cached) return cached.has(ctx.file.path);

  const packages = projectWorkspacePackages(ctx.project);
  const isOwnedSource = (file: string) => {
    const path = relative(owner.dir, file);
    const root = owningWorkspacePackage(packages, relative(ctx.project.root, file));
    return (
      path !== ".." &&
      !path.startsWith("../") &&
      resolve(ctx.project.root, root) === owner.dir &&
      isPackageRuntimeSource({ ...owner, path })
    );
  };
  const runtime = new Set<string>();
  const pending: string[] = [];
  for (const file of ctx.fs.glob(SCRIPT_GLOB, { cwd: owner.dir, exclude: SOURCE_EXCLUDE })) {
    if (!isOwnedSource(file)) continue;
    const text = ctx.fs.readText(file);
    if (!text?.includes("handlers") || !text.includes(`${owner.manifest.name}/`)) continue;
    const scope = analyzeScript(text, scopeDialect(file));
    if (!scope) continue;
    for (const specifier of generatedHandlerImports(scope)) {
      const entry = selfExportSource(ctx, owner, specifier);
      if (entry) pending.push(entry);
    }
  }
  for (const file of pending) {
    if (runtime.has(file) || !isOwnedSource(file)) continue;
    runtime.add(file);
    const text = ctx.fs.readText(file);
    const ast = text && parseScript(file, text);
    if (!ast) continue;
    for (const node of ast.body as AnyNode[]) {
      const specifier = node.source?.value;
      if (typeof specifier !== "string" || isTypeOnlyModuleReference(node)) continue;
      const next = specifier.startsWith(".")
        ? sourceFile(ctx, resolve(dirname(file), specifier))
        : selfExportSource(ctx, owner, specifier);
      if (next) pending.push(next);
    }
  }
  ctx.cache.set(key, runtime);
  return runtime.has(ctx.file.path);
}

type HandlerPath = string | object;
type ValueState = "unknown" | "nullish" | "falsy" | "truthy";

function valueState(node: AnyNode): ValueState {
  switch (node?.type) {
    case "ObjectExpression":
    case "ArrayExpression":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return "truthy";
    case "Literal":
      return node.value === null ? "nullish" : node.value ? "truthy" : "falsy";
    case "UnaryExpression":
      if (node.operator === "void") return "nullish";
  }
  return "unknown";
}

function logicalAssignment(operator: string, current: ValueState): boolean | undefined {
  if (current === "unknown") return;
  switch (operator) {
    case "??=":
      return current === "nullish";
    case "||=":
      return current !== "truthy";
    case "&&=":
      return current === "truthy";
  }
}

function generatedHandlerImports({ ast, references }: ScriptScope): Set<string> {
  const imports = new Set<string>();
  if (
    !ast?.body.some(
      (node: AnyNode) => node.type === "ImportDeclaration" && node.source.value === "vite",
    )
  )
    return imports;
  const binding = (node: AnyNode) => {
    const variable = references.get(node)?.resolved;
    if (
      variable?.defs.length === 1 &&
      !variable.references.some((ref) => ref.isWrite() && !ref.init)
    )
      return variable.defs[0];
  };
  const constant = (node: AnyNode) => {
    const def = binding(node);
    if (
      def?.type === "Variable" &&
      def.parent.kind === "const" &&
      def.node.id.type === "Identifier"
    )
      return def.node;
  };
  const literal = (node: AnyNode): string | undefined => {
    if (typeof node?.value === "string") return node.value;
    if (node?.type === "TemplateLiteral")
      return node.quasis.map((part: AnyNode) => part.value.cooked).join(INTERPOLATION);
    const declaration = constant(node);
    if (declaration && declaration.range[0] < node.range[0]) return literal(declaration.init);
  };
  const writer = (callee: AnyNode): string | undefined => {
    const def = binding(callee?.type === "MemberExpression" ? callee.object : callee);
    if (
      def?.type !== "ImportBinding" ||
      def.parent.type !== "ImportDeclaration" ||
      def.parent.importKind === "type" ||
      !FS_MODULES.test(def.parent.source.value)
    )
      return;
    if (def.node.type === "ImportSpecifier" && callee.type === "Identifier")
      return def.node.importKind !== "type"
        ? def.node.imported.type === "Identifier"
          ? def.node.imported.name
          : def.node.imported.value
        : undefined;
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      (def.node.type === "ImportNamespaceSpecifier" || def.node.type === "ImportDefaultSpecifier")
    )
      return callee.property.name;
  };

  function trace(
    callback: AnyNode,
    writes: Map<HandlerPath, string | undefined>,
    values: Map<AnyNode, HandlerPath>,
    active: Set<AnyNode>,
    hook?: string,
  ): HandlerPath | undefined {
    if (!callback?.body || callback.generator || active.has(callback)) return;
    active.add(callback);

    const path = (node: AnyNode): HandlerPath | undefined => {
      const def = binding(node);
      if (def?.type === "Parameter") return values.get(def.name);
      const declaration = constant(node);
      if (declaration && values.has(declaration.id)) return values.get(declaration.id);
      const text = literal(node);
      if (text !== undefined && !text.includes(INTERPOLATION) && text.length)
        return normalize(text);
    };
    const registered = new Set<HandlerPath>();
    let nitroState: ValueState = "unknown";
    let handlersState: ValueState = "unknown";
    const register = (handlers: AnyNode[]) => {
      for (const handler of handlers) {
        const target = path(objectProperty(handler, "handler"));
        if (target !== undefined) registered.add(target);
      }
    };
    const registerArray = (node: AnyNode) => {
      if (node?.type === "ArrayExpression") register(node.elements);
    };
    const replaceHandlers = (node: AnyNode, state = valueState(node)) => {
      handlersState = state;
      registered.clear();
      registerArray(node);
    };
    const replaceNitroOptions = (node: AnyNode) => {
      nitroState = valueState(node);
      if (node?.type !== "ObjectExpression") {
        replaceHandlers(undefined);
        return;
      }
      const property = node.properties.findLast((entry: AnyNode) => {
        if (entry.type === "SpreadElement" || entry.computed) return true;
        const name = entry.key?.name ?? entry.key?.value;
        return name === "handlers" || name === "__proto__";
      });
      if (!property) replaceHandlers(undefined, "nullish");
      else if (
        property.type === "Property" &&
        !property.computed &&
        property.kind === "init" &&
        (property.key.name ?? property.key.value) === "handlers"
      )
        replaceHandlers(property.value);
      else replaceHandlers(undefined);
    };
    const config = (node: AnyNode) => {
      const def = binding(node);
      return hook && def?.type === "Parameter" && def.name === callback.params[0];
    };
    const nitro = (node: AnyNode) => isMember(node, "nitro") && config(node.object);
    const handlers = (node: AnyNode) => isMember(node, "handlers") && nitro(node.object);

    const evaluate = (node: AnyNode, awaited = false): HandlerPath | undefined => {
      if (node?.type === "AwaitExpression") return evaluate(node.argument, true);
      if (node?.type === "CallExpression") {
        const [target, content] = node.arguments;
        const method = writer(node.callee);
        if (method === "writeFileSync" || (method === "writeFile" && awaited)) {
          const dest = path(target);
          if (dest !== undefined) writes.set(dest, literal(content));
        } else if (
          (isMember(node.callee, "push") || isMember(node.callee, "unshift")) &&
          handlers(node.callee.object)
        ) {
          register(node.arguments);
        } else {
          const def = binding(node.callee);
          const helper = def?.type === "FunctionName" ? def.node : constant(node.callee)?.init;
          if (
            (helper?.type === "FunctionDeclaration" ||
              helper?.type === "FunctionExpression" ||
              helper?.type === "ArrowFunctionExpression") &&
            (!helper.async || awaited)
          ) {
            const args = new Map(values);
            for (const [index, parameter] of (helper.params as AnyNode[]).entries()) {
              const value = path(node.arguments[index]);
              if (parameter.type === "Identifier" && value !== undefined)
                args.set(parameter, value);
            }
            return trace(helper, writes, args, active);
          }
        }
      } else if (node?.type === "AssignmentExpression") {
        const replacesNitro = nitro(node.left);
        if (replacesNitro || handlers(node.left)) {
          const taken =
            node.operator === "="
              ? true
              : logicalAssignment(node.operator, replacesNitro ? nitroState : handlersState);
          if (taken === false) return;
          const replacement = taken === true ? node.right : undefined;
          if (replacesNitro) replaceNitroOptions(replacement);
          else replaceHandlers(replacement);
        }
      }
      return path(node);
    };
    const result = (node: AnyNode) => {
      if (hook === "config")
        registerArray(objectProperty(objectProperty(node, "nitro"), "handlers"));
      return evaluate(node);
    };
    const run = (body: AnyNode): HandlerPath | undefined => {
      if (body.type !== "BlockStatement") return result(body);
      for (const statement of body.body as AnyNode[]) {
        if (statement.type === "ReturnStatement") return result(statement.argument);
        if (statement.type === "ExpressionStatement") evaluate(statement.expression);
        if (statement.type !== "VariableDeclaration") continue;
        for (const declaration of statement.declarations as AnyNode[]) {
          const value = evaluate(declaration.init);
          if (statement.kind === "const" && declaration.id.type === "Identifier")
            values.set(declaration.id, value ?? {});
        }
      }
    };

    const value = run(callback.body);
    active.delete(callback);
    for (const target of registered) {
      const generated = writes.get(target);
      if (!generated) continue;
      const parsed = parseScriptResult("generated.ts", generated);
      const body = (parsed.ast?.body ?? []) as AnyNode[];
      if (parsed.errors.length || !body.some((node) => node.type === "ExportDefaultDeclaration"))
        continue;
      for (const node of body) {
        const specifier = node.source?.value;
        if (
          typeof specifier === "string" &&
          !specifier.includes(INTERPOLATION) &&
          !isTypeOnlyModuleReference(node)
        )
          imports.add(specifier);
      }
    }
    return value;
  }

  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    for (const hook of HOOKS) {
      const callback = objectProperty(node, hook);
      if (callback?.type === "FunctionExpression" || callback?.type === "ArrowFunctionExpression")
        trace(callback, new Map(), new Map(), new Set(), hook);
    }
  });
  return imports;
}

function isMember(node: AnyNode, name: string): boolean {
  return node?.type === "MemberExpression" && !node.computed && node.property?.name === name;
}

function esmExportTarget(target: unknown): string | null | undefined {
  if (typeof target === "string" || target === null) return target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  for (const [condition, branch] of Object.entries(target)) {
    if (condition === "types" || condition.startsWith("types@") || condition === "require")
      continue;
    if (condition !== "import" && condition !== "default") return null;
    const selected = esmExportTarget(branch);
    if (selected !== undefined) return selected;
  }
}

function selfExportSource(
  ctx: RuleContext,
  owner: OwningPackage,
  specifier: string,
): string | undefined {
  const prefix = `${owner.manifest.name}/`;
  if (!specifier.startsWith(prefix)) return;
  const exports = owner.manifest.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return;
  const target = esmExportTarget(
    (exports as Record<string, unknown>)[`./${specifier.slice(prefix.length)}`],
  );
  if (typeof target !== "string" || !target.startsWith("./")) return;
  const built = target.match(/^\.\/dist\/(.+)\.[cm]?js$/)?.[1];
  return sourceFile(ctx, resolve(owner.dir, built ? `src/${built}.js` : target));
}
