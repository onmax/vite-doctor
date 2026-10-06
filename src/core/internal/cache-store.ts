import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Diagnostic as NosticsDiagnostic } from "nostics";
import { resolve } from "pathe";
import type { Diagnostic, FileFacts, ProjectInfo } from "../primitives.js";
import type { RuleInputs } from "./rule-inputs.js";
import type { SourceInventoryMemo } from "./source-inventory.js";
import { sha256 } from "./utils.js";

export const CACHE_STORE_FILE = "store.json";
const CACHE_STORE_VERSION = 2;
// A file modified within one timestamp tick of when Doctor recorded its signature can change again
// without changing its signature, so such a signature is not trusted. File systems that keep
// whole-second times can tick every 2 s; others take times from a coarse clock that ticks in ms.
const COARSE_RACY_SIGNATURE_MS = 2000;
const RACY_SIGNATURE_MS = 100;
const ANALYSIS_PACKAGES = [
  "oxc-parser",
  "@vue/compiler-sfc",
  "vue-eslint-parser",
  "@typescript-eslint/parser",
  "eslint",
  "eslint-plugin-vue",
  "typescript",
  "@shadcn/lint",
];

export type EvidenceGap = NonNullable<ProjectInfo["evidenceGaps"]>[number];

/** size, mtimeMs, ctimeMs, ino, recordedAt, content hash ("" when only the header was read) */
type Signature = [number, number, number, number, number, string];

type StoredDiagnostic = Omit<Diagnostic, "diagnostic"> & {
  diagnostic: { code: string; why: string; fix?: string; docs?: string; sources?: string[] };
};

/** Diagnostics a Rule reported and the Rule inputs (indexes into `inputs`) it read. */
interface StoredRuleResult {
  d?: StoredDiagnostic[];
  i?: number[];
}

interface StoredFile {
  hash: string;
  /** Inventory identity: display path, source kind, and module name. */
  entry: string;
  /** Bit 1: SFC, bit 2: script AST, bit 4: template AST. */
  shape: number;
  gaps?: EvidenceGap[];
  /** Index into `ruleSets`: Rules that reported nothing and read no other input. */
  rs?: number;
  /** Rule key index to a result with Diagnostics or Rule inputs. */
  r?: Record<string, StoredRuleResult>;
}

export interface GraphSummary {
  files: number;
  importEdges: number;
  exportEdges: number;
  virtualRoots: number;
  cycles: number;
}

export interface CacheRunStats {
  at: number;
  files: number;
  filesRead: number;
  filesParsed: number;
  ruleResultsReused: number;
  ruleResultsComputed: number;
  ruleResultsUncacheable: number;
  graphReused: boolean;
}

interface StoreIndex {
  version: number;
  engine: string;
  writtenAt: number;
  ruleKeys: string[];
  ruleSets: number[][];
  inputs: Array<[string, string]>;
  signatures: Record<string, Signature>;
  files: Record<string, StoredFile>;
  runs: Record<string, StoredRuleResult>;
  graph?: { key: string; i: number[]; summary: GraphSummary };
  /** Source inventory walk selections keyed by the walk listing and patterns. */
  walks?: Record<string, string[]>;
  /** Signatures of files skipped because their header marks them as generated. */
  generated?: Record<string, Signature>;
  lastWrite?: CacheRunStats;
}

type StoredFacts = Omit<FileFacts, "fileId">;

export interface CachedFile {
  shape: number;
  gaps: EvidenceGap[];
  facts(): StoredFacts | undefined;
}

export interface CacheStatus {
  path: string;
  exists: boolean;
  bytes: number;
  version?: number;
  compatible: boolean;
  writtenAt?: string;
  files: number;
  ruleResults: { file: number; run: number };
  inputs: number;
  graph: boolean;
  lastWrite?: CacheRunStats;
}

/**
 * The persistent Doctor cache for one Doctor Run, stored as one packed file. Line one is the
 * index (file signatures, Rule results, Rule inputs); line two holds File Facts and is parsed
 * only when the run needs facts it did not compute itself.
 */
export class DoctorCache implements SourceInventoryMemo {
  readonly enabled: boolean;
  private readonly root: string;
  private readonly dir: string;
  private readonly engine: string;
  private readonly startedAt = Date.now();
  private loaded: StoreIndex | undefined;
  private loadedFactsText: string | undefined;
  private loadedFacts: Record<string, StoredFacts> | undefined;
  private readonly loadedRuleKeys = new Map<string, number>();
  private readonly ruleKeys = new Map<string, number>();
  private readonly inputs = new Map<string, number>();
  private readonly signatures: Record<string, Signature> = {};
  private readonly files: Record<string, StoredFile> = {};
  private readonly facts: Record<string, StoredFacts> = {};
  private readonly runs: Record<string, StoredRuleResult> = {};
  private readonly emptyRules = new Map<string, Set<number>>();
  private graphEntry: StoreIndex["graph"];
  private readonly walks: Record<string, string[]> = {};
  private readonly generated: Record<string, Signature> = {};
  private readonly validInputs = new Map<number, boolean>();
  private readonly statCache = new Map<string, Stats | undefined>();
  private readonly hashCache = new Map<string, string>();
  private inputValue: (id: string) => string = () => "-";
  private dirty = false;
  private factsDirty = false;
  private readonly stats: CacheRunStats = {
    at: 0,
    files: 0,
    filesRead: 0,
    filesParsed: 0,
    ruleResultsReused: 0,
    ruleResultsComputed: 0,
    ruleResultsUncacheable: 0,
    graphReused: false,
  };

  constructor(root: string, dir: string, enabled: boolean) {
    this.enabled = enabled;
    this.root = resolve(root);
    this.dir = dir;
    this.engine = enabled ? engineIdentity() : "";
    if (!enabled) return;
    assertCachePath(this.root, this.dir);
    let loaded: ReturnType<typeof readStore>;
    try {
      loaded = readStore(this.storePath());
    } catch {
      // A store path that escapes the project root is never read; the write path refuses it too.
      loaded = undefined;
    }
    if (loaded?.index.engine === this.engine) {
      this.loaded = loaded.index;
      this.loadedFactsText = loaded.factsText;
      loaded.index.ruleKeys.forEach((key, index) => this.loadedRuleKeys.set(key, index));
    }
  }

  /** Binds Rule input validation to the run's view of the file system. */
  bindInputs(inputs: RuleInputs, sourceHash: (path: string) => string | undefined): void {
    this.inputValue = (id) =>
      ruleInputValue(id, inputs, (path) => sourceHash(path) ?? this.textHash(path, inputs));
  }

  selected(key: string): readonly string[] | undefined {
    const files = this.loaded?.walks?.[key];
    if (!Array.isArray(files)) return undefined;
    this.walks[key] = files;
    return files;
  }

  rememberSelected(key: string, files: string[]): void {
    if (!this.enabled) return;
    this.walks[key] = files;
    this.dirty = true;
  }

  /** A file keeps its generated-header verdict while its signature is unchanged. */
  authored(path: string): boolean | undefined {
    const stats = this.stat(path);
    if (!stats?.isFile()) return undefined;
    const generated = this.loaded?.generated?.[path];
    if (generated && matches(generated, stats)) {
      this.generated[path] = generated;
      return false;
    }
    const signature = this.loaded?.signatures[path];
    if (signature && this.loaded?.files[path] && matches(signature, stats)) return true;
    return undefined;
  }

  rememberAuthored(path: string, authored: boolean): void {
    if (!this.enabled || authored) return;
    const stats = this.stat(path);
    if (!stats) return;
    this.generated[path] = [
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
      stats.ino,
      this.startedAt,
      "",
    ];
    this.dirty = true;
  }

  /** Content hash of a project file. The file is read only when its signature changed. */
  fileHash(path: string): { hash: string; text?: string } | undefined {
    const stats = this.stat(path);
    if (!stats?.isFile()) return undefined;
    const previous = this.loaded?.signatures[path];
    if (previous && matches(previous, stats)) {
      this.signatures[path] = previous;
      return { hash: previous[5] };
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    const hash = sha256(text);
    this.stats.filesRead++;
    if (this.enabled) this.recordSignature(path, stats, hash, previous);
    return { hash, text };
  }

  /** Shape, parser evidence, and File Facts of a file whose content a run already analyzed. */
  file(path: string, hash: string, entry: string): CachedFile | undefined {
    const stored = this.loaded?.files[path];
    if (
      stored?.hash !== hash ||
      stored.entry !== entry ||
      typeof stored.shape !== "number" ||
      (stored.gaps !== undefined && !isEvidenceGaps(stored.gaps))
    )
      return undefined;
    this.files[path] = {
      hash,
      entry,
      shape: stored.shape,
      ...(stored.gaps ? { gaps: stored.gaps } : {}),
    };
    return {
      shape: stored.shape,
      gaps: stored.gaps ?? [],
      facts: () => {
        const facts = this.loadedFactsSection()[path];
        if (facts?.fileHash !== hash) return undefined;
        this.facts[path] = facts;
        return facts;
      },
    };
  }

  recordFile(
    path: string,
    hash: string,
    entry: string,
    shape: number,
    gaps: readonly EvidenceGap[],
    facts: FileFacts,
  ): void {
    this.stats.filesParsed++;
    if (!this.enabled) return;
    this.files[path] = { hash, entry, shape, ...(gaps.length ? { gaps: [...gaps] } : {}) };
    const { fileId: _fileId, ...stored } = facts;
    this.facts[path] = stored;
    this.dirty = true;
    this.factsDirty = true;
  }

  /**
   * Diagnostics of a Rule for one file (`scope` is the file path) or for the run, when every
   * Rule input it read is unchanged.
   */
  ruleResult(scope: string | undefined, ruleKey: string): Diagnostic[] | undefined {
    const loaded = this.loaded;
    const index = this.loadedRuleKeys.get(ruleKey);
    if (!loaded || index === undefined) return undefined;
    let stored: StoredRuleResult | undefined;
    if (scope === undefined) stored = loaded.runs[index];
    else {
      const file = loaded.files[scope];
      const current = this.files[scope];
      if (!file || current?.hash !== file.hash || current.entry !== file.entry) return undefined;
      stored = file.r?.[index];
      if (!stored && file.rs !== undefined && loaded.ruleSets[file.rs]?.includes(index))
        stored = {};
    }
    if (!stored) return undefined;
    for (const input of stored.i ?? []) if (!this.inputValid(input)) return undefined;
    this.stats.ruleResultsReused++;
    this.storeResult(scope, ruleKey, stored.d, this.loadedInputIds(stored.i));
    return (stored.d ?? []).map(reviveDiagnostic);
  }

  recordRuleResult(
    scope: string | undefined,
    ruleKey: string,
    diagnostics: readonly Diagnostic[],
    inputs: readonly string[],
  ): void {
    const stored = serializeDiagnostics(diagnostics);
    if (!stored) {
      this.stats.ruleResultsUncacheable++;
      return;
    }
    this.stats.ruleResultsComputed++;
    if (!this.enabled) return;
    this.storeResult(scope, ruleKey, stored, inputs);
    this.dirty = true;
  }

  recordUncacheable(): void {
    this.stats.ruleResultsUncacheable++;
  }

  graph(key: string): GraphSummary | undefined {
    const stored = this.loaded?.graph;
    if (stored?.key !== key) return undefined;
    for (const input of stored.i) if (!this.inputValid(input)) return undefined;
    this.graphEntry = {
      key,
      i: this.loadedInputIds(stored.i).map((id) => this.internInput(id)),
      summary: stored.summary,
    };
    this.stats.graphReused = true;
    return stored.summary;
  }

  recordGraph(key: string, summary: GraphSummary, inputs: readonly string[]): void {
    if (!this.enabled) return;
    this.graphEntry = { key, i: inputs.map((input) => this.internInput(input)), summary };
    const loaded = this.loaded?.graph;
    if (
      loaded?.key !== key ||
      JSON.stringify(loaded.summary) !== JSON.stringify(summary) ||
      JSON.stringify(this.loadedInputIds(loaded.i)) !== JSON.stringify(inputs) ||
      !loaded.i.every((input) => this.inputValid(input))
    )
      this.dirty = true;
  }

  runStats(): Readonly<CacheRunStats> {
    return this.stats;
  }

  /**
   * Writes the store when the run changed it. Partial runs keep entries for files they did not
   * see; runs of a Rule subset keep the results of every Rule outside `activeRuleKeys`.
   */
  persist({
    prune,
    files,
    activeRuleKeys,
  }: {
    prune: boolean;
    files: number;
    activeRuleKeys?: ReadonlySet<string>;
  }): void {
    if (!this.enabled) return;
    this.stats.at = this.startedAt;
    this.stats.files = files;
    const loaded = this.loaded;
    if (loaded && activeRuleKeys) this.keepInactiveResults(loaded, activeRuleKeys);
    if (!loaded) this.dirty = true;
    else {
      if (!prune) this.mergeUntouched(loaded);
      if (
        prune &&
        (Object.keys(loaded.files).some((path) => !this.files[path]) ||
          Object.keys(loaded.signatures).some((path) => !this.signatures[path]) ||
          Object.keys(loaded.runs).length !== Object.keys(this.runs).length ||
          Boolean(loaded.graph) !== Boolean(this.graphEntry) ||
          Object.keys(loaded.walks ?? {}).some((key) => !this.walks[key]) ||
          Object.keys(loaded.generated ?? {}).some((path) => !this.generated[path]))
      )
        this.dirty = true;
    }
    if (!this.dirty) return;
    let temporary: string | undefined;
    let lock: { fd: number; path: string } | undefined;
    try {
      const index = JSON.stringify(this.buildIndex());
      const facts = this.factsSection();
      mkdirSync(this.dir, { recursive: true });
      lock = acquireStoreLock(this.root, this.dir);
      temporary = resolve(this.dir, `.doctor-${randomUUID()}.tmp`);
      assertCachePath(this.root, temporary);
      writeFileSync(temporary, `${index}\n${facts}`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.storePath());
      temporary = undefined;
    } catch (error) {
      if (error instanceof LegacyStoreLockError) console.warn(error.message);
      // Cache writes are best-effort and must not change Diagnostics.
    } finally {
      if (temporary) {
        try {
          rmSync(temporary, { force: true });
        } catch {}
      }
      if (lock) releaseStoreLock(lock);
    }
  }

  private keepInactiveResults(loaded: StoreIndex, active: ReadonlySet<string>): void {
    const keep = (scope: string | undefined, index: number, result: StoredRuleResult) => {
      const key = loaded.ruleKeys[index];
      if (key === undefined || active.has(key)) return;
      this.storeResult(scope, key, result.d, this.loadedInputIds(result.i));
    };
    for (const [path, file] of Object.entries(loaded.files)) {
      if (this.files[path]?.hash !== file.hash || this.files[path]?.entry !== file.entry) continue;
      for (const index of file.rs === undefined ? [] : (loaded.ruleSets[file.rs] ?? []))
        keep(path, index, {});
      for (const [index, result] of Object.entries(file.r ?? {})) keep(path, Number(index), result);
    }
    for (const [index, result] of Object.entries(loaded.runs))
      keep(undefined, Number(index), result);
  }

  private mergeUntouched(loaded: StoreIndex): void {
    for (const [key, files] of Object.entries(loaded.walks ?? {})) this.walks[key] ??= files;
    for (const [path, signature] of Object.entries(loaded.generated ?? {}))
      this.generated[path] ??= signature;
    for (const [path, signature] of Object.entries(loaded.signatures))
      this.signatures[path] ??= signature;
    for (const [path, file] of Object.entries(loaded.files)) {
      if (this.files[path]) continue;
      this.files[path] = {
        hash: file.hash,
        entry: file.entry,
        shape: file.shape,
        ...(file.gaps ? { gaps: file.gaps } : {}),
      };
      for (const index of file.rs === undefined ? [] : (loaded.ruleSets[file.rs] ?? []))
        this.storeResult(path, loaded.ruleKeys[index]!, undefined, []);
      for (const [index, result] of Object.entries(file.r ?? {}))
        this.storeResult(
          path,
          loaded.ruleKeys[Number(index)]!,
          result.d,
          this.loadedInputIds(result.i),
        );
      const facts = this.loadedFactsSection()[path];
      if (facts) this.facts[path] = facts;
    }
    for (const [index, result] of Object.entries(loaded.runs)) {
      const key = loaded.ruleKeys[Number(index)]!;
      if (this.runs[this.internRuleKey(key)]) continue;
      this.storeResult(undefined, key, result.d, this.loadedInputIds(result.i));
    }
    if (!this.graphEntry && loaded.graph)
      this.graphEntry = {
        ...loaded.graph,
        i: this.loadedInputIds(loaded.graph.i).map((id) => this.internInput(id)),
      };
  }

  private storeResult(
    scope: string | undefined,
    ruleKey: string,
    diagnostics: StoredDiagnostic[] | undefined,
    inputs: readonly string[],
  ): void {
    const index = this.internRuleKey(ruleKey);
    const result: StoredRuleResult = {
      ...(diagnostics?.length ? { d: diagnostics } : {}),
      ...(inputs.length ? { i: inputs.map((input) => this.internInput(input)) } : {}),
    };
    if (scope === undefined) {
      this.runs[index] = result;
      return;
    }
    const file = this.files[scope];
    if (!file) return;
    if (!result.d && !result.i) {
      let empty = this.emptyRules.get(scope);
      if (!empty) this.emptyRules.set(scope, (empty = new Set()));
      empty.add(index);
      return;
    }
    (file.r ??= {})[index] = result;
  }

  private buildIndex(): StoreIndex {
    const sets = new Map<string, number>();
    const ruleSets: number[][] = [];
    for (const [path, empty] of this.emptyRules) {
      const file = this.files[path];
      if (!file) continue;
      const set = [...empty].sort((left, right) => left - right);
      const key = set.join(",");
      let index = sets.get(key);
      if (index === undefined) {
        index = ruleSets.length;
        ruleSets.push(set);
        sets.set(key, index);
      }
      file.rs = index;
    }
    return {
      version: CACHE_STORE_VERSION,
      engine: this.engine,
      writtenAt: Date.now(),
      ruleKeys: [...this.ruleKeys.keys()],
      ruleSets,
      inputs: [...this.inputs.keys()].map((id) => [id, this.inputValue(id)]),
      signatures: this.signatures,
      files: this.files,
      runs: this.runs,
      ...(this.graphEntry ? { graph: this.graphEntry } : {}),
      walks: this.walks,
      generated: this.generated,
      lastWrite: this.stats,
    };
  }

  private factsSection(): string {
    const paths = Object.keys(this.files);
    const loaded = this.loaded;
    if (
      !this.factsDirty &&
      this.loadedFactsText !== undefined &&
      loaded &&
      paths.length === Object.keys(loaded.files).length &&
      paths.every((path) => loaded.files[path]?.hash === this.files[path]!.hash)
    )
      return this.loadedFactsText;
    const facts: Record<string, StoredFacts> = {};
    for (const path of paths) {
      const stored = this.facts[path] ?? this.loadedFactsSection()[path];
      if (stored?.fileHash === this.files[path]!.hash) facts[path] = stored;
    }
    return JSON.stringify(facts);
  }

  private loadedFactsSection(): Record<string, StoredFacts> {
    if (this.loadedFacts) return this.loadedFacts;
    try {
      const parsed: unknown = this.loadedFactsText ? JSON.parse(this.loadedFactsText) : {};
      this.loadedFacts = isRecord(parsed) ? (parsed as Record<string, StoredFacts>) : {};
    } catch {
      this.loadedFacts = {};
    }
    return this.loadedFacts;
  }

  private loadedInputIds(indexes: readonly number[] | undefined): string[] {
    return (indexes ?? []).map((index) => this.loaded!.inputs[index]![0]);
  }

  private inputValid(index: number): boolean {
    let valid = this.validInputs.get(index);
    if (valid === undefined) {
      const entry = this.loaded?.inputs[index];
      valid = entry !== undefined && this.inputValue(entry[0]) === entry[1];
      this.validInputs.set(index, valid);
    }
    return valid;
  }

  private textHash(path: string, inputs: RuleInputs): string {
    let hash = this.hashCache.get(path);
    if (hash !== undefined) return hash;
    const stats = this.stat(path);
    const previous = this.loaded?.signatures[path];
    if (!inputs.hasText(path) && stats?.isFile() && previous && matches(previous, stats)) {
      hash = previous[5];
      this.signatures[path] = previous;
    } else {
      hash = textDigest(inputs.text(path));
      if (stats?.isFile() && hash !== "-" && this.enabled)
        this.recordSignature(path, stats, hash, previous);
    }
    this.hashCache.set(path, hash);
    return hash;
  }

  private recordSignature(path: string, stats: Stats, hash: string, previous?: Signature): void {
    const signature: Signature = [
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
      stats.ino,
      this.startedAt,
      hash,
    ];
    this.signatures[path] = signature;
    // Refreshing only the recording time of a racy signature is not worth a store write.
    if (!previous || previous.some((value, index) => index !== 4 && value !== signature[index]))
      this.dirty = true;
    else this.signatures[path] = previous;
  }

  private stat(path: string): Stats | undefined {
    if (this.statCache.has(path)) return this.statCache.get(path);
    let stats: Stats | undefined;
    try {
      stats = statSync(path, { throwIfNoEntry: false });
    } catch {
      stats = undefined;
    }
    this.statCache.set(path, stats);
    return stats;
  }

  private internRuleKey(key: string): number {
    let index = this.ruleKeys.get(key);
    if (index === undefined) {
      index = this.ruleKeys.size;
      this.ruleKeys.set(key, index);
    }
    return index;
  }

  private internInput(id: string): number {
    let index = this.inputs.get(id);
    if (index === undefined) {
      index = this.inputs.size;
      this.inputs.set(id, index);
    }
    return index;
  }

  private storePath(): string {
    const path = resolve(this.dir, CACHE_STORE_FILE);
    assertCachePath(this.root, path);
    return path;
  }
}

export function readCacheStatus(root: string, dir: string): CacheStatus {
  assertCacheDirectory(resolve(root), dir);
  const path = resolve(dir, CACHE_STORE_FILE);
  const status: CacheStatus = {
    path,
    exists: false,
    bytes: 0,
    compatible: false,
    files: 0,
    ruleResults: { file: 0, run: 0 },
    inputs: 0,
    graph: false,
  };
  try {
    status.bytes = statSync(path).size;
    status.exists = true;
  } catch {
    return status;
  }
  const store = readStore(path);
  if (!store) return status;
  const { index } = store;
  let fileResults = 0;
  for (const file of Object.values(index.files)) {
    fileResults += Object.keys(file.r ?? {}).length;
    if (file.rs !== undefined) fileResults += index.ruleSets[file.rs]?.length ?? 0;
  }
  return {
    ...status,
    version: index.version,
    compatible: index.engine === engineIdentity(),
    writtenAt: new Date(index.writtenAt).toISOString(),
    files: Object.keys(index.files).length,
    ruleResults: { file: fileResults, run: Object.keys(index.runs).length },
    inputs: index.inputs.length,
    graph: Boolean(index.graph),
    ...(index.lastWrite ? { lastWrite: index.lastWrite } : {}),
  };
}

function readStore(path: string): { index: StoreIndex; factsText: string } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const newline = text.indexOf("\n");
  try {
    const index: unknown = JSON.parse(newline === -1 ? text : text.slice(0, newline));
    if (!isStoreIndex(index)) return undefined;
    return { index, factsText: newline === -1 ? "{}" : text.slice(newline + 1) };
  } catch {
    return undefined;
  }
}

function isStoreIndex(value: unknown): value is StoreIndex {
  if (
    !isRecord(value) ||
    value.version !== CACHE_STORE_VERSION ||
    typeof value.engine !== "string" ||
    !isTimestamp(value.writtenAt) ||
    !Array.isArray(value.ruleKeys) ||
    !value.ruleKeys.every((key) => typeof key === "string") ||
    !Array.isArray(value.ruleSets) ||
    !Array.isArray(value.inputs) ||
    !value.inputs.every(
      (input) =>
        Array.isArray(input) &&
        input.length === 2 &&
        input.every((part) => typeof part === "string"),
    ) ||
    !isRecord(value.signatures) ||
    !Object.values(value.signatures).every((signature) => isSignature(signature)) ||
    !isRecord(value.files) ||
    !isRecord(value.runs)
  )
    return false;

  const ruleKeys = value.ruleKeys as string[];
  const ruleSets = value.ruleSets as unknown[];
  const inputs = value.inputs as unknown[];
  const files = value.files as Record<string, unknown>;
  const runs = value.runs as Record<string, unknown>;
  const ruleCount = ruleKeys.length;
  if (!ruleSets.every((set) => isIndexArray(set, ruleCount))) return false;
  if (
    !Object.values(files).every((file) =>
      isStoredFile(file, ruleCount, ruleSets.length, inputs.length),
    )
  )
    return false;
  if (!Object.values(runs).every((result) => isStoredRuleResult(result, inputs.length)))
    return false;
  if (value.graph !== undefined && !isGraphEntry(value.graph, inputs.length)) return false;
  if (
    value.walks !== undefined &&
    (!isRecord(value.walks) ||
      !Object.values(value.walks).every(
        (files) => Array.isArray(files) && files.every((file) => typeof file === "string"),
      ))
  )
    return false;
  if (
    value.generated !== undefined &&
    (!isRecord(value.generated) ||
      !Object.values(value.generated).every((signature) => isSignature(signature, true)))
  )
    return false;
  return value.lastWrite === undefined || isCacheRunStats(value.lastWrite);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTimestamp(value: unknown): value is number {
  return finite(value) && Math.abs(value) <= 8.64e15;
}

function isContentHash(value: unknown, allowEmpty = false): value is string {
  return (
    (allowEmpty && value === "") || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  );
}

function isSignature(value: unknown, allowEmpty = false): value is Signature {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.slice(0, 5).every(finite) &&
    isContentHash(value[5], allowEmpty)
  );
}

function isIndexArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((index) => Number.isInteger(index) && index >= 0 && index < length)
  );
}

function isStoredDiagnostic(value: unknown): value is StoredDiagnostic {
  if (!isRecord(value) || !isRecord(value.diagnostic)) return false;
  const diagnostic = value.diagnostic;
  return (
    typeof diagnostic.code === "string" &&
    typeof diagnostic.why === "string" &&
    typeof value.code === "string" &&
    typeof value.why === "string" &&
    typeof value.ruleId === "string" &&
    typeof value.severity === "string" &&
    typeof value.category === "string" &&
    typeof value.message === "string" &&
    typeof value.file === "string" &&
    (diagnostic.fix === undefined || typeof diagnostic.fix === "string") &&
    (diagnostic.docs === undefined || typeof diagnostic.docs === "string") &&
    (diagnostic.sources === undefined ||
      (Array.isArray(diagnostic.sources) &&
        diagnostic.sources.every((source) => typeof source === "string")))
  );
}

function isStoredRuleResult(value: unknown, inputCount: number): value is StoredRuleResult {
  return (
    isRecord(value) &&
    (value.d === undefined || (Array.isArray(value.d) && value.d.every(isStoredDiagnostic))) &&
    (value.i === undefined || isIndexArray(value.i, inputCount))
  );
}

function isStoredFile(
  value: unknown,
  ruleCount: number,
  ruleSetCount: number,
  inputCount: number,
): value is StoredFile {
  return (
    isRecord(value) &&
    typeof value.hash === "string" &&
    isContentHash(value.hash) &&
    value.hash.length === 64 &&
    typeof value.entry === "string" &&
    finite(value.shape) &&
    (value.gaps === undefined || isEvidenceGaps(value.gaps)) &&
    (value.rs === undefined ||
      (typeof value.rs === "number" &&
        Number.isInteger(value.rs) &&
        value.rs >= 0 &&
        value.rs < ruleSetCount)) &&
    (value.r === undefined ||
      (isRecord(value.r) &&
        Object.entries(value.r).every(
          ([index, result]) =>
            Number.isInteger(Number(index)) &&
            Number(index) >= 0 &&
            Number(index) < ruleCount &&
            isStoredRuleResult(result, inputCount),
        )))
  );
}

function isGraphEntry(value: unknown, inputCount: number): value is StoreIndex["graph"] {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    !isIndexArray(value.i, inputCount) ||
    !isRecord(value.summary)
  )
    return false;
  const summary = value.summary;
  return ["files", "importEdges", "exportEdges", "virtualRoots", "cycles"].every((key) =>
    finite(summary[key]),
  );
}

function isCacheRunStats(value: unknown): value is CacheRunStats {
  return (
    isRecord(value) &&
    [
      "at",
      "files",
      "filesRead",
      "filesParsed",
      "ruleResultsReused",
      "ruleResultsComputed",
      "ruleResultsUncacheable",
    ].every((key) => finite(value[key])) &&
    typeof value.graphReused === "boolean"
  );
}

function isEvidenceGaps(value: unknown): value is EvidenceGap[] {
  return (
    Array.isArray(value) &&
    value.every(
      (gap) =>
        isRecord(gap) &&
        typeof gap.source === "string" &&
        typeof gap.message === "string" &&
        Array.isArray(gap.files) &&
        gap.files.every((file) => typeof file === "string"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(signature: Signature, stats: Stats): boolean {
  return (
    signature[0] === stats.size &&
    signature[1] === stats.mtimeMs &&
    signature[2] === stats.ctimeMs &&
    signature[3] === stats.ino &&
    !isRacy(signature)
  );
}

function isRacy(signature: Signature): boolean {
  const coarse = signature[1] % 1000 === 0 && signature[2] % 1000 === 0;
  const window = coarse ? COARSE_RACY_SIGNATURE_MS : RACY_SIGNATURE_MS;
  return Math.max(signature[1], signature[2]) + window > signature[4];
}

function textDigest(text: string | undefined): string {
  return text === undefined ? "-" : sha256(text);
}

function ruleInputValue(
  id: string,
  inputs: RuleInputs,
  textHash: (path: string) => string,
): string {
  const target = id.slice(2);
  switch (id[0]) {
    case "t":
      return textHash(target);
    case "e":
      return inputs.entry(target)?.kind ?? "-";
    case "z":
      return String(inputs.entry(target)?.size ?? "-");
    case "d": {
      const entries = inputs.dir(target);
      if (!entries) return "-";
      return sha256(
        entries
          .map((entry) => {
            const kind = entry.isFile()
              ? "f"
              : entry.isDirectory()
                ? "d"
                : entry.isSymbolicLink()
                  ? "l"
                  : "o";
            return `${kind}${entry.name}`;
          })
          .join("/"),
      );
    }
    case "r":
      return inputs.realpath(target) ?? "-";
    case "g":
      return sha256(inputs.glob(target).join("\0"));
    default:
      return `unknown:${randomUUID()}`;
  }
}

function serializeDiagnostics(diagnostics: readonly Diagnostic[]): StoredDiagnostic[] | undefined {
  const stored: StoredDiagnostic[] = [];
  for (const item of diagnostics) {
    const nostics = item.diagnostic;
    if (nostics.cause !== undefined) return undefined;
    stored.push({
      ...item,
      diagnostic: {
        code: nostics.code,
        why: nostics.why,
        ...(nostics.fix === undefined ? {} : { fix: nostics.fix }),
        ...(nostics.docs === undefined ? {} : { docs: nostics.docs }),
        ...(nostics.sources === undefined ? {} : { sources: nostics.sources }),
      },
    });
  }
  return stored;
}

function reviveDiagnostic(stored: StoredDiagnostic): Diagnostic {
  return { ...stored, diagnostic: new NosticsDiagnostic(stored.diagnostic) };
}

let engine: string | undefined;

/** Identifies the analysis code, so a store written by another build or dependency set is ignored. */
export function engineIdentity(): string {
  if (engine) return engine;
  const require = createRequire(import.meta.url);
  const versions = ANALYSIS_PACKAGES.map((name) => `${name}@${packageVersion(require, name)}`);
  let build = "";
  try {
    const stats = statSync(fileURLToPath(import.meta.url));
    build = `${stats.size}:${stats.mtimeMs}`;
  } catch {}
  engine = sha256(JSON.stringify({ store: CACHE_STORE_VERSION, versions, build }));
  return engine;
}

function packageVersion(require: NodeJS.Require, name: string): string {
  let directory: string;
  try {
    directory = dirname(require.resolve(name));
  } catch {
    return "?";
  }
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
      if (manifest.name === name) return String(manifest.version);
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) return "?";
    directory = parent;
  }
}

const STORE_LOCK_PREFIX = ".store-lock-";
const LEGACY_STORE_LOCK_FILE = ".store.lock";

export class LegacyStoreLockError extends Error {
  constructor() {
    super(
      "Doctor cache persistence is blocked by a legacy or unrecognized store lock; stop all Doctor processes sharing this cache, then run `vite-doctor cache clean` with the same cache configuration to rebuild it.",
    );
  }
}

function acquireStoreLock(root: string, dir: string): { fd: number; path: string } {
  if (readdirSync(dir).includes(LEGACY_STORE_LOCK_FILE)) throw new LegacyStoreLockError();
  const namespace = pidNamespaceIdentity();
  const name = `${STORE_LOCK_PREFIX}${process.pid}-${namespace ?? "unknown"}-${randomUUID()}`;
  const path = resolve(dir, name);
  assertCachePath(root, path);
  const lock = { fd: openSync(path, "wx", 0o600), path };
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, namespace }), { flag: "w" });
    // Publish ownership atomically in the name, then check for other writers.
    // Unique claims let concurrent reclaimers remove only a dead owner's file.
    for (const entry of readdirSync(dir)) {
      if (entry === name || !entry.startsWith(STORE_LOCK_PREFIX)) continue;
      const [ownerText, ownerNamespace] = entry.slice(STORE_LOCK_PREFIX.length).split("-");
      const owner = Number(ownerText);
      if (
        !Number.isSafeInteger(owner) ||
        owner <= 0 ||
        namespace === undefined ||
        ownerNamespace === undefined ||
        !/^\d+$/.test(ownerNamespace) ||
        ownerNamespace !== namespace ||
        processIsAlive(owner)
      ) {
        if (
          !Number.isSafeInteger(owner) ||
          owner <= 0 ||
          ownerNamespace === undefined ||
          !/^\d+$/.test(ownerNamespace)
        ) {
          throw new LegacyStoreLockError();
        }
        throw new Error("Doctor cache store has an active writer.");
      }
      try {
        unlinkSync(resolve(dir, entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return lock;
  } catch (error) {
    releaseStoreLock(lock);
    throw error;
  }
}

function pidNamespaceIdentity(): string | undefined {
  try {
    return String(statSync("/proc/self/ns/pid").ino);
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function releaseStoreLock(lock: { fd: number; path: string }): void {
  try {
    closeSync(lock.fd);
  } catch {
  } finally {
    try {
      unlinkSync(lock.path);
    } catch {}
  }
}

export function cleanCacheDirectory(root: string, dir: string): void {
  assertCacheDirectory(resolve(root), dir);
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    try {
      assertCacheDirectory(realpathSync(root), realpathSync(dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rmSync(dir, { force: true });
        return;
      }
      throw error;
    }
  } else {
    assertCacheDirectory(realpathSync(root), realpathSync(dir));
    if (!stats.isDirectory()) {
      throw new Error("Doctor cache directory must be a directory.");
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

function assertCacheDirectory(root: string, dir: string): void {
  const relativeDir = relative(root, dir);
  if (
    !relativeDir ||
    isAbsolute(relativeDir) ||
    relativeDir === ".." ||
    relativeDir.startsWith(`..${sep}`)
  ) {
    throw new Error("Doctor cache directory must be inside the project root.");
  }
}

function assertCacheInside(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("Doctor cache directory must be inside the project root.");
  }
}

function assertCachePath(root: string, path: string): void {
  assertCacheDirectory(root, path);
  const canonicalRoot = realpathSync(root);
  let current = path;
  while (true) {
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats) {
      let canonical: string;
      try {
        canonical = realpathSync(current);
      } catch {
        throw new Error("Doctor cache directory must be inside the project root.");
      }
      assertCacheInside(canonicalRoot, canonical);
      return;
    }
    const parent = resolve(current, "..");
    if (parent === current) return;
    current = parent;
  }
}
