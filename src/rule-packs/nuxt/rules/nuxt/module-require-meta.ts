import { AnyNode, createRule } from "./shared.js";
import {
  findDefaultNuxtModuleDefinition,
  findProperty,
  packageModuleEntry,
  staticStringValue,
  unwrapExpression,
} from "./module-authoring.js";
import { diagnostics } from "../../diagnostics.js";

const RULE_ID = "nuxt/module/require-meta";
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export const moduleRequireMeta = createRule({
  meta: {
    id: RULE_ID,
    title: "Declare Nuxt module meta",
    category: "modules",
    severity: "warn",
    fixable: "suggestion",
    docsUrl: "https://nuxt.com/docs/4.x/guide/modules/module-anatomy#define-your-module",
    requires: { script: true, nuxt: true },
  },
  create(ctx) {
    if (!packageModuleEntry(ctx)) return;
    return {
      ScriptNode(node: AnyNode) {
        if (node.type !== "Program") return;
        const found = findDefaultNuxtModuleDefinition(node);
        if (!found) return;
        const definition = unwrapExpression(found.definition);
        const shape = readModuleShape(definition, found.typeArguments);
        if (!shape) return;
        const anchor = shape.metaProperty ?? found.call.callee;
        const packageName = ctx.project.packageName;
        const report = (why: string, fix: string) =>
          ctx.report(diagnostics.NUXT0081({ why, fix }), {
            ruleId: RULE_ID,
            severity: ctx.severity,
            category: "modules",
            file: ctx.file.path,
            range: ctx.range(anchor),
          });

        if (!shape.has("name")) {
          report(
            "defineNuxtModule() has no meta.name. @nuxt/kit uses meta.name (falling back to meta.configKey) to install a module only once, and hasNuxtModule() and getNuxtModuleVersion() look installed modules up by it, so other modules cannot detect this one and duplicate installs can run setup twice.",
            `Add meta.name with the npm package name, for example name: '${packageName ?? "my-module"}'.`,
          );
        }
        const nameValue = shape.name;
        const configKeyDefaultsToName = nameValue !== undefined && IDENTIFIER_RE.test(nameValue);
        if (shape.takesOptions && !shape.has("configKey") && !configKeyDefaultsToName) {
          report(
            nameValue
              ? `defineNuxtModule() accepts options but has no meta.configKey. @nuxt/kit then reads options from nuxt.config under meta.name, so users would have to write '${nameValue}': { ... }.`
              : "defineNuxtModule() accepts options but has no meta.configKey. @nuxt/kit reads module options from nuxt.config under meta.configKey (or meta.name), so users cannot configure this module from nuxt.config.",
            `Add meta.configKey with a camelCase key users can write in nuxt.config, for example configKey: '${suggestConfigKey(nameValue ?? packageName)}'.`,
          );
        }
        if (!shape.has("compatibility")) {
          report(
            "defineNuxtModule() has no meta.compatibility. With it, @nuxt/kit checks the installed Nuxt version before setup and disables the module with a clear message instead of failing later with an unrelated error.",
            `Add meta.compatibility with the supported Nuxt range, for example compatibility: { nuxt: '>=${nuxtMajor(ctx.project.nuxtVersion)}.0.0' }.`,
          );
        }
      },
    };
  },
});

interface ModuleShape {
  metaProperty?: AnyNode;
  name?: string;
  takesOptions: boolean;
  has(key: string): boolean;
}

function readModuleShape(definition: AnyNode, typeArguments: AnyNode): ModuleShape | null {
  const hasTypeArguments = Boolean(typeArguments?.params?.length);
  if (isFunction(definition)) {
    return {
      takesOptions: hasTypeArguments || usesOptionsParameter(definition),
      has: () => false,
    };
  }
  if (definition?.type !== "ObjectExpression") return null;
  if (definition.properties?.some((property: AnyNode) => property.type !== "Property")) return null;
  const metaProperty = findProperty(definition, "meta");
  const meta = metaProperty ? unwrapExpression(metaProperty.value) : undefined;
  if (metaProperty && meta?.type !== "ObjectExpression") return null;
  if (meta?.properties?.some((property: AnyNode) => property.type !== "Property")) return null;
  const setup = findProperty(definition, "setup")?.value;
  return {
    metaProperty,
    name: staticStringValue(findProperty(meta, "name")?.value),
    takesOptions:
      hasTypeArguments ||
      Boolean(findProperty(definition, "defaults")) ||
      Boolean(findProperty(definition, "schema")) ||
      (isFunction(setup) && usesOptionsParameter(setup)),
    has: (key) => Boolean(findProperty(meta, key)),
  };
}

function isFunction(node: AnyNode): boolean {
  return node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";
}

function usesOptionsParameter(fn: AnyNode): boolean {
  const first = fn.params?.[0];
  const parameter = first?.type === "AssignmentPattern" ? first.left : first;
  if (!parameter) return false;
  if (parameter.type === "Identifier") return !parameter.name.startsWith("_");
  return parameter.type === "ObjectPattern";
}

function suggestConfigKey(name: string | undefined): string {
  const base = (name ?? "myModule")
    .replace(/^@[^/]+\//, "")
    .replace(/^nuxt-/, "")
    .replace(/-nuxt$/, "")
    .replace(/^nuxt$/, "module");
  return base.replace(/[-_.]+([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
}

function nuxtMajor(version: string | undefined): number {
  return Number(version?.match(/\d+/)?.[0] ?? 4);
}
