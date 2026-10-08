import { readFileSync } from "node:fs";
import { relative } from "node:path";

const projectCache = new Map();
const inventoryFiles = new Map();

/**
 * Project Inventory arrives through oxlint `settings.doctor`. oxlint re-parses and deep-freezes
 * the settings JSON for every file that reads them, so the settings only carry a path to the
 * inventory file, which is read once per process. Inline `projects` also work for small cases.
 * Each file picks the project with the longest root that contains it.
 */
export function projectFor(context) {
  const filename = context.filename;
  let cached = projectCache.get(filename);
  if (cached !== undefined) return cached;
  const projects = inventoryProjects(context.settings?.doctor);
  cached = null;
  for (const project of projects) {
    if (filename !== project.root && !filename.startsWith(`${project.root}/`)) continue;
    if (!cached || project.root.length > cached.root.length) cached = project;
  }
  projectCache.set(filename, cached);
  return cached;
}

function inventoryProjects(settings) {
  if (!settings) return [];
  if (!settings.inventoryFile) return settings.projects ?? [];
  let projects = inventoryFiles.get(settings.inventoryFile);
  if (!projects) {
    projects = JSON.parse(readFileSync(settings.inventoryFile, "utf8")).projects ?? [];
    inventoryFiles.set(settings.inventoryFile, projects);
  }
  return projects;
}

export function relativePath(context, project) {
  return relative(project.root, context.filename).replaceAll("\\", "/");
}

export function isVueFile(context) {
  return context.filename.endsWith(".vue");
}

/**
 * Doctor Diagnostics carry a Diagnostic Code, a `why` message and a mandatory `fix`. oxlint JS
 * diagnostics only have `message`, so the code leads the message and the fix is dropped from
 * the oxlint output. A real host would keep both in a side channel (see README).
 */
export function reportDoctor(context, node, code, why) {
  context.report({ node, message: `${code} ${why}` });
}

export function parentOf(node) {
  return node?.parent;
}

/** Same regex heuristic as Doctor's `helpers.hasLocalBindingBefore`, over the linted source. */
export function hasLocalBindingBefore(node, source) {
  if (node?.type !== "Identifier" || typeof node.name !== "string") return false;
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id === node) return true;
  if (parent?.type === "FunctionDeclaration" && parent.id === node) return true;
  if (parent?.type === "Property" && parent.key === node && !parent.computed) return true;
  const name = node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = source.slice(0, node.start);
  return new RegExp(
    String.raw`(?:\b(?:const|let|var)\s+${name}\b|\b(?:const|let|var)\s*\{[^}]*\b${name}\b[^}]*\}|\{[^}]*\b${name}\b[^}]*\}\s*\)\s*=>|[,(]\s*${name}\s*(?::[^)=]+)?=>|\(\s*${name}\s*(?::[^)]*)?\)\s*=>|function[^(]*\([^)]*\b${name}\b|[,(]\s*\{[^)]*\b${name}\b[^)]*\}\s*(?::[^)=]+)?=>|function[^(]*\([^)]*\{[^)]*\b${name}\b)`,
  ).test(before);
}

export function getNodeName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  if (node.type === "MemberExpression") {
    const object = getNodeName(node.object);
    const property = getNodeName(node.property);
    return object && property ? `${object}.${property}` : (object ?? property);
  }
  return null;
}

export function getCalleeName(node) {
  return getNodeName(node?.callee);
}

export function sourceForNode(node, source) {
  return typeof node?.start === "number" ? source.slice(node.start, node.end) : "";
}

export function walkLocal(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkLocal(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key in node) {
    if (key === "parent") continue;
    const value = node[key];
    if (value && typeof value === "object") walkLocal(value, visit);
  }
}

const FUNCTION_OR_PROGRAM = new Set([
  "Program",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

export function nearestFunctionOrProgram(node) {
  let current = node;
  while (current) {
    if (FUNCTION_OR_PROGRAM.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}
