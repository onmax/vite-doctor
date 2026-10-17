import { createRule, type RuleContext } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import { propertyName, staticString, type AnyNode } from "./shared.js";

const configParamIndex: Record<string, number> = { config: 0, configEnvironment: 1 };
const pluginKeys = new Set([
  "name",
  "enforce",
  "apply",
  "configResolved",
  "configureServer",
  "configurePreviewServer",
  "transformIndexHtml",
  "handleHotUpdate",
  "hotUpdate",
  "resolveId",
  "load",
  "transform",
  "buildStart",
  "buildEnd",
  "generateBundle",
  "writeBundle",
  "closeBundle",
]);

export const noConfigHookArrayEcho = createRule({
  meta: {
    id: "vite/plugin/no-config-hook-array-echo",
    title: "Return only new array entries from Vite config hooks",
    category: "plugins",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/api-plugin.html#config",
    requires: { script: true },
    prefilter: { names: ["config", "configEnvironment"] },
  },
  create(ctx) {
    return {
      Property(node: AnyNode) {
        const hook = keyName(node);
        if (hook === null || !(hook in configParamIndex) || node.computed) return;
        if (!isPluginObject(node.__doctorParent)) return;
        const fn = hookFunction(node.value);
        const param = fn?.params[configParamIndex[hook]!];
        if (param?.type !== "Identifier") return;
        for (const echo of findEchoes(fn, param.name)) report(ctx, hook, echo);
      },
    };
  },
});

interface Echo {
  node: AnyNode;
  path: string;
}

function report(ctx: RuleContext, hook: string, echo: Echo) {
  ctx.report(
    diagnostics.VITE0026({
      why: `Vite merges the ${hook} hook result into the current config and concatenates arrays, so returning the incoming ${echo.path} entries adds each of them a second time.`,
      fix: `Return only the entries this plugin adds to ${echo.path}, or mutate the incoming config in place and return nothing for that field.`,
    }),
    { file: ctx.file.path, range: ctx.range(echo.node) },
  );
}

function findEchoes(fn: AnyNode, param: string): Echo[] {
  const locals = new Map<string, AnyNode>();
  const assignments: Array<{ target: string; path: string[]; value: AnyNode }> = [];
  const returns: AnyNode[] = [];
  if (fn.body.type !== "BlockStatement") returns.push(fn.body);
  else
    walkOwnBody(fn.body, (node) => {
      if (node.type === "ReturnStatement" && node.argument) returns.push(node.argument);
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init &&
        !locals.has(node.id.name)
      )
        locals.set(node.id.name, node.init);
      if (node.type === "AssignmentExpression" && node.operator === "=") {
        const target = memberKeys(node.left);
        if (target && target.keys.length > 0)
          assignments.push({ target: target.root, path: target.keys, value: node.right });
      }
    });

  const echoes: Echo[] = [];
  const seen = new Set<AnyNode>();
  const incomingPath = (input: AnyNode): string[] | null => {
    const node = unwrapFallback(input);
    if (node?.type === "Identifier" && node.name !== param) {
      const local = locals.get(node.name);
      return local && local !== input ? incomingPath(local) : null;
    }
    const member = memberKeys(node);
    return member?.root === param && member.keys.length > 0 ? member.keys : null;
  };
  const isPath = (input: AnyNode, path: string[]) => {
    const keys = incomingPath(input);
    return keys !== null && keys.join(".") === path.join(".");
  };
  const arrayEchoes = (input: AnyNode, path: string[]): AnyNode[] => {
    const node = unwrap(input);
    if (node?.type === "ArrayExpression")
      return node.elements.flatMap((element: AnyNode) =>
        element?.type === "SpreadElement"
          ? isPath(element.argument, path)
            ? [element]
            : arrayEchoes(element.argument, path)
          : [],
      );
    if (node?.type === "NewExpression" && node.callee.type === "Identifier")
      return node.callee.name === "Set" ? arrayEchoes(node.arguments[0], path) : [];
    if (node?.type !== "CallExpression") return [];
    const callee = unwrap(node.callee);
    if (callee?.type !== "MemberExpression") return [];
    const method = memberName(callee);
    if (method === "from" && unwrap(callee.object)?.name === "Array")
      return arrayEchoes(node.arguments[0], path);
    if (method === "concat" && isPath(callee.object, path)) return [node];
    return [];
  };
  const helperEchoes = (input: AnyNode, path: string[]): AnyNode[] => {
    const node = unwrap(input);
    if (node?.type !== "CallExpression" || unwrap(node.callee)?.type !== "Identifier") return [];
    const helper = localFunction(fn, unwrap(node.callee).name);
    if (!helper) return [];
    return node.arguments.some(
      (argument: AnyNode, index: number) =>
        isPath(argument, path) && helperEchoesParam(helper, index),
    )
      ? [node]
      : [];
  };
  const visitValue = (input: AnyNode, path: string[]) => {
    const node = unwrap(input);
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "Identifier") {
      const local = locals.get(node.name);
      if (local) visitValue(local, path);
      for (const assignment of assignments)
        if (assignment.target === node.name)
          visitValue(assignment.value, [...path, ...assignment.path]);
      return;
    }
    if (node.type === "ConditionalExpression") {
      visitValue(node.consequent, path);
      visitValue(node.alternate, path);
      return;
    }
    if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          if (
            ["ObjectExpression", "ConditionalExpression"].includes(unwrap(property.argument)?.type)
          )
            visitValue(property.argument, path);
          continue;
        }
        const key = keyName(property);
        if (key === null || property.kind !== "init") continue;
        visitValue(property.value, [...path, key]);
      }
      return;
    }
    if (path.length === 0) return;
    for (const echo of [...arrayEchoes(node, path), ...helperEchoes(node, path)])
      echoes.push({ node: echo, path: path.join(".") });
  };
  for (const value of returns) visitValue(value, []);
  return echoes;
}

function helperEchoesParam(helper: AnyNode, index: number): boolean {
  const param = helper.params[index];
  if (param?.type !== "Identifier") return false;
  const returns: AnyNode[] = [];
  if (helper.body.type !== "BlockStatement") returns.push(helper.body);
  else
    walkOwnBody(helper.body, (node) => {
      if (node.type === "ReturnStatement" && node.argument) returns.push(node.argument);
    });
  const spreadsParam = (input: AnyNode): boolean => {
    const node = unwrap(input);
    if (node?.type === "ConditionalExpression")
      return spreadsParam(node.consequent) || spreadsParam(node.alternate);
    if (node?.type === "NewExpression" && node.callee.type === "Identifier")
      return node.callee.name === "Set" && spreadsParam(node.arguments[0]);
    if (node?.type === "CallExpression") {
      const callee = unwrap(node.callee);
      if (callee?.type !== "MemberExpression") return false;
      if (memberName(callee) === "from" && unwrap(callee.object)?.name === "Array")
        return spreadsParam(node.arguments[0]);
      return memberName(callee) === "concat" && isParam(callee.object);
    }
    if (node?.type !== "ArrayExpression") return false;
    return node.elements.some(
      (element: AnyNode) =>
        element?.type === "SpreadElement" &&
        (isParam(element.argument) || spreadsParam(element.argument)),
    );
  };
  const isParam = (input: AnyNode) => {
    const node = unwrapFallback(input);
    return node?.type === "Identifier" && node.name === param.name;
  };
  return returns.some(spreadsParam);
}

function localFunction(from: AnyNode, name: string): AnyNode {
  let program = from;
  while (program.__doctorParent) program = program.__doctorParent;
  let found: AnyNode;
  walkOwnBody(program, (node) => {
    if (found) return;
    if (node.type === "FunctionDeclaration" && node.id?.name === name) found = node;
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === name &&
      ["ArrowFunctionExpression", "FunctionExpression"].includes(unwrap(node.init)?.type)
    )
      found = unwrap(node.init);
  });
  return found;
}

function isPluginObject(node: AnyNode): boolean {
  return (
    node?.type === "ObjectExpression" &&
    node.properties.some(
      (property: AnyNode) => property.type === "Property" && pluginKeys.has(keyName(property)!),
    )
  );
}

function hookFunction(input: AnyNode): AnyNode {
  const node = unwrap(input);
  if (["ArrowFunctionExpression", "FunctionExpression"].includes(node?.type)) return node;
  if (node?.type !== "ObjectExpression") return undefined;
  const handler = node.properties.find(
    (property: AnyNode) => property.type === "Property" && keyName(property) === "handler",
  );
  const value = unwrap(handler?.value);
  return ["ArrowFunctionExpression", "FunctionExpression"].includes(value?.type)
    ? value
    : undefined;
}

function memberKeys(input: AnyNode): { root: string; keys: string[] } | null {
  const keys: string[] = [];
  let node = unwrap(input);
  while (node?.type === "MemberExpression") {
    const key = memberName(node);
    if (key === null) return null;
    keys.unshift(key);
    node = unwrap(node.object);
  }
  return node?.type === "Identifier" ? { root: node.name, keys } : null;
}

function keyName(property: AnyNode): string | null {
  if (property?.type !== "Property") return null;
  return property.computed ? staticString(property.key) : propertyName(property.key);
}

function memberName(node: AnyNode): string | null {
  return node.computed ? staticString(node.property) : propertyName(node.property);
}

function unwrapFallback(input: AnyNode): AnyNode {
  let node = unwrap(input);
  while (
    node?.type === "LogicalExpression" &&
    (node.operator === "??" || node.operator === "||") &&
    isEmptyFallback(node.right)
  )
    node = unwrap(node.left);
  return node;
}

function isEmptyFallback(input: AnyNode): boolean {
  const node = unwrap(input);
  return (
    (node?.type === "ArrayExpression" && node.elements.length === 0) ||
    (node?.type === "Identifier" && node.name === "undefined") ||
    (node?.type === "Literal" && node.value === null)
  );
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
      "ChainExpression",
      "AwaitExpression",
    ].includes(node.type)
  )
    node = node.expression ?? node.argument;
  return node;
}

function walkOwnBody(node: AnyNode, visit: (node: AnyNode) => void, root = node): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkOwnBody(child, visit, root);
    return;
  }
  if (typeof node.type !== "string") return;
  if (
    node !== root &&
    root.type !== "Program" &&
    ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
  )
    return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "__doctorParent") walkOwnBody(child, visit, root);
  }
}
