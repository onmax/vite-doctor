import { basename, dirname, extname, isAbsolute, relative, resolve } from "pathe";
import type {
  ComponentNode,
  ComponentUsageGraph,
  DoctorComponentOption,
  ProjectInfo,
  SourceRange,
} from "../../core/index.js";
import { projectWorkspacePackages } from "../../core/internal/applicability.js";

/**
 * A Component Contract as a component author writes it, in `<script setup>`:
 *
 * ```ts
 * defineOptions({ doctor: { replaces: "button" } });
 * ```
 *
 * or, for a component the project does not own, in a design-system Rule's options:
 *
 * ```ts
 * { contracts: { UButton: { replaces: "button" } } }
 * ```
 *
 * Doctor reads it statically, so every value must be a literal.
 */
export interface ComponentContractInput {
  /** The raw HTML element, or elements, that call sites should render this component instead of. */
  replaces?: string | string[];
}

/**
 * A Component Contract after Doctor read and normalized it. A new key is a field here and its
 * reader in `CONTRACT_KEYS`; existing fields are never reshaped.
 */
export interface ComponentContract {
  /** Lowercase HTML tag names, such as `["input", "textarea"]`. Empty when the contract sets none. */
  replaces: string[];
}

/** A Component Contract and the component that declares it. */
export interface DeclaredContract {
  /** The tag call sites use for the component, such as `AppButton` or `UButton`. */
  component: string;
  /** The SFC that declares the contract, or that the config entry names when Doctor can find it. */
  file?: string;
  contract: ComponentContract;
  /** `component` for `defineOptions({ doctor })`, `config` for a Rule's `contracts` option. */
  declaredIn: "component" | "config";
  /** Where `doctor` is set in `file`, for `component` contracts. */
  range?: SourceRange;
}

/** A `doctor` option Doctor cannot turn into a Component Contract. */
export type UnreadableContract = {
  component: string;
  file: string;
  range: SourceRange;
  /** Why, as a sentence fragment that completes "Doctor cannot read it because …". */
  reason: string;
} & (
  | { cause: "computed" | "overridden" | "overridden-by-setup" }
  | { cause: "invalid"; remedy: string }
);

export interface ProjectContracts {
  contracts: DeclaredContract[];
  unreadable: UnreadableContract[];
}

type ContractProblem = { problem: string; remedy: string };
type KeyReader<T> = (value: unknown) => { value: T } | ContractProblem;

/**
 * How Doctor reads each key a Component Contract may set. A reader receives the key's literal
 * value, `undefined` when the contract omits it, and returns its normalized form or what is wrong.
 */
const CONTRACT_KEYS: { [Key in keyof ComponentContract]-?: KeyReader<ComponentContract[Key]> } = {
  replaces: readReplaces,
};
const TAG = /^[a-z][a-z0-9-]*$/;

/** The keys a Component Contract may set, in the order the docs list them. */
export function contractKeys(): string[] {
  return Object.keys(CONTRACT_KEYS);
}

/**
 * Turns one literal contract value into a Component Contract, or explains what is wrong with it.
 * Used for `defineOptions({ doctor })` values and for each entry of a Rule's `contracts` option.
 */
export function parseContract(value: unknown): { contract: ComponentContract } | ContractProblem {
  const keys = contractKeys();
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      problem: `it is not an object literal with Component Contract keys (${keys.join(", ")})`,
      remedy:
        "Replace the `doctor` value with an object literal using supported Component Contract keys.",
    };
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(CONTRACT_KEYS, key));
  if (unknown.length)
    return {
      problem: `it sets ${unknown.map((key) => `\`${key}\``).join(", ")}, which a Component Contract does not have (known keys: ${keys.join(", ")})`,
      remedy: `Remove the unrecognized ${unknown.length === 1 ? "key" : "keys"} or correct the spelling using the supported keys: ${keys.join(", ")}.`,
    };
  const contract: Partial<ComponentContract> = {};
  function readKey<Key extends keyof ComponentContract>(key: Key) {
    const result = CONTRACT_KEYS[key]((value as Record<string, unknown>)[key]);
    if ("problem" in result) return result;
    contract[key] = result.value;
  }
  for (const key of keys as Array<keyof ComponentContract>) {
    const problem = readKey(key);
    if (problem) return problem;
  }
  return { contract: contract as ComponentContract };
}

function readReplaces(replaces: unknown = []): { value: string[] } | ContractProblem {
  const elements = typeof replaces === "string" ? [replaces] : replaces;
  if (
    !Array.isArray(elements) ||
    !elements.every((element) => typeof element === "string" && TAG.test(element))
  )
    return {
      problem: '`replaces` is not a lowercase HTML tag name or an array of them, such as "button"',
      remedy:
        'Set `replaces` to the lowercase HTML tag you intend to replace, for example `"button"`, or list those tags in an array.',
    };
  return { value: [...new Set(elements as string[])] };
}

/**
 * Reads a Rule's `contracts` option: Component Contracts keyed by the tag call sites use. Throws
 * a message for DOC0020 when the option is malformed.
 */
export function parseContractOptions(contracts: unknown): Record<string, ComponentContract> {
  if (contracts === undefined) return {};
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts))
    throw new Error(
      '`contracts` must map component names to contracts such as { replaces: "button" }',
    );
  const parsed: Record<string, ComponentContract> = {};
  for (const [component, value] of Object.entries(contracts)) {
    const read = parseContract(value);
    if ("problem" in read)
      throw new Error(`\`contracts.${component}\` is not a Component Contract: ${read.problem}`);
    parsed[component] = read.contract;
  }
  return parsed;
}

/**
 * Every Component Contract in the Doctor Run: those SFCs declare with `defineOptions({ doctor })`,
 * then those `configContracts` declares for components the project does not own.
 */
export function projectContracts(
  graph: ComponentUsageGraph,
  names: ComponentNames,
  configContracts: Record<string, ComponentContract> = {},
): ProjectContracts {
  const contracts: DeclaredContract[] = [];
  const unreadable: UnreadableContract[] = [];
  for (const node of graph.components.values()) {
    const option: DoctorComponentOption | undefined = node.facts.doctorOption;
    if (!option) continue;
    const component = componentTag(node, names);
    if ("unreadable" in option) {
      unreadable.push({
        component,
        file: node.file,
        range: option.unreadable,
        reason:
          option.cause === "overridden"
            ? "a spread or computed key after it in the same options object can replace it at runtime"
            : option.cause === "overridden-by-setup"
              ? "the `defineOptions` argument can override the normal script’s `doctor` value at runtime"
              : "part of it is computed at runtime instead of written as a literal",
        cause: option.cause,
      });
      continue;
    }
    const read = parseContract(option.value);
    if ("problem" in read)
      unreadable.push({
        component,
        file: node.file,
        range: option.range,
        reason: read.problem,
        cause: "invalid",
        remedy: read.remedy,
      });
    else
      contracts.push({
        component,
        file: node.file,
        contract: read.contract,
        declaredIn: "component",
        range: option.range,
      });
  }
  for (const [component, contract] of Object.entries(configContracts)) {
    const file = componentFile(component, names, graph);
    contracts.push({ component, ...(file && { file }), contract, declaredIn: "config" });
  }
  return { contracts, unreadable };
}

/**
 * How a Doctor Run names components: `registered` holds the names Nuxt resolved (from the Nuxt
 * manifest), `nuxtDefault` the names Nuxt gives SFCs under `components/` by default, for Nuxt
 * projects Doctor has no manifest for.
 */
export interface ComponentNames {
  registered: ReadonlyMap<string, string>;
  nuxtDefault: ReadonlyMap<string, string>;
}

/** Component names for the project, each mapped to the absolute SFC path. */
export function componentNames(project: ProjectInfo, graph: ComponentUsageGraph): ComponentNames {
  const registered = new Map<string, string>();
  const nuxtDefault = new Map<string, string>();
  const nuxt = project.nuxt;
  if (!nuxt) return { registered, nuxtDefault };
  const absolute = (file: string) => (isAbsolute(file) ? file : resolve(project.root, file));
  for (const entry of nuxt.manifest?.resolvedComponents ?? [])
    if (entry.file.endsWith(".vue")) registered.set(entry.name, absolute(entry.file));
  for (const entry of nuxt.components.values())
    if (entry.file?.endsWith(".vue") && !registered.has(entry.name))
      registered.set(entry.name, absolute(entry.file));
  if (nuxt.manifest?.resolvedComponents || registered.size) return { registered, nuxtDefault };
  // shadcn-nuxt registers `components/ui` by export name, not by path.
  const shadcnNuxt = usesPackage(project, "shadcn-nuxt");
  const ambiguous = new Set<string>();
  for (const node of graph.components.values()) {
    if (node.sourceKind === "module" || (shadcnNuxt && isUiKitFile(node.file))) continue;
    const match = /(?:^|\/)components\/(.+\.vue)$/.exec(relative(project.root, node.file));
    const name = match && nuxtComponentName(match[1]!);
    if (!name) continue;
    if (nuxtDefault.has(name)) ambiguous.add(name);
    else nuxtDefault.set(name, node.file);
  }
  for (const name of ambiguous) nuxtDefault.delete(name);
  return { registered, nuxtDefault };
}

/** The SFC a component name refers to, when Doctor can tell. */
export function componentFile(
  name: string,
  names: ComponentNames,
  graph: ComponentUsageGraph,
): string | undefined {
  const registered = names.registered.get(name) ?? names.nuxtDefault.get(name);
  if (registered) return registered;
  const matches = [...graph.components.values()].filter((node) => fileTag(node.file) === name);
  return matches.length === 1 ? matches[0]?.file : undefined;
}

/**
 * The project's default tag for an SFC, independent of local import aliases.
 */
export function componentTag(node: ComponentNode, names: ComponentNames): string {
  for (const [name, file] of names.registered) if (file === node.file) return name;
  for (const [name, file] of names.nuxtDefault) if (file === node.file) return name;
  return fileTag(node.file);
}

/** The name Nuxt gives the component at `path`, relative to a `components/` directory. */
function nuxtComponentName(path: string): string {
  const directory = dirname(path);
  const prefixParts = directory === "." ? [] : splitByCase(directory);
  let fileName = basename(path, extname(path)).replace(/\.(client|server|island|global)$/, "");
  if (fileName.toLowerCase() === "index") fileName = "";
  const fileNameParts = splitByCase(fileName);
  const fileNameContent = fileNameParts.join("/").toLowerCase();
  const nameParts = [...prefixParts];
  const matched: string[] = [];
  for (let index = prefixParts.length - 1; index >= 0; index--) {
    matched.unshift(prefixParts[index]!.toLowerCase());
    const content = matched.join("/");
    if (fileNameContent === content || fileNameContent.startsWith(`${content}/`))
      nameParts.length = index;
  }
  return [...nameParts, ...fileNameParts]
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Whether any workspace package depends on `name`, or the Nuxt app installs it as a module. */
export function usesPackage(project: ProjectInfo, name: string): boolean {
  return (
    projectWorkspacePackages(project).some((item) => name in item.packages) ||
    !!project.nuxt?.modules?.some((module) => module.name === name)
  );
}

/** Whether a file sits in a `components/ui/` directory, where shadcn-style kits keep primitives. */
export function isUiKitFile(file: string): boolean {
  return /(?:^|\/)components\/ui\//.test(file);
}

function splitByCase(value: string): string[] {
  return value.split(/[\\/_.\-\s]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
}

function fileTag(file: string): string {
  return pascalCase(basename(file, extname(file)));
}

export function pascalCase(tag: string): string {
  const camel = tag.replace(/-(\w)/g, (_, char: string) => char.toUpperCase());
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}
