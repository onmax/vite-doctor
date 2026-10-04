import { parseForESLint } from "@typescript-eslint/parser";
import { createRule, type RuleContext, type SourceRange } from "../../../core/index.js";
import { isViteConfigFile, propertyName, staticString, type AnyNode } from "./shared.js";
import { diagnostics } from "../../../diagnostics.js";

export const noDisabledFsStrict = createRule({
  meta: {
    id: "vite/server/no-disabled-fs-strict",
    title: "Keep Vite server.fs.strict enabled",
    description: "Avoid disabling Vite dev server filesystem strict mode.",
    category: "security",
    severity: "error",
    docsUrl: "https://vite.dev/config/server-options.html#server-fs-strict",
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        for (const fact of serverFsFacts(ctx)) {
          if (fact.strict?.value !== false) continue;
          ctx.report(
            diagnostics.VITE0017({
              why: "Vite dev server filesystem strict mode is disabled.",
              fix: "Keep server.fs.strict enabled and grant only specific paths with fs.allow.",
            }),
            {
              ruleId: "vite/server/no-disabled-fs-strict",
              severity: ctx.severity,
              category: "security",
              file: ctx.file.path,
              range: fact.strict.range,
            },
          );
        }
      },
    };
  },
});

export const noBroadFsAllow = createRule({
  meta: {
    id: "vite/server/no-broad-fs-allow",
    title: "Avoid broad Vite server.fs.allow entries",
    description: "Keep Vite dev server filesystem allow lists scoped to project paths.",
    category: "security",
    severity: "warn",
    docsUrl: "https://vite.dev/config/server-options.html#server-fs-allow",
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        for (const fact of serverFsFacts(ctx)) {
          for (const entry of fact.allow) {
            if (!isBroadAllowedPath(entry.value)) continue;
            ctx.report(
              diagnostics.VITE0016({
                why: `Vite server.fs.allow entry "${entry.value}" is broader than a project path.`,
                fix: "Allow only the specific workspace/package directories the dev server needs.",
              }),
              {
                ruleId: "vite/server/no-broad-fs-allow",
                severity: ctx.severity,
                category: "security",
                file: ctx.file.path,
                range: entry.range,
              },
            );
          }
        }
      },
    };
  },
});

function isBroadAllowedPath(value: string): boolean {
  return (
    value === "/" ||
    value === "~" ||
    value === ".." ||
    value === "../" ||
    /^\/Users\/[^/]+\/?$/.test(value) ||
    /^\/home\/[^/]+\/?$/.test(value)
  );
}

interface ServerFsFact {
  strict?: { value: boolean; range: SourceRange };
  allow: Array<{ value: string; range: SourceRange }>;
}

function serverFsFacts(ctx: RuleContext): ServerFsFact[] {
  const cacheKey = `vite:server-fs:${ctx.file.path}`;
  const cached = ctx.cache.get<ServerFsFact[]>(cacheKey);
  if (cached) return cached;
  const facts: ServerFsFact[] = [];
  try {
    const { ast, scopeManager } = parseForESLint(ctx.file.text, {
      range: true,
      sourceType: "module",
    });
    const references = new Map(
      scopeManager.scopes.flatMap((scope) =>
        scope.references.map((reference) => [reference.identifier, reference.resolved] as const),
      ),
    );
    const resolveNode = (node: AnyNode, seen = new Set<AnyNode>()): AnyNode => {
      if (!node || seen.has(node)) return undefined;
      seen.add(node);
      if (
        [
          "TSAsExpression",
          "TSSatisfiesExpression",
          "TSNonNullExpression",
          "AwaitExpression",
        ].includes(node.type)
      )
        return resolveNode(node.expression ?? node.argument, seen);
      if (node.type !== "Identifier") return node;
      const variable = references.get(node);
      const definition = variable?.defs.find(
        (definition) =>
          definition.type === "FunctionName" ||
          (definition.type === "Variable" && definition.parent.kind === "const"),
      );
      if (definition?.type === "FunctionName") return definition.node;
      return definition?.type === "Variable" ? resolveNode(definition.node.init, seen) : undefined;
    };
    const staticKey = (property: AnyNode): string | null =>
      property.computed && property.key.type !== "Literal"
        ? staticString(property.key)
        : propertyName(property.key);
    const absent = Symbol("absent");
    const propertyValue = (input: AnyNode, key: string, seen = new Set<AnyNode>()): AnyNode => {
      const object = resolveNode(input);
      if (object?.type !== "ObjectExpression" || seen.has(object)) return undefined;
      seen.add(object);
      for (const property of [...object.properties].reverse()) {
        if (property.type === "SpreadElement") {
          const value = propertyValue(property.argument, key, new Set(seen));
          if (value !== absent) return value;
          continue;
        }
        const name = staticKey(property);
        if (name === null) return undefined;
        if (name === key) return property.kind === "init" ? resolveNode(property.value) : undefined;
      }
      return absent;
    };
    const isDefineConfig = (node: AnyNode): boolean => {
      const namespace =
        node?.type === "MemberExpression" &&
        (node.computed ? staticString(node.property) : node.property.name) === "defineConfig";
      const target = namespace ? node.object : node;
      if (target?.type !== "Identifier") return false;
      return Boolean(
        references.get(target)?.defs.some((definition) => {
          if (
            definition.type !== "ImportBinding" ||
            definition.parent.type !== "ImportDeclaration" ||
            definition.parent.importKind === "type" ||
            !["vite", "vite-plus", "vitest/config"].includes(String(definition.parent.source.value))
          )
            return false;
          return namespace
            ? definition.node.type === "ImportNamespaceSpecifier"
            : definition.node.type === "ImportSpecifier" &&
                definition.node.importKind !== "type" &&
                (definition.node.imported.type === "Identifier"
                  ? definition.node.imported.name
                  : definition.node.imported.value) === "defineConfig";
        }),
      );
    };
    const roots = new Set<AnyNode>();
    const collectReturns = (node: AnyNode, visit: (value: AnyNode) => void): boolean => {
      if (!node) return false;
      if (node.type === "ReturnStatement") {
        visit(node.argument);
        return true;
      }
      if (node.type === "ThrowStatement") return true;
      if (node.type === "BlockStatement") {
        for (const statement of node.body) if (collectReturns(statement, visit)) return true;
      }
      if (node.type === "IfStatement") {
        const test = resolveNode(node.test);
        if (test?.type === "Literal")
          return collectReturns(test.value ? node.consequent : node.alternate, visit);
        const left = collectReturns(node.consequent, visit);
        const right = collectReturns(node.alternate, visit);
        return left && right;
      }
      return false;
    };
    const collectRoots = (input: AnyNode, seen = new Set<AnyNode>()) => {
      const node = resolveNode(input);
      if (!node || seen.has(node)) return;
      seen.add(node);
      const visit = (child: AnyNode) => collectRoots(child, new Set(seen));
      if (node.type === "ObjectExpression") roots.add(node);
      else if (node.type === "CallExpression" && isDefineConfig(node.callee))
        visit(node.arguments[0]);
      else if (
        ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
      ) {
        if (node.body.type === "BlockStatement") collectReturns(node.body, visit);
        else visit(node.body);
      } else if (node.type === "ConditionalExpression") {
        const test = resolveNode(node.test);
        if (test?.type === "Literal") visit(test.value ? node.consequent : node.alternate);
        else {
          visit(node.consequent);
          visit(node.alternate);
        }
      }
    };
    for (const statement of ast.body as AnyNode[]) {
      if (statement.type === "ExportDefaultDeclaration") collectRoots(statement.declaration);
      if (statement.type === "TSExportAssignment") collectRoots(statement.expression);
      if (statement.type === "ExportNamedDeclaration" && !statement.source) {
        for (const specifier of statement.specifiers ?? []) {
          if ((specifier.exported.name ?? specifier.exported.value) === "default")
            collectRoots(specifier.local);
        }
      }
      const expression =
        statement.type === "ExpressionStatement" ? statement.expression : undefined;
      const left = expression?.left;
      if (
        expression?.type === "AssignmentExpression" &&
        expression.operator === "=" &&
        left?.type === "MemberExpression" &&
        left.object?.name === "module" &&
        !references.get(left.object) &&
        (left.computed ? staticString(left.property) : left.property.name) === "exports"
      )
        collectRoots(expression.right);
    }
    const range = (node: AnyNode) =>
      ctx.helpers.rangeFromOffsets(ctx.file.path, ctx.file.text, node.range[0], node.range[1]);
    const seenFs = new Set<AnyNode>();
    for (const root of roots) {
      const fs = propertyValue(propertyValue(root, "server"), "fs");
      if (fs?.type !== "ObjectExpression" || seenFs.has(fs)) continue;
      seenFs.add(fs);
      const strict = propertyValue(fs, "strict");
      const allow = propertyValue(fs, "allow");
      facts.push({
        strict:
          strict?.type === "Literal" && typeof strict.value === "boolean"
            ? { value: strict.value, range: range(strict) }
            : undefined,
        allow:
          allow?.type === "ArrayExpression"
            ? allow.elements.flatMap((element: AnyNode) => {
                const value = staticString(resolveNode(element));
                return value === null ? [] : [{ value, range: range(element) }];
              })
            : [],
      });
    }
  } catch {
    ctx.cache.set(cacheKey, []);
    return [];
  }
  ctx.cache.set(cacheKey, facts);
  return facts;
}
