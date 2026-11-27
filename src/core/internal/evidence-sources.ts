import type { DoctorRunOptions } from "../config.js";
import type {
  EvidenceSource,
  EvidenceSourceOption,
  EvidenceSourceRun,
  ProjectInfo,
} from "../primitives.js";

export const REDACTED = "<redacted>";

export interface EvidenceSourceFlag {
  source: EvidenceSource;
  option: string;
  definition: EvidenceSourceOption;
  /** `--<source>-<option>`, kebab-case. */
  flag: string;
}

/** A source name becomes a CLI flag prefix and a Runtime Evidence key. */
export function assertEvidenceSourceNames(sources: readonly EvidenceSource[]): void {
  for (const { name } of sources) {
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw new Error(
        `Evidence Source name ${JSON.stringify(name)} must start with a lowercase letter and hold only lowercase letters, digits, and dashes, because it prefixes CLI flags.`,
      );
  }
}

export function evidenceSourceFlags(sources: readonly EvidenceSource[]): EvidenceSourceFlag[] {
  return sources.flatMap((source) =>
    Object.entries(source.options ?? {}).map(([option, definition]) => {
      const flag = `--${kebab(source.name)}-${kebab(option)}`;
      return { source, option, definition, flag };
    }),
  );
}

/**
 * Evidence Source inputs from parsed CLI flags, keyed by source name. Sources none of whose flags
 * were passed get no input, so they are not read.
 */
export function evidenceSourceInputs(
  declarations: readonly EvidenceSourceFlag[],
  flags: ReadonlyMap<string, string[]>,
): Record<string, unknown> | undefined {
  const bySource = new Map<EvidenceSource, Map<string, string[]>>();
  for (const { source, option, definition, flag } of declarations) {
    const list = flags.get(flag);
    if (!list) continue;
    if (list.includes("")) throw new Error(`${flag} requires a value.`);
    if (list.length > 1 && !definition.repeatable)
      throw new Error(`Option ${flag} may only be provided once.`);
    const values = bySource.get(source) ?? new Map<string, string[]>();
    values.set(option, list);
    bySource.set(source, values);
  }
  const inputs = new Map<string, unknown>();
  for (const [source, values] of bySource) {
    for (const [option] of values) {
      const required = source.options?.[option]?.requires;
      if (!required || values.has(required)) continue;
      const requiredFlag = `--${source.name}-${kebab(required)}`;
      const placeholder = source.options?.[required]?.value ?? "value";
      throw new Error(
        `--${source.name}-${kebab(option)} requires ${requiredFlag} <${placeholder}>.`,
      );
    }
    if (!source.fromOptions)
      throw new Error(`The "${source.name}" Evidence Source does not read CLI flags.`);
    inputs.set(source.name, source.fromOptions(Object.fromEntries(values)));
  }
  return inputs.size ? Object.fromEntries(inputs) : undefined;
}

type RequestedSource = { source: EvidenceSource; input: unknown };

export async function validateEvidenceSources(
  sources: readonly EvidenceSource[],
  inputs: DoctorRunOptions["sources"],
): Promise<RequestedSource[]> {
  const byName = new Map(sources.map((source) => [source.name, source]));
  const requested: RequestedSource[] = [];
  for (const [name, input] of Object.entries(inputs ?? {})) {
    if (input === undefined) continue;
    const source = byName.get(name);
    if (!source) {
      const known = [...byName.keys()];
      throw new Error(
        `No Doctor Extension provides the "${name}" Evidence Source${known.length ? `; registered sources: ${known.join(", ")}` : ""}.`,
      );
    }
    await source.validate?.(input);
    requested.push({ source, input });
  }
  return requested;
}

export async function collectEvidenceSources(
  project: ProjectInfo,
  requested: readonly RequestedSource[],
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<EvidenceSourceRun[]> {
  const runs: EvidenceSourceRun[] = [];
  for (const { source, input } of requested) {
    const { name } = source;
    const result = await source.collect(input, { project, fetch });
    project.runtimeEvidence = { ...project.runtimeEvidence, [name]: result.evidence };
    if (result.gaps?.length) {
      project.evidenceGaps = [
        ...(project.evidenceGaps ?? []),
        ...result.gaps.map((gap) => ({ source: name, files: [], ...gap })),
      ];
    }
    runs.push({
      name,
      label: source.label,
      targets: result.targets ?? [],
      args: sourceArgs(source, input),
    });
  }
  return runs;
}

function sourceArgs(source: EvidenceSource, input: unknown): string[] {
  const values = source.toOptions?.(input) ?? {};
  return evidenceSourceFlags([source]).flatMap(({ option, definition, flag }) =>
    (values[option] ?? []).flatMap((value) => {
      const displayed = redact(definition, value);
      return displayed.startsWith("-") ? [`${flag}=${displayed}`] : [flag, displayed];
    }),
  );
}

function redact(option: EvidenceSourceOption, value: string): string {
  if (typeof option.secret === "function") return option.secret(value, REDACTED);
  return option.secret ? REDACTED : value;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
