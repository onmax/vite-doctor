import { dirname, join } from "pathe";
import type {
  ComponentFacts,
  ComponentNode,
  ComponentUsageFact,
  ComponentUsageGraph,
  RuleContext,
} from "../../../../core/index.js";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MEMBER = /^([A-Za-z_$][\w$]*)\??\.([A-Za-z_$][\w$]*)$/;

/** Vue's prop name normalization: `active-id` and `activeId` name the same prop. */
export function camelize(name: string): string {
  return name.replace(/-(\w)/g, (_, char: string) => char.toUpperCase());
}

export function displayName(node: ComponentNode): string {
  const base = node.relativePath
    .split("/")
    .pop()!
    .replace(/\.vue$/, "");
  return base === "index" ? (node.relativePath.split("/").at(-2) ?? base) : base;
}

/** The own prop an expression reads unchanged, such as `title`, `props.title`, or `$props.title`. */
export function propReference(facts: ComponentFacts, expression: string): string | undefined {
  const text = expression.trim();
  const declared = new Set((facts.props ?? []).map((prop) => prop.name));
  if (IDENTIFIER.test(text)) {
    const aliased = facts.propAliases?.[text];
    if (aliased) return declared.has(aliased) ? aliased : undefined;
    return declared.has(text) && !facts.imports.some((item) => item.local === text)
      ? text
      : undefined;
  }
  const member = text.match(MEMBER);
  if (!member) return undefined;
  const [, object, property] = member;
  const viaProps =
    object === "$props" || (facts.propsBinding !== undefined && object === facts.propsBinding);
  return viaProps && declared.has(property!) ? property : undefined;
}

export function isPropsObject(facts: ComponentFacts, expression: string): boolean {
  const text = expression.trim();
  return text === "$props" || (facts.propsBinding !== undefined && text === facts.propsBinding);
}

const EMIT_CALL =
  /^([A-Za-z_$][\w$]*)\(\s*(['"`])([^'"`]+)\2\s*(?:,\s*(\.\.\.)?([A-Za-z_$][\w$]*))?\s*\)$/;
const ARROW = /^(?:async\s+)?\(?\s*(\.\.\.)?([A-Za-z_$][\w$]*)?\s*\)?\s*=>\s*(.+)$/s;

/** The declared event a listener re-emits unchanged, such as `emit('save', $event)`. */
export function reemittedEvent(
  facts: ComponentFacts,
  expression: string | undefined,
): string | undefined {
  if (!expression) return undefined;
  let body = expression.trim();
  let parameter: string | undefined;
  let rest = false;
  const arrow = body.match(ARROW);
  if (arrow) {
    rest = Boolean(arrow[1]);
    parameter = arrow[2];
    body = arrow[3]!.trim();
  }
  const call = body.match(EMIT_CALL);
  if (!call) return undefined;
  const [, callee, , event, spread, argument] = call;
  if (callee !== "$emit" && callee !== facts.emitBinding) return undefined;
  if (argument !== undefined) {
    const forwards = arrow
      ? argument === parameter && Boolean(spread) === rest
      : argument === "$event" && !spread;
    if (!forwards) return undefined;
  } else if (arrow && parameter) return undefined;
  return facts.emits?.includes(event!) ? event : undefined;
}

/** Props a usage passes, camelized: static attributes, bindings, and `v-model` props. */
export function passedProps(usage: ComponentUsageFact): Set<string> {
  const names = new Set<string>();
  for (const attribute of usage.attributes) names.add(camelize(attribute.name));
  for (const binding of usage.bindings) names.add(camelize(binding.name));
  return names;
}

/**
 * Whether code outside the run can render the component: its nearest `package.json` declares
 * package entry points, so the package is consumed by other projects.
 */
export function isPackageComponent(ctx: RuleContext, file: string): boolean {
  let directory = dirname(file);
  for (;;) {
    const manifest = ctx.fs.readJson(join(directory, "package.json"));
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      const fields = manifest as Record<string, unknown>;
      return ["exports", "main", "module"].some((field) => fields[field] !== undefined);
    }
    const parent = dirname(directory);
    if (parent === directory || !directory.startsWith(ctx.project.root)) return false;
    directory = parent;
  }
}

/** Unresolved tags, PascalCase without a Nuxt `Lazy` prefix. */
export function unresolvedTagNames(graph: ComponentUsageGraph): Set<string> {
  return new Set(graph.unresolved.map((edge) => pascalCase(edge.usage.tag)));
}

/**
 * Whether an unresolved tag could render this component under a name Doctor cannot map, such
 * as a global registration or a Nuxt directory-prefixed auto-import.
 */
export function mayRenderUnresolved(node: ComponentNode, unresolved: Set<string>): boolean {
  const name = pascalCase(displayName(node));
  for (const tag of unresolved) if (tag.endsWith(name)) return true;
  return false;
}

function pascalCase(tag: string): string {
  const camel = camelize(tag);
  return (camel.charAt(0).toUpperCase() + camel.slice(1)).replace(/^Lazy(?=[A-Z])/, "");
}
