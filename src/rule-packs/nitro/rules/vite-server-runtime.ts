import { dirname, relative, resolve } from "pathe";
import type { RuleContext } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { parseScript } from "../../../core/internal/script.js";
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
    for (const specifier of generatedHandlerImports(parseScript(file, text))) {
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

function generatedHandlerImports(ast: AnyNode): Set<string> {
  const imports = new Set<string>();
  if (
    !ast?.body.some(
      (node: AnyNode) => node.type === "ImportDeclaration" && node.source.value === "vite",
    )
  )
    return imports;
  let registersHandler = false;
  walk(ast, (node) => {
    if (
      !registersHandler &&
      node.type === "ObjectExpression" &&
      ["config", "configResolved"].some((hook) => {
        const callback = objectProperty(node, hook);
        if (!callback?.body) return false;
        let registers = false;
        walk(callback.body, (child) => {
          const handlers = objectProperty(objectProperty(child, "nitro"), "handlers");
          if (containsHandler(handlers)) registers = true;
          if (child.type === "AssignmentExpression") {
            if (
              isMember(child.left, "nitro") &&
              containsHandler(objectProperty(child.right, "handlers"))
            )
              registers = true;
            if (isNitroHandlers(child.left) && containsHandler(child.right)) registers = true;
          }
          if (
            child.type === "CallExpression" &&
            (isMember(child.callee, "push") || isMember(child.callee, "unshift")) &&
            isNitroHandlers(child.callee.object) &&
            child.arguments.some((argument: AnyNode) => objectProperty(argument, "handler"))
          )
            registers = true;
        });
        return registers;
      })
    )
      registersHandler = true;
    const generated =
      node.type === "TemplateLiteral"
        ? node.quasis.map((part: AnyNode) => part.value.cooked ?? part.value.raw).join("\0")
        : node.type === "Literal" && typeof node.value === "string"
          ? node.value
          : undefined;
    if (!generated?.includes("export default")) return;
    for (const match of generated.matchAll(
      /(?:^|[;\n])\s*import\s+(?!type\s)[^;"'\0]+?\bfrom\s*["']([^"'\s\0]+)["']/g,
    ))
      imports.add(match[1]!);
  });
  return registersHandler ? imports : new Set();
}

function isMember(node: AnyNode, name: string): boolean {
  return node?.type === "MemberExpression" && !node.computed && node.property?.name === name;
}

function isNitroHandlers(node: AnyNode): boolean {
  return isMember(node, "handlers") && isMember(node.object, "nitro");
}

function containsHandler(node: AnyNode): boolean {
  return (
    node?.type === "ArrayExpression" &&
    node.elements.some((element: AnyNode) => objectProperty(element, "handler"))
  );
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
  let target: unknown = (exports as Record<string, unknown>)[`./${specifier.slice(prefix.length)}`];
  while (target && typeof target === "object" && !Array.isArray(target)) {
    const conditions = target as Record<string, unknown>;
    target = conditions.import ?? conditions.default;
  }
  if (typeof target !== "string" || !target.startsWith("./")) return;
  const built = target.match(/^\.\/dist\/(.+)\.[cm]?js$/)?.[1];
  return sourceFile(ctx, resolve(owner.dir, built ? `src/${built}.js` : target));
}
