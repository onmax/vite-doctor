import type { DoctorRule, RulePrefilter, SourceFileHandle } from "../primitives.js";
import { namePattern } from "./name-pattern.js";

interface CompiledPrefilter {
  calls?: ReadonlySet<string>;
  imports?: ReadonlySet<string>;
  names?: RegExp;
}

const compiled = new WeakMap<RulePrefilter, CompiledPrefilter>();

/** False only when the file's facts and text prove that the Rule cannot match it. */
export function canMatchPrefilter(rule: DoctorRule, file: SourceFileHandle): boolean {
  const prefilter = rule.meta.prefilter;
  if (!prefilter) return true;
  const { calls, imports, names } = compile(prefilter);
  if (!calls && !imports && !names) return true;
  const facts = file.facts;
  if (calls && (!facts || facts.calls.some((call) => calls.has(call.name)))) return true;
  if (imports && (!facts || facts.imports.some((fact) => imports.has(fact.source)))) return true;
  return names !== undefined && names.test(file.text);
}

function compile(prefilter: RulePrefilter): CompiledPrefilter {
  let entry = compiled.get(prefilter);
  if (!entry) {
    entry = {
      calls: prefilter.calls?.length ? new Set(prefilter.calls) : undefined,
      imports: prefilter.imports?.length ? new Set(prefilter.imports) : undefined,
      names: prefilter.names?.length ? namePattern(prefilter.names) : undefined,
    };
    compiled.set(prefilter, entry);
  }
  return entry;
}
