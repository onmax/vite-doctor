import { createRule } from "@vue-doctor/core";
import { diagnostics } from "../../diagnostics.js";
import {
  hasTypeDeclaration,
  memberPath,
  propertyName,
  readViteConfigFacts,
  SECRET_NAME_RE,
  type AnyNode,
} from "./shared.js";

export const noUntypedEnv = createRule({
  meta: {
    id: "vite/env/no-untyped-env",
    title: "Type Vite environment variables",
    category: "types",
    severity: "warn",
    docsUrl: "https://vite.dev/guide/env-and-mode#intellisense-for-typescript",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = importMetaEnvKey(node);
        if (!name || builtInEnvKeys.has(name) || hasTypeDeclaration(ctx, name, true)) return;
        ctx.report(
          diagnostics.VITE0011({
            why: `import.meta.env.${name} is used but not declared on ImportMetaEnv.`,
            fix: `Declare ${name} in vite-env.d.ts or env.d.ts.`,
          }),
          {
            ruleId: "vite/env/no-untyped-env",
            severity: ctx.severity,
            category: "types",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const noClientSecretPattern = createRule({
  meta: {
    id: "vite/env/no-client-secret-pattern",
    title: "Do not read secret-looking env vars in client code",
    category: "security",
    severity: "error",
    docsUrl: "https://vite.dev/guide/env-and-mode#env-variables",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        const name = importMetaEnvKey(node);
        if (!name || !SECRET_NAME_RE.test(name)) return;
        ctx.report(
          diagnostics.VITE0009({
            why: `import.meta.env.${name} looks like a secret and may be exposed to the browser.`,
            fix: "Read secrets only in server-only code and expose deliberate public values.",
          }),
          {
            ruleId: "vite/env/no-client-secret-pattern",
            severity: ctx.severity,
            category: "security",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const preferDirectImportMetaEnvAccess = createRule({
  meta: {
    id: "vite/env/prefer-direct-import-meta-env-access",
    title: "Prefer direct import.meta.env access",
    category: "configuration",
    severity: "info",
    docsUrl: "https://vite.dev/guide/env-and-mode#env-variables",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "VariableDeclarator") return;
        if (node.id?.type !== "ObjectPattern") return;
        if (memberPath(node.init) !== "import.meta.env") return;
        ctx.report(
          diagnostics.VITE0012({
            why: "Destructuring import.meta.env hides individual compile-time env reads.",
            fix: "Read Vite env values directly as import.meta.env.VITE_NAME.",
          }),
          {
            ruleId: "vite/env/prefer-direct-import-meta-env-access",
            severity: ctx.severity,
            category: "configuration",
            file: ctx.file.path,
            range: ctx.range(node),
          },
        );
      },
    };
  },
});

export const noEmptyEnvPrefix = createRule({
  meta: {
    id: "vite/env/no-empty-env-prefix",
    title: "Do not expose every env variable",
    description: 'Avoid envPrefix: "" in Vite config.',
    category: "security",
    severity: "error",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#envprefix",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        for (const config of await readViteConfigFacts(ctx)) {
          for (const prefix of config.envPrefixes) {
            if (prefix.value !== "") continue;
            ctx.report(
              diagnostics.VITE0010({
                why: 'Vite envPrefix: "" exposes every environment variable to client code.',
                fix: "Use the default VITE_ prefix or a narrow application-specific prefix.",
              }),
              {
                ruleId: "vite/env/no-empty-env-prefix",
                severity: ctx.severity,
                category: "security",
                file: config.file,
                range: prefix.range,
              },
            );
          }
        }
      },
    };
  },
});

export const noBroadEnvPrefix = createRule({
  meta: {
    id: "vite/env/no-broad-env-prefix",
    title: "Avoid broad Vite env prefixes",
    description: "Keep Vite client env prefixes narrow enough to avoid accidental exposure.",
    category: "security",
    severity: "warn",
    execution: "workspace",
    docsUrl: "https://vite.dev/config/shared-options.html#envprefix",
    requires: { crossFile: true },
  },
  async create(ctx) {
    return {
      async onWorkspaceEnd() {
        for (const config of await readViteConfigFacts(ctx)) {
          for (const prefix of config.envPrefixes) {
            if (!isBroadPrefix(prefix.value)) continue;
            ctx.report(
              diagnostics.VITE0008({
                why: `Vite envPrefix "${prefix.value}" is broad enough to expose unrelated variables.`,
                fix: "Use a narrow public prefix and keep secret names outside client env prefixes.",
              }),
              {
                ruleId: "vite/env/no-broad-env-prefix",
                severity: ctx.severity,
                category: "security",
                file: config.file,
                range: prefix.range,
              },
            );
          }
        }
      },
    };
  },
});

const builtInEnvKeys = new Set(["MODE", "BASE_URL", "PROD", "DEV", "SSR"]);

function importMetaEnvKey(node: AnyNode): string | null {
  if (node?.type !== "MemberExpression") return null;
  if (memberPath(node.object) !== "import.meta.env") return null;
  return propertyName(node.property);
}

function isBroadPrefix(value: string): boolean {
  return value.length <= 1 || value === "APP_" || value === "PUBLIC_";
}
