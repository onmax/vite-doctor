import {
  requestImportName,
  staticMemberName,
  staticRequestString,
} from "../../../core/internal/request-values.js";
import { isHttpMethod } from "../../h3/rules/request-helpers.js";
import type { AnyNode } from "./shared.js";

const H3_SOURCES = /^(?:h3|nitro\/h3|nitropack\/runtime(?:\/.*)?|#imports)$/;
// `event.context` fields that describe the matched route rather than the visitor.
const ROUTE_CONTEXT = new Set(["params", "matchedRoute", "cache", "_nitro"]);

export function isInIfStatementTest(node: AnyNode) {
  let current = node;
  while (current) {
    const parent = current.__doctorParent;
    if (!parent) return false;
    if (parent.type === "IfStatement" && parent.test === current) return true;
    current = parent;
  }
  return false;
}

export function routeMethodSuffix(relativePath: string) {
  const path = normalizePath(relativePath);
  const match = path.match(/\.([a-z]+)(?:\.(?:dev|prod|prerender))?\.[cm]?[jt]s$/);
  const method = match?.[1]?.toUpperCase();
  return method && isHttpMethod(method) ? method : null;
}

export function routePathWithMethodSuffix(relativePath: string, suffix: string) {
  const path = normalizePath(relativePath);
  const existingMethod = routeMethodSuffix(path);
  if (existingMethod) {
    return path.replace(
      new RegExp(
        `\\.${existingMethod.toLowerCase()}(\\.(?:dev|prod|prerender))?(\\.[cm]?[jt]s)$`,
        "i",
      ),
      `.${suffix}$1$2`,
    );
  }
  return path.replace(
    /(\.(?:dev|prod|prerender))?(\.[cm]?[jt]s)$/,
    (_match, env = "", extension) => `.${suffix}${env}${extension}`,
  );
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

/** The h3 export `callee` names, through an import or Nitro's auto-import, or null. */
export function h3Name(callee: AnyNode): string | null {
  const imported = requestImportName(callee, (source) => H3_SOURCES.test(source));
  return imported === undefined ? callee.name : imported;
}

export interface EventRequestRead {
  kind: "headers" | "event";
  headers?: string[];
}

export function eventReaderDependency(name: string, args: AnyNode[]): EventRequestRead {
  if (name === "getCookie" || name === "parseCookies")
    return { kind: "headers", headers: ["cookie"] };
  if (name === "getHeader" || name === "getRequestHeader") {
    const header = staticRequestString(args[1]);
    return { kind: "headers", headers: header ? [header] : undefined };
  }
  if (name === "getHeaders" || name === "getRequestHeaders") return { kind: "headers" };
  return { kind: "event" };
}

function nextMember(node: AnyNode) {
  const parent = node?.__doctorParent;
  return parent?.type === "MemberExpression" && parent.object === node ? parent : undefined;
}

/** Visitor data read from an h3 event; does not include the raw request's URL or method. */
export function eventMemberDependency(member: AnyNode): EventRequestRead | null {
  const field = staticMemberName(member);
  const next = nextMember(member);
  if (field === "context" && !ROUTE_CONTEXT.has(staticMemberName(next) ?? ""))
    return { kind: "event" };
  const rawHeaders = nextMember(next);
  const headers =
    field === "headers"
      ? member
      : field === "node" &&
          staticMemberName(next) === "req" &&
          staticMemberName(rawHeaders) === "headers"
        ? rawHeaders
        : undefined;
  if (!headers) return null;
  const access = nextMember(headers);
  const property = staticMemberName(access);
  const call = access?.__doctorParent;
  const header =
    field === "headers"
      ? (property === "get" || property === "has") &&
        call?.type === "CallExpression" &&
        call.callee === access
        ? staticRequestString(call.arguments[0])
        : undefined
      : property;
  return { kind: "headers", headers: header ? [header] : undefined };
}

export function variesOnHeaders(varies: unknown, headers?: string[]) {
  return Boolean(
    headers?.length &&
    Array.isArray(varies) &&
    headers.every((header) =>
      varies.some(
        (entry) => typeof entry === "string" && entry.toLowerCase() === header.toLowerCase(),
      ),
    ),
  );
}
