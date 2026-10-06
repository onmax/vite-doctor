import type { RuleLifecycleHooks, RuleVisitor, SourceFileHandle } from "../primitives.js";
import { getNodeVisitorKeys, getTemplateVisitorKeys } from "./visitor-keys.js";

type AstNode = Record<string, unknown> & { type: string };
type NodeHandler = (node: AstNode) => void;
type HandlerTable = Map<string, NodeHandler[]>;

const LIFECYCLE_HOOKS = new Set<string>([
  "onWorkspaceStart",
  "onProjectStart",
  "SFC",
  "TemplateNode",
  "NuxtManifest",
  "onProjectEnd",
  "onWorkspaceEnd",
] satisfies Array<keyof RuleLifecycleHooks>);

/** Whether `key` names a script node visitor such as `CallExpression` or `Program:exit`. */
export function isScriptVisitorKey(key: string): boolean {
  return !LIFECYCLE_HOOKS.has(key);
}

export function runVisitor(visitor: RuleVisitor, file: SourceFileHandle): Promise<void> {
  return runVisitors([visitor], file);
}

export async function runVisitors(
  visitors: readonly RuleVisitor[],
  file: SourceFileHandle,
): Promise<void> {
  if (file.sfc) {
    for (const visitor of visitors) await visitor.SFC?.(file.sfc);
  }
  if (file.scriptAst) {
    const handlers = scriptHandlers(visitors);
    if (handlers) dispatchScript(file.scriptAst, handlers.enter, handlers.exit);
  }
  if (file.templateAst) {
    const templateVisitors = visitors.filter((visitor) => visitor.TemplateNode !== undefined);
    if (templateVisitors.length > 0) dispatchTemplate(file.templateAst, templateVisitors);
  }
}

function scriptHandlers(visitors: readonly RuleVisitor[]) {
  let enter: HandlerTable | undefined;
  let exit: HandlerTable | undefined;
  for (const visitor of visitors) {
    for (const key in visitor) {
      if (!isScriptVisitorKey(key)) continue;
      const handler = (visitor as Record<string, unknown>)[key];
      if (typeof handler !== "function") continue;
      const isExit = key.endsWith(":exit");
      const table = isExit ? (exit ??= new Map()) : (enter ??= new Map());
      const type = isExit ? key.slice(0, -5) : key;
      const bound = (node: AstNode) => handler.call(visitor, node);
      const list = table.get(type);
      if (list) list.push(bound);
      else table.set(type, [bound]);
    }
  }
  return enter || exit ? { enter, exit } : undefined;
}

function dispatchScript(root: unknown, enter?: HandlerTable, exit?: HandlerTable) {
  // Linking every parent before any visitor runs lets rules walk up from nodes the walk has not
  // reached yet, which they could rely on before only because earlier rules had already walked.
  const nodes: AstNode[] = [];
  const subtreeEnds: number[] | undefined = exit ? [] : undefined;
  collectScriptNodes(root, undefined, nodes, subtreeEnds);
  if (!subtreeEnds) {
    for (const node of nodes) {
      const handlers = enter!.get(node.type);
      if (handlers) for (const handler of handlers) handler(node);
    }
    return;
  }
  const open: number[] = [];
  for (let index = 0; index < nodes.length; index++) {
    while (open.length > 0 && subtreeEnds[open.at(-1)!]! <= index) runExit(nodes[open.pop()!]!);
    const node = nodes[index]!;
    const handlers = enter?.get(node.type);
    if (handlers) for (const handler of handlers) handler(node);
    open.push(index);
  }
  while (open.length > 0) runExit(nodes[open.pop()!]!);

  function runExit(node: AstNode) {
    const handlers = exit!.get(node.type);
    if (handlers) for (const handler of handlers) handler(node);
  }
}

function collectScriptNodes(
  node: unknown,
  parent: AstNode | undefined,
  nodes: AstNode[],
  subtreeEnds: number[] | undefined,
) {
  if (!node || typeof node !== "object") return;
  const typed = node as AstNode;
  if (!typed.type) return;
  if (parent) setDoctorParent(typed, parent);
  const index = nodes.push(typed) - 1;
  for (const key of getNodeVisitorKeys(typed)) {
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const child of value) collectScriptNodes(child, typed, nodes, subtreeEnds);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      collectScriptNodes(value, typed, nodes, subtreeEnds);
    }
  }
  if (subtreeEnds) subtreeEnds[index] = nodes.length;
}

function setDoctorParent(node: AstNode, parent: AstNode) {
  if ((node as { __doctorParent?: unknown }).__doctorParent === parent) return;
  try {
    Object.defineProperty(node, "__doctorParent", {
      value: parent,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Some parser nodes may be frozen by future parser versions.
  }
}

function dispatchTemplate(node: unknown, visitors: readonly RuleVisitor[]) {
  if (!node || typeof node !== "object") return;
  const typed = node as AstNode;
  if (!typed.type) return;
  for (const visitor of visitors) visitor.TemplateNode!(typed);
  for (const key of getTemplateVisitorKeys(typed)) {
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const child of value) dispatchTemplate(child, visitors);
    } else if (value && typeof value === "object" && typeof (value as any).type === "string") {
      dispatchTemplate(value, visitors);
    }
  }
}
