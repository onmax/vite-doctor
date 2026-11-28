import type { FileFacts } from "../primitives.js";

export function isCachedFileFacts(value: unknown): value is FileFacts {
  if (!record(value)) return false;
  return (
    integer(value.fileId) &&
    typeof value.path === "string" &&
    typeof value.relativePath === "string" &&
    ["app", "layer", "module"].includes(value.sourceKind as string) &&
    optionalString(value.moduleName) &&
    ["ts", "tsx", "js", "jsx", "vue", "md", "mdc", "unknown"].includes(value.lang as string) &&
    typeof value.fileHash === "string" &&
    (value.sfc === undefined ||
      (record(value.sfc) &&
        optionalString(value.sfc.template) &&
        optionalString(value.sfc.script) &&
        optionalString(value.sfc.scriptSetup) &&
        strings(value.sfc.styles) &&
        strings(value.sfc.custom))) &&
    facts(
      value.imports,
      (item) => typeof item.source === "string" && strings(item.specifiers) && factKind(item.kind),
    ) &&
    facts(
      value.exports,
      (item) =>
        typeof item.name === "string" &&
        optionalString(item.localName) &&
        optionalString(item.source) &&
        factKind(item.kind),
    ) &&
    facts(
      value.reExports,
      (item) => typeof item.source === "string" && typeof item.typeOnly === "boolean",
    ) &&
    facts(
      value.dynamicImports,
      (item) => item.source === null || typeof item.source === "string",
    ) &&
    facts(value.calls, named) &&
    facts(value.macros, named) &&
    facts(value.templateRefs, (item) => named(item) && optionalString(item.value)) &&
    strings(value.diagnosticsHints) &&
    (value.component === undefined || componentFacts(value.component))
  );
}

function componentFacts(value: unknown): boolean {
  return (
    record(value) &&
    (value.props === undefined ||
      facts(
        value.props,
        (item) =>
          named(item) &&
          typeof item.default === "boolean" &&
          optionalString(item.defaultValue) &&
          (item.localFallback === undefined || typeof item.localFallback === "boolean"),
      )) &&
    optionalString(value.propsBinding) &&
    (value.propAliases === undefined || record(value.propAliases)) &&
    (value.emits === undefined || strings(value.emits)) &&
    optionalString(value.emitBinding) &&
    facts(value.models, (item) => named(item) && typeof item.default === "boolean") &&
    Array.isArray(value.imports) &&
    value.imports.every(
      (item) =>
        record(item) &&
        typeof item.local === "string" &&
        typeof item.imported === "string" &&
        typeof item.source === "string",
    ) &&
    strings(value.registeredComponentNames) &&
    strings(value.setupBindings) &&
    typeof value.ownLogic === "boolean" &&
    typeof value.ownMarkup === "boolean" &&
    integer(value.rootNodes) &&
    Array.isArray(value.roots) &&
    value.roots.every(
      (root) =>
        record(root) &&
        facts(
          root.branches,
          (branch) =>
            ["element", "component", "slot", "fragment", "text"].includes(branch.kind as string) &&
            optionalString(branch.tag),
        ),
    ) &&
    (value.inheritAttrs === undefined || typeof value.inheritAttrs === "boolean") &&
    typeof value.readsAttrs === "boolean" &&
    facts(value.nuxtAttrsReferences, (item) => named(item) && typeof item.explicit === "boolean") &&
    Array.isArray(value.comparisons) &&
    value.comparisons.every(
      (item) => record(item) && typeof item.left === "string" && typeof item.right === "string",
    ) &&
    facts(
      value.usages,
      (item) =>
        typeof item.tag === "string" &&
        Array.isArray(item.attributes) &&
        facts(
          item.bindings,
          (binding) => typeof binding.vnodeKey === "string" && optionalString(binding.modifiersKey),
        ) &&
        Array.isArray(item.spreads) &&
        facts(
          item.listeners,
          (listener) => typeof listener.vnodeKey === "string" && strings(listener.modifiers),
        ) &&
        strings(item.directives) &&
        typeof item.hasSlotContent === "boolean" &&
        strings(item.scope) &&
        placement(item) &&
        componentWrappers(item.wrappers) &&
        (item.parent === undefined ||
          (record(item.parent) &&
            typeof item.parent.tag === "string" &&
            typeof item.parent.element === "boolean" &&
            (item.parent.foreign === undefined || item.parent.foreign === true))),
    ) &&
    facts(
      value.slotOutlets,
      (item) => (item.name === null || typeof item.name === "string") && placement(item),
    ) &&
    strings(value.bindingReferences) &&
    (value.doctorOption === undefined ||
      (record(value.doctorOption) &&
        optionalRange(value.doctorOption.range) &&
        (value.doctorOption.unreadable === undefined ||
          value.doctorOption.cause === "computed" ||
          value.doctorOption.cause === "overridden" ||
          value.doctorOption.cause === "overridden-by-setup"))) &&
    typeof value.inlineRouteRulesMayDisableSsr === "boolean" &&
    facts(
      value.dynamicRenders,
      (render) =>
        componentWrappers(render.wrappers) &&
        optionalString(render.binding) &&
        optionalString(render.name),
    ) &&
    (value.localComponents === undefined || strings(value.localComponents)) &&
    typeof value.localComponentLookupKnown === "boolean" &&
    optionalString(value.runtimeComponentName)
  );
}

function componentWrappers(value: unknown): boolean {
  return facts(
    value,
    (wrapper) =>
      typeof wrapper.tag === "string" &&
      typeof wrapper.renderTag === "string" &&
      typeof wrapper.offset === "number" &&
      typeof wrapper.defaultSlot === "boolean" &&
      typeof wrapper.shadowed === "boolean",
  );
}

function placement(item: Record<string, unknown>): boolean {
  return (
    typeof item.inFor === "boolean" &&
    typeof item.conditional === "boolean" &&
    strings(item.builtInHosts) &&
    (item.host === undefined ||
      (record(item.host) &&
        integer(item.host.usage) &&
        (item.host.slot === null || typeof item.host.slot === "string")))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function named(value: Record<string, unknown>): boolean {
  return typeof value.name === "string";
}

function factKind(value: unknown): boolean {
  return value === "value" || value === "type" || value === "mixed";
}

function facts(value: unknown, valid: (item: Record<string, unknown>) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => record(item) && valid(item) && optionalRange(item.range))
  );
}

function optionalRange(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      integer(value.start) &&
      integer(value.end) &&
      (value.end as number) >= (value.start as number) &&
      integer(value.line, 1) &&
      integer(value.column, 1))
  );
}
