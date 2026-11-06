import { basename, dirname, join, resolve } from "pathe";
import type { DiagnosticEvidence, RuleContext, SourceRange } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { parseScript } from "../../../core/internal/script.js";
import { parseScriptScope } from "../../../core/internal/script-scope.js";
// oxlint-disable-next-line no-restricted-imports -- walks the project tree, so MCP Rules declare cacheScope "none".
import { selectScanFiles } from "../../../core/internal/source-inventory.js";
import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";

type AnyNode = any;

export type McpLibrary =
  | "h3-mcp"
  | "nitro-mcp-toolkit"
  | "@nuxtjs/mcp-toolkit"
  | "@modelcontextprotocol/sdk";

export interface McpStaticValue {
  value: string;
  source: "literal" | "file";
  range: SourceRange;
}

export type McpToolAnnotations =
  | { state: "absent" }
  | {
      state: "resolved";
      range: SourceRange;
      keys: Set<string>;
      /** Shared objects spread into the annotations, as `name (file)`. */
      spreads: string[];
    }
  | { state: "partial"; range: SourceRange; reason: string };

/** One tool definition as the MCP Tool Inventory reads it from source. */
export interface McpToolDefinition {
  file: string;
  displayPath: string;
  library: McpLibrary;
  /** The definition call's callee, where diagnostics anchor when no field fits. */
  callee: SourceRange;
  name?: McpStaticValue;
  title?: McpStaticValue;
  annotations: McpToolAnnotations;
}

export const MCP_PACKAGES = [
  "h3-mcp",
  "okmcp",
  "nitro-mcp-toolkit",
  "@nuxtjs/mcp-toolkit",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/server",
];

const SCRIPT_FILE = /\.[cm]?[jt]s$/;
const TOOL_CALLEES = /\b(?:defineMcpTool|defineTool|registerTool)\b/;
const TRANSPARENT_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);
const MAX_SPREAD_DEPTH = 4;

function libraryForImport(source: string, imported: string): McpLibrary | undefined {
  if (imported === "defineMcpTool") {
    if (source === "nitro-mcp-toolkit") return "nitro-mcp-toolkit";
    if (
      source === "@nuxtjs/mcp-toolkit" ||
      source.startsWith("@nuxtjs/mcp-toolkit/") ||
      source === "#imports"
    )
      return "@nuxtjs/mcp-toolkit";
  }
  if (imported === "defineTool" && /^(?:h3-mcp|okmcp)(?:\/|$)/.test(source)) return "h3-mcp";
  return undefined;
}

function isSdkServerImport(source: string): boolean {
  return /^@modelcontextprotocol\/(?:sdk\/server(?:\/|$)|server(?:\/|$))/.test(source);
}

export function toolLabel(tool: McpToolDefinition): string {
  return tool.name ? `"${tool.name.value}"` : `in ${tool.displayPath}`;
}

export function annotationsEvidence(tool: McpToolDefinition): DiagnosticEvidence[] {
  const { annotations } = tool;
  if (annotations.state !== "resolved")
    return [
      {
        kind: "ast",
        file: tool.file,
        range: tool.callee,
        summary: `This ${tool.library} tool definition has no annotations.`,
      },
    ];
  const keys = [...annotations.keys];
  const via = annotations.spreads.length ? `, including ${annotations.spreads.join(", ")}` : "";
  return [
    {
      kind: "ast",
      file: tool.file,
      range: annotations.range,
      summary: `The annotations set ${keys.length ? keys.map((key) => `\`${key}\``).join(", ") : "no keys"}${via}.`,
    },
  ];
}

const inventories = new WeakMap<object, Promise<McpToolDefinition[]>>();

/** The MCP Tool Inventory for the project, read once per Doctor Run and shared by every MCP Rule. */
export function collectMcpTools(ctx: RuleContext): Promise<McpToolDefinition[]> {
  let inventory = inventories.get(ctx.project);
  if (!inventory) {
    inventory = readMcpTools(ctx);
    inventories.set(ctx.project, inventory);
  }
  return inventory;
}

interface ParsedModule {
  file: string;
  displayPath: string;
  text: string;
  program: AnyNode;
  /** Top-level `const` initializers by local name. */
  constants: Map<string, AnyNode>;
  /** Exported top-level `const` initializers by exported name. */
  exportedConstants: Map<string, AnyNode>;
  /** Import bindings by local name. */
  imports: Map<string, { source: string; imported: string }>;
}

interface ProjectModules {
  root: string;
  byPath: Map<string, ParsedModule | null>;
  /** Exported constants in auto-imported `utils` directories, for unbound identifiers. */
  autoImported?: Map<string, Array<{ module: ParsedModule; node: AnyNode }>>;
  scanned: Array<{ path: string; displayPath: string }>;
  ctx: RuleContext;
}

async function readMcpTools(ctx: RuleContext): Promise<McpToolDefinition[]> {
  const root = ctx.project.root;
  const files = await selectScanFiles(root, {}, {}, ctx.project);
  const modules: ProjectModules = {
    root,
    byPath: new Map(),
    scanned: files
      .filter((entry) => entry.sourceKind !== "module" && SCRIPT_FILE.test(entry.path))
      .map((entry) => ({ path: entry.path, displayPath: entry.displayPath })),
    ctx,
  };
  const autoImportsNuxtToolkit = projectWorkspacePackages(ctx.project).some(
    (item) => "@nuxtjs/mcp-toolkit" in item.packages,
  );
  const definitions: McpToolDefinition[] = [];
  for (const entry of modules.scanned) {
    const text = ctx.fs.readText(entry.path);
    if (!text || !TOOL_CALLEES.test(text)) continue;
    const module = loadModule(modules, entry.path, entry.displayPath);
    if (!module) continue;
    for (const found of findToolCalls(module, autoImportsNuxtToolkit)) {
      definitions.push(readDefinition(modules, module, found));
    }
  }
  return definitions;
}

function loadModule(
  modules: ProjectModules,
  file: string,
  displayPath?: string,
): ParsedModule | null {
  if (modules.byPath.has(file)) return modules.byPath.get(file)!;
  const text = modules.ctx.fs.readText(file);
  const program = text ? parseScript(file, text) : null;
  if (!text || (program as AnyNode)?.type !== "Program") {
    modules.byPath.set(file, null);
    return null;
  }
  const module: ParsedModule = {
    file,
    displayPath: displayPath ?? file.slice(modules.root.length + 1),
    text,
    program,
    constants: new Map(),
    exportedConstants: new Map(),
    imports: new Map(),
  };
  for (const statement of (program as AnyNode).body ?? []) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
        module.imports.set(specifier.local.name, {
          source: statement.source.value,
          imported: specifierName(specifier.imported),
        });
      }
    }
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type !== "Identifier" || !declarator.init) continue;
      module.constants.set(declarator.id.name, declarator.init);
      if (exported) module.exportedConstants.set(declarator.id.name, declarator.init);
    }
  }
  modules.byPath.set(file, module);
  return module;
}

interface ToolCall {
  call: AnyNode;
  library: McpLibrary;
  options: AnyNode;
  /** `registerTool(name, …)` carries the name as its first argument. */
  nameNode?: AnyNode;
  defaultExport: boolean;
}

function findToolCalls(module: ParsedModule, autoImportsNuxtToolkit: boolean): ToolCall[] {
  const bindings = bindingsByCalleeStart(module, autoImportsNuxtToolkit);
  const importsSdk = [...module.imports.values()].some(({ source }) => isSdkServerImport(source));
  const defaultExportCalls = new Set<number>();
  for (const statement of module.program.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration")
      defaultExportCalls.add(unwrap(statement.declaration)?.start);
  }
  const calls: ToolCall[] = [];
  walk(module.program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    const library = bindings.get(callee?.start);
    if (library) {
      const options = unwrap(node.arguments?.[0]);
      if (options?.type === "ObjectExpression")
        calls.push({
          call: node,
          library,
          options,
          defaultExport: defaultExportCalls.has(node.start),
        });
      return;
    }
    if (
      importsSdk &&
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.property?.name === "registerTool"
    ) {
      const options = unwrap(node.arguments?.[1]);
      if (options?.type === "ObjectExpression")
        calls.push({
          call: node,
          library: "@modelcontextprotocol/sdk",
          options,
          nameNode: node.arguments?.[0],
          defaultExport: false,
        });
    }
  });
  return calls;
}

/** Maps callee offsets to the library whose define helper they resolve to. */
function bindingsByCalleeStart(
  module: ParsedModule,
  autoImportsNuxtToolkit: boolean,
): Map<number, McpLibrary> {
  const found = new Map<number, McpLibrary>();
  let scope;
  try {
    scope = parseScriptScope(module.text, {
      dialect: /\.[cm]?ts$/.test(module.file) ? "ts" : "jsx",
      sourceType: "module",
    });
  } catch {
    // Without binding evidence, a call named defineTool could be anything.
    return found;
  }
  for (const item of scope.scopeManager.scopes) {
    for (const reference of item.references) {
      if (!reference.isValueReference) continue;
      const identifier = reference.identifier;
      const variable = reference.resolved;
      if (!variable) {
        if (identifier.name === "defineMcpTool" && autoImportsNuxtToolkit)
          found.set(identifier.range[0], "@nuxtjs/mcp-toolkit");
        continue;
      }
      for (const definition of variable.defs) {
        if (
          definition.type !== "ImportBinding" ||
          definition.parent.type !== "ImportDeclaration" ||
          definition.parent.importKind === "type" ||
          definition.node.type !== "ImportSpecifier" ||
          definition.node.importKind === "type"
        )
          continue;
        const library = libraryForImport(
          definition.parent.source.value,
          specifierName(definition.node.imported),
        );
        if (library) found.set(identifier.range[0], library);
      }
    }
  }
  return found;
}

function readDefinition(
  modules: ProjectModules,
  module: ParsedModule,
  found: ToolCall,
): McpToolDefinition {
  const range = (node: AnyNode) =>
    modules.ctx.helpers.rangeFromOffsets(module.file, module.text, node.start, node.end);
  const property = (key: string) => findProperty(found.options, key);
  const callee = range(unwrap(found.call.callee));
  const fileName = basename(module.file).replace(/\.[cm]?[jt]s$/, "");
  const discovered =
    found.defaultExport &&
    found.library !== "h3-mcp" &&
    found.library !== "@modelcontextprotocol/sdk" &&
    /(?:^|\/)mcp\/tools\//.test(module.displayPath);

  const nameNode = found.nameNode ?? property("name")?.value;
  const literalName = staticString(nameNode);
  const name: McpStaticValue | undefined =
    literalName !== undefined
      ? { value: literalName, source: "literal", range: range(unwrap(nameNode)) }
      : !nameNode && discovered
        ? {
            value: found.library === "@nuxtjs/mcp-toolkit" ? kebabCase(fileName) : fileName,
            source: "file",
            range: callee,
          }
        : undefined;

  const titleNode = property("title")?.value;
  const literalTitle = staticString(titleNode);
  const title: McpStaticValue | undefined =
    literalTitle !== undefined
      ? { value: literalTitle, source: "literal", range: range(unwrap(titleNode)) }
      : !titleNode && discovered
        ? { value: titleCase(fileName), source: "file", range: callee }
        : undefined;

  const annotationsProperty = property("annotations");
  let annotations: McpToolAnnotations = { state: "absent" };
  if (found.options.properties?.some((item: AnyNode) => item.type === "SpreadElement")) {
    annotations = {
      state: "partial",
      range: callee,
      reason: "The tool options spread another object.",
    };
  } else if (annotationsProperty) {
    const resolved = resolveObject(modules, module, annotationsProperty.value, 0);
    annotations =
      "reason" in resolved
        ? { state: "partial", range: range(annotationsProperty.value), reason: resolved.reason }
        : {
            state: "resolved",
            range: range(annotationsProperty.value),
            keys: resolved.keys,
            spreads: resolved.spreads,
          };
  }

  return {
    file: module.file,
    displayPath: module.displayPath,
    library: found.library,
    callee,
    name,
    title,
    annotations,
  };
}

type ResolvedObject = { keys: Set<string>; spreads: string[] } | { reason: string };

function resolveObject(
  modules: ProjectModules,
  module: ParsedModule,
  node: AnyNode,
  depth: number,
): ResolvedObject {
  const value = unwrap(node);
  if (depth > MAX_SPREAD_DEPTH) return { reason: "The annotations spread objects too deeply." };
  if (value?.type === "Identifier") {
    const target = resolveIdentifier(modules, module, value.name);
    if ("reason" in target) return target;
    const resolved = resolveObject(modules, target.module, target.node, depth + 1);
    if ("reason" in resolved) return resolved;
    return {
      keys: resolved.keys,
      spreads: [`${value.name} (${target.module.displayPath})`, ...resolved.spreads],
    };
  }
  if (value?.type !== "ObjectExpression")
    return { reason: "The annotations are not an object literal Doctor can read." };
  const keys = new Set<string>();
  const spreads: string[] = [];
  for (const item of value.properties ?? []) {
    if (item.type === "SpreadElement") {
      const resolved = resolveObject(modules, module, item.argument, depth + 1);
      if ("reason" in resolved) return resolved;
      for (const key of resolved.keys) keys.add(key);
      spreads.push(...resolved.spreads);
      continue;
    }
    if (item.type !== "Property" || item.computed)
      return { reason: "The annotations use a computed key." };
    const key = item.key?.type === "Identifier" ? item.key.name : staticString(item.key);
    if (key === undefined) return { reason: "The annotations use a key Doctor can't read." };
    keys.add(key);
  }
  return { keys, spreads };
}

function resolveIdentifier(
  modules: ProjectModules,
  module: ParsedModule,
  name: string,
): { module: ParsedModule; node: AnyNode } | { reason: string } {
  const local = module.constants.get(name);
  if (local) return { module, node: local };
  const imported = module.imports.get(name);
  if (imported) {
    const file = resolveRelativeModule(modules.ctx, module.file, imported.source);
    const target = file ? loadModule(modules, file) : null;
    const node = target?.exportedConstants.get(imported.imported);
    if (target && node) return { module: target, node };
    return { reason: `Doctor can't read \`${name}\` from \`${imported.source}\`.` };
  }
  const candidates = autoImportedConstants(modules).get(name) ?? [];
  if (candidates.length === 1) return candidates[0]!;
  return {
    reason:
      candidates.length > 1
        ? `\`${name}\` is exported from ${candidates.length} auto-imported files.`
        : `Doctor can't find where \`${name}\` is declared.`,
  };
}

/** Nitro and Nuxt auto-import exports from `utils` directories, so unbound names resolve there. */
function autoImportedConstants(modules: ProjectModules) {
  if (modules.autoImported) return modules.autoImported;
  const index = new Map<string, Array<{ module: ParsedModule; node: AnyNode }>>();
  for (const entry of modules.scanned) {
    if (!/(?:^|\/)(?:server|shared)\/utils\//.test(entry.displayPath)) continue;
    const text = modules.ctx.fs.readText(entry.path);
    if (!text?.includes("export")) continue;
    const module = loadModule(modules, entry.path, entry.displayPath);
    for (const [exported, node] of module?.exportedConstants ?? []) {
      index.set(exported, [...(index.get(exported) ?? []), { module: module!, node }]);
    }
  }
  modules.autoImported = index;
  return index;
}

function resolveRelativeModule(ctx: RuleContext, from: string, source: string): string | undefined {
  if (!source.startsWith(".")) return undefined;
  const base = resolve(dirname(from), source);
  const stem = base.replace(/\.[cm]?js$/, "");
  const candidates = [
    base,
    ...["ts", "mts", "cts", "js", "mjs", "cjs"].map((extension) => `${stem}.${extension}`),
    ...["ts", "js"].map((extension) => join(base, `index.${extension}`)),
  ];
  return candidates.find((candidate) => SCRIPT_FILE.test(candidate) && ctx.fs.exists(candidate));
}

function findProperty(object: AnyNode, key: string): AnyNode {
  return object.properties?.find(
    (item: AnyNode) =>
      item.type === "Property" &&
      !item.computed &&
      (item.key?.name === key || item.key?.value === key),
  );
}

function specifierName(node: AnyNode): string {
  return node?.type === "Identifier" ? node.name : node?.value;
}

function staticString(node: AnyNode): string | undefined {
  const value = unwrap(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "TemplateLiteral" && value.expressions?.length === 0)
    return value.quasis?.[0]?.value?.cooked ?? undefined;
  return undefined;
}

// Same transforms @nuxtjs/mcp-toolkit applies to a definition's file name.
function kebabCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

function titleCase(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current && TRANSPARENT_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

function walk(node: AnyNode, visit: (node: AnyNode) => void) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  visit(node);
  for (const key of getNodeVisitorKeys(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else walk(value, visit);
  }
}
