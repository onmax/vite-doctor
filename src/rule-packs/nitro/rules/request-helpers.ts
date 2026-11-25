import type { AnyNode } from "./shared.js";
import { isHttpMethod } from "../../h3/rules/request-helpers.js";

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
