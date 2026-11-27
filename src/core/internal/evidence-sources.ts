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
  /** The key cac parses the flag into. */
  key: string;
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
      return { source, option, definition, flag, key: camel(flag.slice(2)) };
    }),
  );
}

/**
 * Evidence Source inputs from parsed CLI flags, keyed by source name. Sources none of whose flags
 * were passed get no input, so they are not read.
 */
export function evidenceSourceInputs(
  sources: readonly EvidenceSource[],
  flags: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const inputs: Record<string, unknown> = {};
  for (const source of sources) {
    const values: Record<string, string[]> = {};
    for (const entry of evidenceSourceFlags([source])) {
      const raw = flags[entry.key];
      if (raw === undefined) continue;
      const list = (Array.isArray(raw) ? raw : [raw]).map((value) => {
        if (value === true || value === false || value === "")
          throw new Error(`${entry.flag} requires a value.`);
        return String(value);
      });
      if (list.length > 1 && !entry.definition.repeatable)
        throw new Error(`Option ${entry.flag} may only be provided once.`);
      values[entry.option] = list;
    }
    if (!Object.keys(values).length) continue;
    for (const entry of evidenceSourceFlags([source])) {
      const required = entry.definition.requires;
      if (!required || !values[entry.option] || values[required]) continue;
      const requiredFlag = `--${kebab(source.name)}-${kebab(required)}`;
      const placeholder = source.options?.[required]?.value ?? "value";
      throw new Error(`${entry.flag} requires ${requiredFlag} <${placeholder}>.`);
    }
    if (!source.fromOptions)
      throw new Error(`The "${source.name}" Evidence Source does not read CLI flags.`);
    inputs[source.name] = source.fromOptions(values);
  }
  return Object.keys(inputs).length ? inputs : undefined;
}

/**
 * Reads every Evidence Source the run has an input for into Runtime Evidence, after validating
 * all inputs, so a bad input fails the run before any request.
 */
export async function collectEvidenceSources(
  project: ProjectInfo,
  sources: readonly EvidenceSource[],
  options: Pick<DoctorRunOptions, "sources" | "fetch">,
  contributeRuntimeEvidence: () => Promise<void>,
): Promise<EvidenceSourceRun[]> {
  const byName = new Map(sources.map((source) => [source.name, source]));
  const requested = Object.entries(options.sources ?? {}).flatMap(([name, input]) => {
    if (input === undefined) return [];
    const source = byName.get(name);
    if (!source) {
      const known = [...byName.keys()];
      throw new Error(
        `No Doctor Extension provides the "${name}" Evidence Source${known.length ? `; registered sources: ${known.join(", ")}` : ""}.`,
      );
    }
    source.validate?.(input);
    return [{ source, input }];
  });
  const fetch: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  async function collect(source: EvidenceSource, input: unknown): Promise<EvidenceSourceRun> {
    const { name } = source;
    const result = await source.collect(input, { project, fetch });
    project.runtimeEvidence = { ...project.runtimeEvidence, [name]: result.evidence };
    if (result.gaps?.length) {
      project.evidenceGaps = [
        ...(project.evidenceGaps ?? []),
        ...result.gaps.map((gap) => ({ source: name, files: [], ...gap })),
      ];
    }
    return {
      name,
      label: source.label,
      targets: result.targets ?? [],
      args: sourceArgs(source, input),
    };
  }
  const earlyRuns = new Map<string, EvidenceSourceRun>();
  for (const { source, input } of requested) {
    if (source.beforeRuntimeEvidence) earlyRuns.set(source.name, await collect(source, input));
  }
  await contributeRuntimeEvidence();
  const runs: EvidenceSourceRun[] = [];
  for (const { source, input } of requested) {
    runs.push(earlyRuns.get(source.name) ?? (await collect(source, input)));
  }
  return runs;
}

function sourceArgs(source: EvidenceSource, input: unknown): string[] {
  const values = source.toOptions?.(input) ?? {};
  return evidenceSourceFlags([source]).flatMap(({ option, definition, flag }) =>
    (values[option] ?? []).flatMap((value) => [flag, redact(definition, value)]),
  );
}

function redact(option: EvidenceSourceOption, value: string): string {
  if (typeof option.secret === "function") return option.secret(value, REDACTED);
  return option.secret ? REDACTED : value;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function camel(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}
