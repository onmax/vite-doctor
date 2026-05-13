import { createRule } from "../../primitives.js";
import { isViteConfigFile, type AnyNode } from "./shared.js";

export const noDisabledFsStrict = createRule({
  meta: {
    id: "vite/server/no-disabled-fs-strict",
    title: "Keep Vite server.fs.strict enabled",
    description: "Avoid disabling Vite dev server filesystem strict mode.",
    category: "security",
    severity: "error",
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const match = /\bfs\s*:\s*\{[\s\S]*?\bstrict\s*:\s*false\b/.exec(ctx.file.text);
        if (!match) return;
        const start = match.index + match[0].lastIndexOf("strict");
        ctx.report({
          ruleId: "vite/server/no-disabled-fs-strict",
          severity: ctx.severity,
          category: "security",
          file: ctx.file.path,
          range: ctx.helpers.rangeFromOffsets(ctx.file.path, ctx.file.text, start, start + 6),
          message: "Vite dev server filesystem strict mode is disabled.",
          suggestion: "Keep server.fs.strict enabled and grant only specific paths with fs.allow.",
        });
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
    requires: { script: true },
  },
  create(ctx) {
    if (!isViteConfigFile(ctx.file.relativePath)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const allow = /\ballow\s*:\s*\[([\s\S]*?)\]/.exec(ctx.file.text);
        if (!allow) return;
        const base = allow.index + allow[0].indexOf(allow[1]!);
        for (const item of allow[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)) {
          const value = item[1]!;
          if (!isBroadAllowedPath(value)) continue;
          const start = base + item.index! + item[0].indexOf(value);
          ctx.report({
            ruleId: "vite/server/no-broad-fs-allow",
            severity: ctx.severity,
            category: "security",
            file: ctx.file.path,
            range: ctx.helpers.rangeFromOffsets(
              ctx.file.path,
              ctx.file.text,
              start,
              start + value.length,
            ),
            message: `Vite server.fs.allow entry "${value}" is broader than a project path.`,
            suggestion:
              "Allow only the specific workspace/package directories the dev server needs.",
          });
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
