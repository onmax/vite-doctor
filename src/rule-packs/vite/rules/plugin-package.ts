import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "pathe";
import { parseForESLint } from "@typescript-eslint/parser";
import { createRule, type RuleContext } from "../../../core/index.js";
import { diagnostics } from "../../../diagnostics.js";
import type { AnyNode } from "./shared.js";

const RULE_ID = "vite/plugin-package/naming-conventions";
const SCRIPT_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];
const MAX_REEXPORT_DEPTH = 4;
const FRAMEWORK_PEERS: Record<string, string[]> = {
  vue: ["vue"],
  react: ["react", "react-dom"],
  svelte: ["svelte"],
};
const PLUGIN_HOOKS = new Set([
  "apply",
  "applyToEnvironment",
  "config",
  "configEnvironment",
  "configResolved",
  "configureServer",
  "configurePreviewServer",
  "enforce",
  "handleHotUpdate",
  "hotUpdate",
  "transformIndexHtml",
  "options",
  "buildStart",
  "resolveId",
  "resolveDynamicImport",
  "load",
  "transform",
  "moduleParsed",
  "watchChange",
  "buildEnd",
  "closeBundle",
  "outputOptions",
  "renderStart",
  "renderChunk",
  "augmentChunkHash",
  "generateBundle",
  "writeBundle",
  "banner",
  "footer",
  "intro",
  "outro",
]);

interface Manifest {
  name?: unknown;
  private?: unknown;
  bin?: unknown;
  keywords?: unknown;
  exports?: unknown;
  main?: unknown;
  module?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
}

interface Finding {
  field: "name" | "keywords";
  why: string;
  fix: string;
}

export const pluginPackageNamingConventions = createRule({
  meta: {
    id: RULE_ID,
    title: "Follow Vite plugin package naming conventions",
    category: "plugins",
    severity: "warn",
    execution: "manifest",
    cacheScope: "run",
    consumesEvidence: ["manifest", "ast"],
    docsUrl: "https://vite.dev/guide/api-plugin#conventions",
  },
  create(ctx) {
    return {
      onProjectStart() {
        const manifestPath = resolve(ctx.project.root, "package.json");
        let text: string;
        let manifest: Manifest;
        try {
          text = readFileSync(manifestPath, "utf8");
          manifest = JSON.parse(text);
        } catch {
          return;
        }
        if (!isRecord(manifest) || typeof manifest.name !== "string") return;
        if (manifest.private === true || manifest.bin !== undefined) return;
        if (!requiredPeers(manifest).has("vite")) return;
        const entry = pluginEntry(ctx.project.root, manifest);
        if (!entry) return;

        const keywords = Array.isArray(manifest.keywords)
          ? manifest.keywords.filter((keyword): keyword is string => typeof keyword === "string")
          : [];
        for (const finding of conventionFindings(manifest.name, keywords, manifest)) {
          const range = fieldRange(ctx, manifestPath, text, finding.field);
          ctx.report(
            diagnostics.VITE0024({
              why: finding.why,
              fix: finding.fix,
              sources: [`${manifestPath}:${range.line}:${range.column}`],
            }),
            {
              ruleId: RULE_ID,
              severity: ctx.severity,
              category: "plugins",
              file: manifestPath,
              range,
              confidence: "manifest-backed",
              evidence: [
                {
                  kind: "manifest",
                  file: manifestPath,
                  summary:
                    "Public package (not private, no bin) that declares vite as a required peer dependency.",
                },
                {
                  kind: "ast",
                  file: entry,
                  summary:
                    "The package's main entry exports a function that returns a Vite plugin.",
                },
              ],
            },
          );
        }
      },
    };
  },
});

function conventionFindings(name: string, keywords: string[], manifest: Manifest): Finding[] {
  const findings: Finding[] = [];
  const missing = (required: string[]) => required.filter((keyword) => !keywords.includes(keyword));
  const quoted = (values: string[]) => values.map((value) => `"${value}"`).join(" and ");
  const scoped = name.startsWith("@");
  const compatible = scoped ? undefined : /^(rolldown|rollup)-plugin-/.exec(name)?.[1];

  if (compatible) {
    const absent = missing([`${compatible}-plugin`, "vite-plugin"]);
    if (absent.length)
      findings.push({
        field: "keywords",
        why: `"${name}" uses the ${compatible}-plugin- prefix for a ${capitalize(compatible)}-compatible plugin, but its package.json keywords do not include ${quoted(absent)}.`,
        fix: `Add ${quoted(absent)} to the package.json keywords field so the plugin is discoverable as both a ${capitalize(compatible)} and a Vite plugin.`,
      });
    return findings;
  }

  const framework = soleFrameworkPeer(manifest);
  if (!scoped) {
    const prefix = framework ? `vite-plugin-${framework}-` : "vite-plugin-";
    const conforms = name.startsWith(prefix) || name === `vite-plugin-${framework}`;
    if (!conforms) {
      const suggestion = `${prefix}${baseName(name, framework)}`;
      findings.push({
        field: "name",
        why: framework
          ? `"${name}" requires ${framework} as a peer dependency, so it only works with ${capitalize(framework)}. Vite asks framework-specific plugins to include the framework in the prefix: ${prefix}.`
          : `"${name}" exports a Vite plugin from its main entry, but its name does not start with vite-plugin-, the prefix Vite asks Vite-only plugins to use.`,
        fix: `Publish the plugin as "${suggestion}"${framework ? "" : `, or use the rolldown-plugin- prefix with the "rolldown-plugin" and "vite-plugin" keywords if it does not need Vite-specific hooks`}. Renaming an already published package means publishing a new package and deprecating the old name.`,
      });
    }
  }
  if (missing(["vite-plugin"]).length)
    findings.push({
      field: "keywords",
      why: `"${name}" exports a Vite plugin, but its package.json keywords do not include "vite-plugin".`,
      fix: 'Add "vite-plugin" to the package.json keywords field so the plugin is discoverable as a Vite plugin.',
    });
  return findings;
}

function requiredPeers(manifest: Manifest): Set<string> {
  const peers = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {};
  const meta = isRecord(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {};
  return new Set(
    Object.keys(peers).filter(
      (name) =>
        typeof peers[name] === "string" && !(isRecord(meta[name]) && meta[name].optional === true),
    ),
  );
}

function soleFrameworkPeer(manifest: Manifest): string | undefined {
  const required = requiredPeers(manifest);
  const frameworks = Object.entries(FRAMEWORK_PEERS)
    .filter(([, packages]) => packages.some((name) => required.has(name)))
    .map(([framework]) => framework);
  return frameworks.length === 1 ? frameworks[0] : undefined;
}

function baseName(name: string, framework: string | undefined): string {
  const tokens = name
    .split("-")
    .filter((token) => token && token !== "vite" && token !== "plugin" && token !== framework);
  return tokens.join("-") || name;
}

function pluginEntry(root: string, manifest: Manifest): string | null {
  for (const target of rootEntryTargets(manifest)) {
    for (const file of sourceCandidates(root, target)) {
      if (isFile(file) && exportsPluginFactory(file, null, 0, new Set())) return file;
    }
  }
  return null;
}

function rootEntryTargets(manifest: Manifest): string[] {
  const targets: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (isRecord(value)) Object.values(value).forEach(collect);
  };
  const exports = manifest.exports;
  if (exports !== undefined) {
    const subpaths = isRecord(exports) && Object.keys(exports).some((key) => key.startsWith("."));
    collect(subpaths ? (exports as Record<string, unknown>)["."] : exports);
    return targets;
  }
  collect(manifest.module);
  collect(manifest.main);
  return targets.length ? targets : ["index.js"];
}

function sourceCandidates(root: string, target: string): string[] {
  const path = resolve(root, target);
  const stem = path.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "");
  const sourceStem = resolve(
    root,
    relative(root, stem).replace(/^(?:dist|lib|build|out|esm|cjs|es)(?=\/)/, "src"),
  );
  const withExtensions = (base: string) => SCRIPT_EXTENSIONS.map((extension) => base + extension);
  return [
    ...withExtensions(sourceStem),
    ...withExtensions(stem),
    ...(SCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension)) ? [path] : []),
  ];
}

function exportsPluginFactory(
  file: string,
  wanted: string | null,
  depth: number,
  seen: Set<string>,
): boolean {
  const key = `${file}#${wanted ?? "*"}`;
  if (depth > MAX_REEXPORT_DEPTH || seen.has(key)) return false;
  seen.add(key);
  let program: AnyNode;
  const pluginTypeReferences = new Map<AnyNode, boolean>();
  try {
    const parsed = parseForESLint(readFileSync(file, "utf8"), {
      filePath: file,
      sourceType: "module",
    });
    program = parsed.ast;
    for (const scope of parsed.scopeManager.scopes) {
      for (const reference of scope.references) {
        if (!reference.isTypeReference) continue;
        const imported = reference.resolved?.defs.find((definition) => {
          if (definition.type !== "ImportBinding") return false;
          const specifier = definition.node;
          return (
            definition.parent.type === "ImportDeclaration" &&
            definition.parent.source.value === "vite" &&
            ((specifier.type === "ImportSpecifier" &&
              ["Plugin", "PluginOption"].includes(exportName(specifier.imported) ?? "")) ||
              specifier.type === "ImportNamespaceSpecifier")
          );
        });
        if (imported)
          pluginTypeReferences.set(
            reference.identifier,
            imported.node.type === "ImportNamespaceSpecifier",
          );
      }
    }
  } catch {
    return false;
  }
  if (!program?.body) return false;

  const functions = new Map<string, AnyNode>();
  const imports = new Map<string, { from: string; name: string }>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id)
      functions.set(declaration.id.name, declaration);
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        const init = unwrap(declarator.init);
        if (declarator.id?.type === "Identifier" && isFunction(init))
          functions.set(declarator.id.name, init);
      }
    }
    if (statement.type !== "ImportDeclaration") continue;
    const source = statement.source?.value;
    for (const item of statement.specifiers ?? []) {
      const imported =
        item.type === "ImportDefaultSpecifier"
          ? "default"
          : item.type === "ImportSpecifier"
            ? exportName(item.imported)
            : null;
      if (!imported) continue;
      const from = typeof source === "string" ? localModule(file, source) : null;
      if (from) imports.set(item.local.name, { from, name: imported });
    }
  }

  const isFactoryBinding = (local: string) => {
    const fn = functions.get(local);
    if (fn) return isPluginFactory(fn, pluginTypeReferences);
    const binding = imports.get(local);
    return binding ? exportsPluginFactory(binding.from, binding.name, depth + 1, seen) : false;
  };
  const wants = (name: string | null) => wanted === null || wanted === name;

  for (const statement of program.body) {
    const assignment = statement.type === "ExpressionStatement" ? statement.expression : null;
    if (assignment?.type === "AssignmentExpression" && assignment.operator === "=") {
      const exported = commonJsExportName(assignment.left);
      if (exported && wants(exported)) {
        const value = unwrap(assignment.right);
        if (isFunction(value) && isPluginFactory(value, pluginTypeReferences)) return true;
        if (value?.type === "Identifier" && isFactoryBinding(value.name)) return true;
      }
    }
    if (statement.type === "ExportDefaultDeclaration" && wants("default")) {
      const declaration = unwrap(statement.declaration);
      if (isFunction(declaration) && isPluginFactory(declaration, pluginTypeReferences))
        return true;
      if (declaration?.type === "Identifier" && isFactoryBinding(declaration.name)) return true;
    }
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      if (declaration?.type === "FunctionDeclaration" && wants(declaration.id?.name ?? null))
        if (isPluginFactory(declaration, pluginTypeReferences)) return true;
      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          const init = unwrap(declarator.init);
          if (wants(declarator.id?.name ?? null) && isFunction(init))
            if (isPluginFactory(init, pluginTypeReferences)) return true;
        }
      }
      const from =
        typeof statement.source?.value === "string"
          ? localModule(file, statement.source.value)
          : undefined;
      for (const item of statement.specifiers ?? []) {
        if (statement.exportKind === "type" || item.exportKind === "type") continue;
        const exported = exportName(item.exported);
        const local = exportName(item.local);
        if (!exported || !local || !wants(exported)) continue;
        if (
          from === undefined
            ? isFactoryBinding(local)
            : from && exportsPluginFactory(from, local, depth + 1, seen)
        )
          return true;
      }
    }
    if (statement.type === "ExportAllDeclaration" && statement.exportKind !== "type") {
      const from =
        typeof statement.source?.value === "string"
          ? localModule(file, statement.source.value)
          : null;
      if (from && !statement.exported && wanted !== "default")
        if (exportsPluginFactory(from, wanted, depth + 1, seen)) return true;
    }
  }
  return false;
}

function commonJsExportName(node: AnyNode): string | null {
  if (node?.type !== "MemberExpression") return null;
  const property =
    node.computed && node.property?.type === "Identifier" ? null : exportName(node.property);
  if (node.object?.type === "Identifier" && node.object.name === "module" && property === "exports")
    return "default";
  if (node.object?.type === "Identifier" && node.object.name === "exports") return property;
  const object = node.object;
  if (
    object?.type === "MemberExpression" &&
    object.object?.type === "Identifier" &&
    object.object.name === "module" &&
    (!object.computed || object.property?.type === "Literal") &&
    exportName(object.property) === "exports"
  )
    return property;
  return null;
}

function isPluginFactory(
  fn: AnyNode,
  pluginTypeReferences: ReadonlyMap<AnyNode, boolean>,
): boolean {
  if (containsNode(fn.returnType, (node) => isPluginTypeReference(node, pluginTypeReferences)))
    return true;

  const isPluginValue = (
    node: AnyNode,
    bindings: Map<string, AnyNode>,
    seen = new Set<string>(),
  ): boolean => {
    if (!node) return false;
    if (node.type === "VariableDeclarator") {
      if (
        containsNode(node.id.typeAnnotation, (type) =>
          isPluginTypeReference(type, pluginTypeReferences),
        )
      )
        return true;
      return isPluginValue(node.init, bindings, seen);
    }
    const value = unwrap(node);
    if (value !== node) {
      if (
        containsNode(node.typeAnnotation, (type) =>
          isPluginTypeReference(type, pluginTypeReferences),
        )
      )
        return true;
      return isPluginValue(node.expression, bindings, seen);
    }
    if (isPluginObject(value)) return true;
    if (value.type === "Identifier" && !seen.has(value.name)) {
      const next = new Set(seen).add(value.name);
      return isPluginValue(bindings.get(value.name), bindings, next);
    }
    if (value.type === "ArrayExpression")
      return value.elements.some((item: AnyNode) => isPluginValue(item, bindings, seen));
    if (value.type === "SpreadElement" || value.type === "AwaitExpression")
      return isPluginValue(value.argument, bindings, seen);
    if (value.type === "ConditionalExpression")
      return (
        isPluginValue(value.consequent, bindings, seen) ||
        isPluginValue(value.alternate, bindings, seen)
      );
    if (value.type === "LogicalExpression")
      return (
        isPluginValue(value.right, bindings, seen) ||
        (value.operator !== "&&" && isPluginValue(value.left, bindings, seen))
      );
    return false;
  };
  const returnsPlugin = (node: AnyNode, bindings: Map<string, AnyNode>): boolean => {
    if (!node || typeof node !== "object" || isFunction(node)) return false;
    if (Array.isArray(node)) return node.some((item) => returnsPlugin(item, bindings));
    if (node.type === "BlockStatement") {
      const local = new Map(bindings);
      for (const statement of node.body) {
        if (statement.type === "VariableDeclaration") {
          for (const declaration of statement.declarations) {
            if (declaration.id?.type === "Identifier") local.set(declaration.id.name, declaration);
          }
        }
      }
      return returnsPlugin(node.body, local);
    }
    if (node.type === "ReturnStatement") return isPluginValue(node.argument, bindings);
    return Object.entries(node).some(
      ([key, value]) => key !== "parent" && returnsPlugin(value, bindings),
    );
  };
  return fn.body?.type === "BlockStatement"
    ? returnsPlugin(fn.body, new Map())
    : isPluginValue(fn.body, new Map());
}

function isPluginTypeReference(
  node: AnyNode,
  pluginTypeReferences: ReadonlyMap<AnyNode, boolean>,
): boolean {
  if (node.type === "TSImportType") {
    const source = node.source;
    const qualifier = node.qualifier;
    return (
      source?.type === "Literal" &&
      source.value === "vite" &&
      qualifier?.type === "Identifier" &&
      ["Plugin", "PluginOption"].includes(qualifier.name)
    );
  }
  if (node.type !== "TSTypeReference") return false;
  const typeName = node.typeName;
  if (typeName?.type === "Identifier") return pluginTypeReferences.get(typeName) === false;
  return (
    typeName?.type === "TSQualifiedName" &&
    typeName.left?.type === "Identifier" &&
    pluginTypeReferences.get(typeName.left) === true &&
    ["Plugin", "PluginOption"].includes(typeName.right?.name ?? "")
  );
}

function isPluginObject(node: AnyNode): boolean {
  if (node.type !== "ObjectExpression") return false;
  const properties = (node.properties ?? []).filter(
    (property: AnyNode) => property.type === "Property",
  );
  return (
    properties.some((property: AnyNode) => exportName(property.key) === "name") &&
    properties.some((property: AnyNode) => {
      const key = exportName(property.key);
      if (!key || !PLUGIN_HOOKS.has(key)) return false;
      const value = unwrap(property.value);
      return (
        isFunction(value) ||
        (value?.type === "ObjectExpression" &&
          value.properties.some(
            (entry: AnyNode) =>
              exportName(entry.key) === "handler" && isFunction(unwrap(entry.value)),
          ))
      );
    })
  );
}

function containsNode(root: AnyNode, predicate: (node: AnyNode) => boolean): boolean {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node.type === "string" && predicate(node)) return true;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "parent" && value && typeof value === "object") stack.push(value);
    }
  }
  return false;
}

function fieldRange(ctx: RuleContext, file: string, text: string, field: "name" | "keywords") {
  const match =
    (field === "keywords" ? /"keywords"\s*:/.exec(text) : null) ??
    /"name"\s*:\s*("[^"]*")/.exec(text);
  const start = match ? match.index + (match[1] ? match[0].lastIndexOf(match[1]) : 0) : 0;
  const end = match ? start + (match[1]?.length ?? '"keywords"'.length) : 0;
  return ctx.helpers.rangeFromOffsets(file, text, start, end);
}

function localModule(from: string, specifier: string): string | null {
  if (!/^\.\.?(?:\/|$)/.test(specifier)) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2"),
    ...SCRIPT_EXTENSIONS.map((extension) => base + extension),
    ...SCRIPT_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return (
    candidates.find(
      (candidate) =>
        SCRIPT_EXTENSIONS.some((extension) => candidate.endsWith(extension)) && isFile(candidate),
    ) ?? null
  );
}

function unwrap(node: AnyNode): AnyNode {
  while (
    node &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}

function isFunction(node: AnyNode): boolean {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function exportName(node: AnyNode): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  return typeof node.value === "string" ? node.value : null;
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
