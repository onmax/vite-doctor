import { basename, dirname, join, resolve } from "pathe";
import type { DiagnosticEvidence, RuleContext, SourceRange } from "../../../core/index.js";
import { projectWorkspacePackages } from "../../../core/internal/applicability.js";
import { parseScript } from "../../../core/internal/script.js";
import {
  parseScriptScope,
  type ScopeReference,
  type ScriptScope,
} from "../../../core/internal/script-scope.js";
// oxlint-disable-next-line no-restricted-imports -- walks the project tree, so MCP Rules declare cacheScope "none".
import { selectScanFiles } from "../../../core/internal/source-inventory.js";
import { getNodeVisitorKeys } from "../../../core/internal/visitor-keys.js";

type AnyNode = any;

export type McpLibrary =
  | "h3-mcp"
  | "nitro-mcp-toolkit"
  | "@nuxtjs/mcp-toolkit"
  | "@vite-hub/mcp"
  | "@modelcontextprotocol/sdk";

export interface McpStaticValue {
  value: string;
  source: "literal" | "file";
  range: SourceRange;
}

type AnnotationValue =
  | { state: "resolved"; value: string | boolean | number | null | undefined }
  | { state: "invalid" | "unknown" };

export type McpToolAnnotations =
  | { state: "absent" }
  | {
      state: "resolved";
      range: SourceRange;
      values: Map<string, AnnotationValue>;
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
  /** `JSON.stringify()` calls with an indent whose result the tool returns as its text. */
  indentedJson: McpIndentedJson[];
}

export interface McpIndentedJson {
  /** The stringify call, or the call of the helper that returns it, in the tool's file. */
  range: SourceRange;
  /** The stringify call inside a helper that the tool returns. */
  helper?: { file: string; displayPath: string; range: SourceRange };
}

export const MCP_PACKAGES = [
  "h3-mcp",
  "okmcp",
  "nitro-mcp-toolkit",
  "@nuxtjs/mcp-toolkit",
  "@vite-hub/mcp",
  "vite-hub",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/server",
];

const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
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
    // Apps install `vite-hub` and import its `vite-hub/mcp` entry, which re-exports `@vite-hub/mcp`.
    if (source === "vite-hub/mcp" || source === "@vite-hub/mcp") return "@vite-hub/mcp";
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
  const keys = [...annotations.values.keys()];
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
  scope: ScriptScope | null;
  /** Value references keyed by identifier offset in the source AST. */
  references: Map<number, ScopeReference>;
  /** Readable `const` initializers keyed by their binding identifier offset. */
  constants: Map<number, AnyNode>;
  stableFunctions: Set<number>;
  /** Exported top-level `const` initializers and function declarations by exported name. */
  exportedConstants: Map<string, AnyNode>;
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
  let scope: ScriptScope | null = null;
  const references = new Map<number, ScopeReference>();
  try {
    scope = parseScriptScope(text, {
      dialect: file.endsWith(".tsx") ? "tsx" : /\.[cm]?ts$/.test(file) ? "ts" : "jsx",
      sourceType: "module",
    });
    for (const reference of scope.references.values()) {
      if (reference.isValueReference) references.set(reference.identifier.range[0], reference);
    }
  } catch {
    // Without scope evidence, neither tool callees nor annotation bindings are readable.
    scope = null;
    references.clear();
  }
  const module: ParsedModule = {
    file,
    displayPath: displayPath ?? file.slice(modules.root.length + 1),
    text,
    program,
    scope,
    references,
    constants: new Map(),
    stableFunctions: new Set(),
    exportedConstants: new Map(),
  };
  for (const lexicalScope of scope?.scopeManager.scopes ?? []) {
    for (const variable of lexicalScope.variables) {
      const [definition] = variable.defs;
      if (
        variable.defs.length === 1 &&
        definition?.type === "FunctionName" &&
        definition.node.type === "FunctionDeclaration" &&
        !variable.references.some((reference) => reference.isWrite())
      )
        module.stableFunctions.add(definition.node.range[0]);
    }
  }
  walk(program, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declarator of node.declarations ?? []) {
      if (declarator.id?.type === "Identifier" && declarator.init)
        module.constants.set(declarator.id.start, declarator.init);
    }
  });
  for (const statement of (program as AnyNode).body ?? []) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      module.exportedConstants.set(declaration.id.name, declaration);
      continue;
    }
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type !== "Identifier" || !declarator.init) continue;
      module.exportedConstants.set(declarator.id.name, declarator.init);
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
    if (callee?.type === "Identifier" && library && library !== "@modelcontextprotocol/sdk") {
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
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.property?.name === "registerTool" &&
      unwrap(callee.object)?.type === "Identifier" &&
      bindings.get(unwrap(callee.object)?.start) === "@modelcontextprotocol/sdk"
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

/** Maps helper and SDK receiver offsets to their lexically resolved library. */
function bindingsByCalleeStart(
  module: ParsedModule,
  autoImportsNuxtToolkit: boolean,
): Map<number, McpLibrary> {
  const found = new Map<number, McpLibrary>();
  const scope = module.scope;
  if (!scope) return found;
  for (const reference of module.references.values()) {
    const identifier = reference.identifier;
    const variable = reference.resolved;
    if (!variable) {
      if (identifier.name === "defineMcpTool" && autoImportsNuxtToolkit)
        found.set(identifier.range[0], "@nuxtjs/mcp-toolkit");
      continue;
    }
    for (const definition of variable.defs) {
      if (definition.type === "Variable" && definition.parent.kind === "const") {
        const init = unwrap(definition.node.init);
        const constructor = init?.type === "NewExpression" ? unwrap(init.callee) : undefined;
        const imported = scope.references.get(constructor)?.resolved;
        if (
          imported?.defs.some(
            (item) =>
              item.type === "ImportBinding" &&
              item.parent.type === "ImportDeclaration" &&
              item.parent.importKind !== "type" &&
              item.node.type === "ImportSpecifier" &&
              item.node.importKind !== "type" &&
              specifierName(item.node.imported) === "McpServer" &&
              isSdkServerImport(item.parent.source.value),
          )
        )
          found.set(identifier.range[0], "@modelcontextprotocol/sdk");
      }
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
  const fileName = basename(module.file).replace(SCRIPT_FILE, "");
  const toolPath = /(?:^|\/)mcp\/tools\/(.+)$/.exec(
    module.displayPath.replace(SCRIPT_FILE, ""),
  )?.[1];
  const discovered =
    found.defaultExport &&
    found.library !== "h3-mcp" &&
    found.library !== "@modelcontextprotocol/sdk" &&
    toolPath !== undefined;

  const nameNode =
    discovered && found.library === "@vite-hub/mcp"
      ? undefined
      : (found.nameNode ?? property("name")?.value);
  const literalName = staticString(nameNode);
  const name: McpStaticValue | undefined =
    literalName !== undefined
      ? { value: literalName, source: "literal", range: range(unwrap(nameNode)) }
      : !nameNode && discovered
        ? { value: fileToolName(found.library, fileName, toolPath), source: "file", range: callee }
        : undefined;

  const titleNode = property("title")?.value;
  const literalTitle = staticString(titleNode);
  const title: McpStaticValue | undefined =
    literalTitle !== undefined
      ? { value: literalTitle, source: "literal", range: range(unwrap(titleNode)) }
      : !titleNode && discovered && found.library !== "@vite-hub/mcp"
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
            values: resolved.values,
            spreads: resolved.spreads,
          };
  }

  const handler =
    found.library === "@modelcontextprotocol/sdk"
      ? found.call.arguments?.[2]
      : outputProperty(found.options, "handler");
  return {
    file: module.file,
    displayPath: module.displayPath,
    library: found.library,
    callee,
    name,
    title,
    annotations,
    indentedJson: findIndentedJsonOutput(modules, module, handler, found.library).map((site) => ({
      range: range(site.anchor),
      ...(site.anchor !== site.stringify
        ? {
            helper: {
              file: site.module.file,
              displayPath: site.module.displayPath,
              range: modules.ctx.helpers.rangeFromOffsets(
                site.module.file,
                site.module.text,
                site.stringify.start,
                site.stringify.end,
              ),
            },
          }
        : {}),
    })),
  };
}

function fileToolName(library: McpLibrary, fileName: string, toolPath: string | undefined) {
  if (library === "@nuxtjs/mcp-toolkit") return kebabCase(fileName);
  // ViteHub names a tool after its path below `mcp/tools/`, without the extension or a trailing `/index`.
  if (library === "@vite-hub/mcp" && toolPath) return toolPath.replace(/\/index$/i, "");
  return fileName;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const MAX_HELPER_DEPTH = 2;

interface IndentedJsonSite {
  anchor: AnyNode;
  module: ParsedModule;
  stringify: AnyNode;
}

type OutputPosition = "result" | "content" | "block" | "text";

function findIndentedJsonOutput(
  modules: ProjectModules,
  module: ParsedModule,
  handler: AnyNode,
  library: McpLibrary,
): IndentedJsonSite[] {
  const found: IndentedJsonSite[] = [];
  const autoImports = library === "@nuxtjs/mcp-toolkit" || library === "nitro-mcp-toolkit";
  const resolveModule = library === "@vite-hub/mcp" ? resolveViteModule : resolveRelativeModule;
  const resolveBinding = (current: ParsedModule, identifier: AnyNode) =>
    resolveIdentifier(modules, current, identifier, autoImports, resolveModule);

  function readFunction(
    current: ParsedModule,
    node: AnyNode,
    position: OutputPosition,
    depth: number,
    anchor?: AnyNode,
  ) {
    const fn = unwrap(node);
    if (!FUNCTION_TYPES.has(fn?.type) || fn.generator || !fn.body) return;
    if (fn.body.type !== "BlockStatement") {
      readValue(current, fn.body, position, depth, anchor);
    } else {
      visitReturns(fn.body, (value) => readValue(current, value, position, depth, anchor));
    }
  }

  function readValue(
    current: ParsedModule,
    expression: AnyNode,
    position: OutputPosition,
    depth: number,
    anchor?: AnyNode,
  ) {
    const node = unwrap(expression);
    const read = (child: AnyNode, next = position) =>
      readValue(current, child, next, depth, anchor);
    if (node?.type === "ConditionalExpression") {
      read(node.consequent);
      read(node.alternate);
    } else if (node?.type === "LogicalExpression") {
      if (node.operator !== "&&") read(node.left);
      read(node.right);
    } else if (node?.type === "AwaitExpression") {
      read(node.argument);
    } else if (node?.type === "ObjectExpression" && position === "result") {
      read(outputProperty(node, "content"), "content");
    } else if (node?.type === "ArrayExpression" && position === "content") {
      for (const element of node.elements) read(element, "block");
    } else if (node?.type === "ObjectExpression" && position === "block") {
      if (staticString(outputProperty(node, "type")) === "text")
        read(outputProperty(node, "text"), "text");
    }

    if (node?.type !== "CallExpression") return;
    if (isJsonStringify(current, node.callee)) {
      if ((position === "text" || position === "result") && hasLiteralIndent(node))
        found.push({ anchor: anchor ?? node, module: current, stringify: node });
      return;
    }
    const callee = unwrap(node.callee);
    if (
      position === "result" &&
      library === "nitro-mcp-toolkit" &&
      isNitroToolResult(current, callee)
    ) {
      const envelope = unwrap(node.arguments?.[0]);
      if (envelope?.type === "ObjectExpression") read(envelope);
      return;
    }
    if (callee?.type !== "Identifier" || depth >= MAX_HELPER_DEPTH) return;
    const target = resolveBinding(current, callee);
    if (!("reason" in target))
      readFunction(target.module, target.node, position, depth + 1, anchor ?? node);
  }

  const value = unwrap(handler);
  if (value?.type === "Identifier") {
    const target = resolveBinding(module, value);
    if (!("reason" in target)) readFunction(target.module, target.node, "result", 0, value);
  } else {
    readFunction(module, value, "result", 0);
  }
  return found;
}

function isNitroToolResult(module: ParsedModule, callee: AnyNode): boolean {
  const binding = module.references.get(callee?.start)?.resolved;
  return (
    callee?.type === "Identifier" &&
    !!binding?.defs.some(
      (definition) =>
        definition.type === "ImportBinding" &&
        definition.parent.type === "ImportDeclaration" &&
        definition.parent.importKind !== "type" &&
        definition.parent.source.value === "nitro-mcp-toolkit" &&
        definition.node.type === "ImportSpecifier" &&
        definition.node.importKind !== "type" &&
        specifierName(definition.node.imported) === "toolResult",
    )
  );
}

function hasLiteralIndent(call: AnyNode): boolean {
  const indent = unwrap(call.arguments?.[2]);
  return (
    indent?.type === "Literal" &&
    (typeof indent.value === "number" ? indent.value >= 1 : !!staticString(indent)) &&
    !call.arguments.slice(0, 3).some((argument: AnyNode) => argument.type === "SpreadElement")
  );
}

function isJsonStringify(module: ParsedModule, callee: AnyNode): boolean {
  const value = unwrap(callee);
  const receiver = unwrap(value?.object);
  const reference = module.references.get(receiver?.start);
  return (
    value?.type === "MemberExpression" &&
    !value.computed &&
    receiver?.type === "Identifier" &&
    receiver.name === "JSON" &&
    value.property?.name === "stringify" &&
    reference !== undefined &&
    !reference.resolved
  );
}

function visitReturns(node: AnyNode, visit: (value: AnyNode) => void) {
  if (!node || FUNCTION_TYPES.has(node.type)) return;
  if (node.type === "ReturnStatement") {
    visit(node.argument);
    return;
  }
  for (const key of getNodeVisitorKeys(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) visitReturns(child, visit);
    else visitReturns(value, visit);
  }
}

function outputProperty(object: AnyNode, key: string): AnyNode {
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const item = object.properties[index];
    if (item.type !== "Property") return undefined;
    const name =
      !item.computed && item.key.type === "Identifier" ? item.key.name : staticString(item.key);
    if (name === undefined && item.computed) return undefined;
    if (name === key) return item.kind === "init" ? item.value : undefined;
  }
  return undefined;
}

type ResolvedObject =
  | { values: Map<string, AnnotationValue>; spreads: string[] }
  | { reason: string };

function resolveObject(
  modules: ProjectModules,
  module: ParsedModule,
  node: AnyNode,
  depth: number,
): ResolvedObject {
  const value = unwrap(node);
  if (depth > MAX_SPREAD_DEPTH) return { reason: "The annotations spread objects too deeply." };
  if (value?.type === "Identifier") {
    const target = resolveIdentifier(modules, module, value);
    if ("reason" in target) return target;
    const resolved = resolveObject(modules, target.module, target.node, depth + 1);
    if ("reason" in resolved) return resolved;
    return {
      values: resolved.values,
      spreads: [`${value.name} (${target.module.displayPath})`, ...resolved.spreads],
    };
  }
  if (value?.type !== "ObjectExpression")
    return { reason: "The annotations are not an object literal Doctor can read." };
  const values = new Map<string, AnnotationValue>();
  const spreads: string[] = [];
  for (const item of value.properties ?? []) {
    if (item.type === "SpreadElement") {
      const resolved = resolveObject(modules, module, item.argument, depth + 1);
      if ("reason" in resolved) return resolved;
      for (const [key, value] of resolved.values) values.set(key, value);
      spreads.push(...resolved.spreads);
      continue;
    }
    if (item.type !== "Property" || item.computed)
      return { reason: "The annotations use a computed key." };
    const key = item.key?.type === "Identifier" ? item.key.name : staticString(item.key);
    if (key === undefined) return { reason: "The annotations use a key Doctor can't read." };
    values.set(
      key,
      item.kind === "init" && !item.method
        ? resolveAnnotationValue(modules, module, item.value, depth)
        : { state: "unknown" },
    );
  }
  return { values, spreads };
}

function resolveAnnotationValue(
  modules: ProjectModules,
  module: ParsedModule,
  node: AnyNode,
  depth: number,
): AnnotationValue {
  const value = unwrap(node);
  if (!value || depth > MAX_SPREAD_DEPTH) return { state: "unknown" };
  const string = staticString(value);
  if (string !== undefined) return { state: "resolved", value: string };
  if (value.type === "Literal") return { state: "resolved", value: value.value };
  if (value.type === "UnaryExpression" && value.operator === "void")
    return { state: "resolved", value: undefined };
  if (value.type === "Identifier") {
    const target = resolveIdentifier(modules, module, value);
    if (!("reason" in target))
      return resolveAnnotationValue(modules, target.module, target.node, depth + 1);
    const reference = module.references.get(value.start);
    if (value.name === "undefined" && reference && !reference.resolved)
      return { state: "resolved", value: undefined };
  }
  if (
    [
      "ObjectExpression",
      "ArrayExpression",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(value.type)
  )
    return { state: "invalid" };
  return { state: "unknown" };
}

function resolveIdentifier(
  modules: ProjectModules,
  module: ParsedModule,
  identifier: AnyNode,
  autoImports = true,
  resolveModule = resolveRelativeModule,
): { module: ParsedModule; node: AnyNode } | { reason: string } {
  const name = identifier.name;
  const reference = module.references.get(identifier.start);
  if (!reference) return { reason: `Doctor can't read the binding of \`${name}\`.` };
  if (reference.resolved) {
    for (const definition of reference.resolved.defs) {
      if (
        definition.type === "FunctionName" &&
        module.stableFunctions.has(definition.node.range[0])
      )
        return { module, node: definition.node };
      if (definition.type === "Variable" && definition.parent.kind === "const") {
        const local = module.constants.get(definition.name.range[0]);
        if (local) return { module, node: local };
      }
      if (
        definition.type === "ImportBinding" &&
        definition.parent.type === "ImportDeclaration" &&
        definition.parent.importKind !== "type" &&
        definition.node.type === "ImportSpecifier" &&
        definition.node.importKind !== "type"
      ) {
        const source = definition.parent.source.value;
        const file = resolveModule(modules.ctx, module.file, source);
        const target = file ? loadModule(modules, file) : null;
        const node = target?.exportedConstants.get(specifierName(definition.node.imported));
        if (target && node && isStableExport(target, node)) return { module: target, node };
        return { reason: `Doctor can't read \`${name}\` from \`${source}\`.` };
      }
    }
    return { reason: `Doctor can't read the binding of \`${name}\`.` };
  }
  const candidates = (autoImports && autoImportedConstants(modules).get(name)) || [];
  const [candidate] = candidates;
  if (candidates.length === 1 && candidate && isStableExport(candidate.module, candidate.node))
    return candidate;
  return {
    reason:
      candidates.length > 1
        ? `\`${name}\` is exported from ${candidates.length} auto-imported files.`
        : `Doctor can't find where \`${name}\` is declared.`,
  };
}

function isStableExport(module: ParsedModule, node: AnyNode): boolean {
  return node.type !== "FunctionDeclaration" || module.stableFunctions.has(node.start);
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
    ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map(
      (extension) => `${stem}.${extension}`,
    ),
    ...["ts", "tsx", "js", "jsx"].map((extension) => join(base, `index.${extension}`)),
  ];
  return candidates.find((candidate) => SCRIPT_FILE.test(candidate) && ctx.fs.exists(candidate));
}

const VITE_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];

function resolveViteModule(ctx: RuleContext, from: string, source: string): string | undefined {
  if (!/^\.{1,2}\//.test(source) || /[?#]/.test(source)) return undefined;
  const base = resolve(dirname(from), source);
  const isFile = (path: string) => ctx.fs.stat(path)?.isFile();
  const jsExtension = /\.(?:[cm]?js|jsx)$/.exec(base)?.[0];
  const substitutes = jsExtension
    ? [
        base.slice(0, -jsExtension.length) + jsExtension.replace("js", "ts"),
        ...(jsExtension === ".js" ? [base.slice(0, -jsExtension.length) + ".tsx"] : []),
      ]
    : [];
  const file = [base, ...substitutes, ...VITE_EXTENSIONS.map((ext) => base + ext)].find(isFile);
  if (file) return SCRIPT_FILE.test(file) ? file : undefined;
  if (ctx.fs.exists(join(base, "package.json"))) return undefined;
  const index = VITE_EXTENSIONS.map((ext) => join(base, `index${ext}`)).find(isFile);
  return index && SCRIPT_FILE.test(index) ? index : undefined;
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
