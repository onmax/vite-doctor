import { resolve } from "pathe";
import type {
  Diagnostic,
  DiagnosticEvidence,
  NuxtResolvedRoute,
  RuleContext,
} from "../../../../core/index.js";
import { createRule, walkScriptLocal, type AnyNode } from "./shared.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "vue/router/no-redirect-cycle";
const MANIFEST_FILE = ".nuxt/doctor.manifest.json";
// A path vue-router matches literally: no params, regexps, repeats, or query and hash.
const STATIC_PATH_RE = /^\/[\w\-.~/]*$/;
const WRAPPER_TYPES = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

type Target = { path: string } | { name: string };

interface RouteRecord {
  path: string;
  name?: string;
  /** A static target, `null` for a redirect Doctor cannot follow, `undefined` for none. */
  redirect?: Target | null;
  node?: AnyNode;
  file?: string;
}

export const noRedirectCycle = createRule({
  meta: {
    id: RULE_ID,
    title: "Route redirects must not form a cycle",
    category: "routing",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://router.vuejs.org/guide/essentials/redirect-and-alias.html",
    requires: { script: true },
    prefilter: { names: ["createRouter", "definePageMeta"] },
    reportScope: "project",
  },
  create(ctx) {
    const program = ctx.file.scriptAst;
    if (!program) return;
    reportNuxtRouteCycle(ctx, program);
    const createRouter = vueRouterImport(program);
    if (!createRouter || /\b(?:addRoute|removeRoute)\b/.test(ctx.file.text)) return;
    return {
      CallExpression(node: AnyNode) {
        if (node.callee?.type !== "Identifier" || node.callee.name !== createRouter) return;
        const options = unwrap(node.arguments?.[0]);
        if (options?.type !== "ObjectExpression") return;
        const routesProperty = options.properties.find(
          (property: AnyNode) => property.type === "Property" && keyName(property) === "routes",
        );
        const routes = routesArray(program, routesProperty?.value);
        const records = routes && routeRecords(routes.elements, undefined);
        if (!records) return;
        for (const cycle of redirectCycles(records)) {
          const members = cycle.map((index) => records[index]!);
          report(ctx, members, {
            range: ctx.range(members[0]!.node),
            related: members.map((record, position) => ({
              file: ctx.file.path,
              range: ctx.range(record.node),
              message: redirectMessage(record, members[(position + 1) % members.length]!),
            })),
            confidence: "proven",
            evidence: [
              {
                kind: "ast",
                summary:
                  "Every record in the cycle has a static redirect that resolves to exactly one record in this routes array.",
              },
            ],
          });
        }
      },
    };
  },
});

function report(
  ctx: RuleContext,
  members: RouteRecord[],
  location: Pick<Diagnostic, "range" | "related" | "confidence"> & {
    evidence: DiagnosticEvidence[];
  },
) {
  const chain = [...members, members[0]!].map((record) => `'${record.path}'`).join(" → ");
  ctx.report(
    diagnostics.VUE0053({
      why: `These route records redirect in a cycle: ${chain}. vue-router follows a record redirect by resolving its target and following that record's redirect in turn, with no limit, so navigating to any of these paths recurses until the call stack overflows.`,
      fix: "Point one redirect at a record that renders a component, or remove the redirect that closes the cycle.",
    }),
    {
      ruleId: RULE_ID,
      severity: ctx.severity,
      category: "routing",
      file: ctx.file.path,
      ...location,
    },
  );
}

function redirectMessage(from: RouteRecord, to: RouteRecord) {
  return `'${from.path}' redirects to '${to.path}'.`;
}

function vueRouterImport(program: AnyNode): string | null {
  for (const statement of program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.source?.value !== "vue-router")
      continue;
    for (const specifier of statement.specifiers ?? []) {
      const imported = specifier.imported?.name ?? specifier.imported?.value;
      if (specifier.type === "ImportSpecifier" && imported === "createRouter")
        return specifier.local.name;
    }
  }
  return null;
}

// A routes const counts only when createRouter is the one place the file uses it.
function routesArray(program: AnyNode, value: AnyNode): AnyNode {
  const node = unwrap(value);
  if (node?.type === "ArrayExpression") return node;
  if (node?.type !== "Identifier") return null;
  let declaration: AnyNode = null;
  // A shorthand property's key and value are one source identifier.
  const references = new Set<number>();
  walkScriptLocal(program, (child) => {
    if (child.type === "VariableDeclarator" && child.id?.type === "Identifier") {
      if (child.id.name === node.name) declaration = declaration ? false : child;
    } else if (child.type === "Identifier" && child.name === node.name && isReference(child)) {
      references.add(child.start);
    }
  });
  if (!declaration || references.size !== 1) return null;
  const parent = (declaration as AnyNode).__doctorParent;
  if (parent?.type !== "VariableDeclaration" || parent.kind !== "const") return null;
  const init = unwrap((declaration as AnyNode).init);
  return init?.type === "ArrayExpression" ? init : null;
}

// vue-router joins a relative child path onto its parent's full path.
function routeRecords(elements: AnyNode[], parentPath: string | undefined): RouteRecord[] | null {
  const records: RouteRecord[] = [];
  for (const element of elements) {
    const node = unwrap(element);
    if (node?.type !== "ObjectExpression") return null;
    const properties = new Map<string, AnyNode>();
    for (const property of node.properties) {
      const key = property.type === "Property" ? keyName(property) : null;
      if (!key) return null;
      properties.set(key, property);
    }
    if (properties.has("alias") || properties.has("strict") || properties.has("sensitive"))
      return null;
    const own = stringValue(properties.get("path")?.value);
    if (own === null) return null;
    const path =
      parentPath === undefined || own.startsWith("/")
        ? own
        : parentPath + (own && (parentPath.endsWith("/") ? "" : "/") + own);
    const nameProperty = properties.get("name");
    const name = nameProperty ? stringValue(nameProperty.value) : undefined;
    if (name === null) return null;
    const redirectProperty = properties.get("redirect");
    records.push({
      path,
      name,
      redirect: redirectProperty ? redirectTarget(unwrap(redirectProperty.value)) : undefined,
      node: redirectProperty ?? node,
    });
    const children = properties.get("children");
    if (children) {
      const array = unwrap(children.value);
      if (array?.type !== "ArrayExpression") return null;
      const nested = routeRecords(array.elements, path);
      if (!nested) return null;
      records.push(...nested);
    }
  }
  return records;
}

function redirectTarget(node: AnyNode): Target | null {
  const text = stringValue(node);
  if (text !== null) return STATIC_PATH_RE.test(text) ? { path: text } : null;
  if (node?.type !== "ObjectExpression") return null;
  const target: Record<string, unknown> = {};
  for (const property of node.properties) {
    const key = property.type === "Property" ? keyName(property) : null;
    if (!key) return null;
    if (key === "path" || key === "name") target[key] = stringValue(property.value);
  }
  return targetFromJson(target);
}

function targetFromJson(value: unknown): Target | null {
  if (typeof value === "string") return STATIC_PATH_RE.test(value) ? { path: value } : null;
  if (!value || typeof value !== "object") return null;
  const { path, name } = value as { path?: unknown; name?: unknown };
  if (path !== undefined && name !== undefined) return null;
  if (typeof path === "string") return STATIC_PATH_RE.test(path) ? { path } : null;
  if (typeof name === "string") return { name };
  return null;
}

/** Each redirect cycle once, starting at its earliest record. */
function redirectCycles(records: RouteRecord[]): number[][] {
  const next = records.map((record) =>
    record.redirect ? resolveTarget(records, record.redirect) : null,
  );
  const cycles: number[][] = [];
  const seen = new Set<number>();
  for (let start = 0; start < records.length; start++) {
    const path: number[] = [];
    let current: number | null = start;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      path.push(current);
      current = next[current] ?? null;
    }
    const loopStart = current === null ? -1 : path.indexOf(current);
    if (loopStart < 0) continue;
    const cycle = path.slice(loopStart);
    const first = cycle.indexOf(Math.min(...cycle));
    cycles.push([...cycle.slice(first), ...cycle.slice(0, first)]);
  }
  return cycles.sort((a, b) => a[0]! - b[0]!);
}

// vue-router ranks a fully static path above any path with params at the same depth, but a
// longer path with optional params can still outrank it, and matching ignores case and a
// trailing slash. A target resolves only when no other record could take it.
function resolveTarget(records: RouteRecord[], target: Target): number | null {
  if ("name" in target) {
    const named = records.flatMap((record, index) => (record.name === target.name ? [index] : []));
    return named.length === 1 ? named[0]! : null;
  }
  const key = matchKey(target.path);
  const matches = records.flatMap((record, index) =>
    matchKey(record.path) === key ? [index] : [],
  );
  if (matches.length !== 1 || records[matches[0]!]!.path !== target.path) return null;
  const prefix = key === "/" ? "/" : `${key}/`;
  const shadowed = records.some(
    (record) => !STATIC_PATH_RE.test(record.path) && record.path.toLowerCase().startsWith(prefix),
  );
  return shadowed ? null : matches[0]!;
}

function matchKey(path: string) {
  const lower = path.toLowerCase();
  return lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
}

function reportNuxtRouteCycle(ctx: RuleContext, program: AnyNode) {
  const manifest = ctx.project.nuxt?.manifest;
  if (!manifest?.isCurrent || !manifest.routes || !manifest.routerOptionsFiles) return;
  // A router.options `routes` function can replace every route Nuxt resolved.
  for (const file of manifest.routerOptionsFiles) {
    const text = ctx.fs.readText(file);
    if (text === undefined || /\broutes\b/.test(text)) return;
  }
  const records = nuxtRouteRecords(manifest.routes);
  if (!records) return;
  const current = resolve(ctx.project.root, ctx.file.path);
  for (const cycle of redirectCycles(records)) {
    const members = cycle.map((index) => records[index]!);
    const anchor = members.find(
      (record) => record.file && /\bdefinePageMeta\b/.test(ctx.fs.readText(record.file) ?? ""),
    );
    if (anchor?.file !== current) continue;
    const meta = definePageMetaRedirect(program);
    if (!meta) continue;
    report(ctx, members, {
      range: ctx.range(meta),
      related: members.map((record, position) => ({
        file: record.file ?? MANIFEST_FILE,
        message: redirectMessage(record, members[(position + 1) % members.length]!),
      })),
      confidence: "manifest-backed",
      evidence: [
        {
          kind: "manifest",
          summary:
            "Nuxt resolved these page routes with static redirects, and no router.options file defines routes.",
        },
      ],
    });
  }
}

// Nuxt hands vue-router a route's own path, name and alias unless page meta sets them at runtime.
function nuxtRouteRecords(routes: NuxtResolvedRoute[]): RouteRecord[] | null {
  const records: RouteRecord[] = [];
  for (const route of routes) {
    const dynamic = new Set(route.dynamic ?? []);
    if (["path", "name", "alias"].some((key) => dynamic.has(key))) return null;
    if (route.alias !== undefined && (!Array.isArray(route.alias) || route.alias.length))
      return null;
    records.push({
      path: route.path,
      name: route.name,
      redirect: dynamic.has("redirect")
        ? null
        : route.redirect === undefined || route.redirect === null
          ? undefined
          : targetFromJson(route.redirect),
      file: route.file,
    });
  }
  return records;
}

function definePageMetaRedirect(program: AnyNode): AnyNode {
  let found: AnyNode = null;
  walkScriptLocal(program, (node) => {
    if (found || node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier" || node.callee.name !== "definePageMeta") return;
    const meta = unwrap(node.arguments?.[0]);
    found =
      meta?.type === "ObjectExpression"
        ? (meta.properties.find(
            (property: AnyNode) => property.type === "Property" && keyName(property) === "redirect",
          ) ?? node)
        : node;
  });
  return found;
}

function keyName(property: AnyNode): string | null {
  if (property.computed) return null;
  const key = property.key;
  if (key?.type === "Identifier") return key.name;
  return typeof key?.value === "string" ? key.value : null;
}

function stringValue(node: AnyNode): string | null {
  const value = unwrap(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "TemplateLiteral" && value.expressions.length === 0)
    return value.quasis[0]?.value.cooked ?? null;
  return null;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (current && WRAPPER_TYPES.has(current.type)) current = current.expression;
  return current;
}

function isReference(node: AnyNode): boolean {
  const parent = node.__doctorParent;
  if (parent?.type === "MemberExpression") return parent.object === node || parent.computed;
  if (parent?.type === "Property")
    return parent.key !== node || parent.computed || parent.shorthand;
  if (parent?.type === "VariableDeclarator") return parent.init === node;
  return true;
}
