import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createReport, type DoctorRunOptions, type DoctorRunResult } from "../../src/core/index.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import { startMcpStub } from "./mcp-stub.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/mcp/nuxt.json", import.meta.url), "utf8"),
);

let root: string;
let stub: Awaited<ReturnType<typeof startMcpStub>>;
let options: DoctorRunOptions;
let result: DoctorRunResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "doctor-progressive-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  stub = await startMcpStub({
    tools: fixture.tools,
    instructions: fixture.initialize.instructions,
  });
  options = {
    root,
    cache: false,
    extends: ["auto", "mcp/strict"],
    mcp: [{ url: stub.url, headers: { authorization: "Bearer secret-token" } }],
  };
  result = await runViteDoctor(options);
  expect(result.diagnostics.length).toBeGreaterThan(20);
});

afterAll(async () => {
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

const report = (format: "text" | "agent", maxChars?: number, run = result, runOptions = options) =>
  createReport(run, format, { runOptions: { ...runOptions, maxChars } });

interface ShownGroup {
  code: string;
  count: number;
  rows: number;
  hidden: number;
  detail: boolean;
  more?: string[];
}

/** The groups a text report prints, with the rows each shows and the rows it says it hid. */
function textGroups(text: string): ShownGroup[] {
  const groups: ShownGroup[] = [];
  let current: ShownGroup | undefined;
  for (const line of text.split("\n")) {
    const title = /^([A-Z]+\d{4}) {2}.* · ([\d,]+) Diagnostics?(?: · |$)/.exec(line);
    if (title) {
      const count = Number(title[2]!.replace(",", ""));
      current = { code: title[1]!, count, rows: 0, hidden: 0, detail: false };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    if (line && !line.startsWith(" ")) current = undefined;
    else if (line.startsWith("    rule: ")) current.detail = true;
    else if (/^ {2}\(\d+ more rows?\)$/.test(line)) current.hidden = Number(/\d+/.exec(line)![0]);
    else if (line.startsWith("  more: ")) current.more = line.slice(8).split(" ");
    else if (/^ {2}[^\s([├╰│]/.test(line) && !/^ {2}(fix|evidence|rule): /.test(line))
      current.rows++;
  }
  for (const group of groups) if (group.detail) group.rows = group.count;
  return groups;
}

interface AgentGroup {
  code: string;
  count: number;
  rowsHidden?: number;
  more?: string[];
  diagnostics: Array<{ fingerprint?: string }>;
}

function agentGroups(json: string): ShownGroup[] {
  return (JSON.parse(json) as { groups: AgentGroup[] }).groups.map((group) => ({
    code: group.code,
    count: group.count,
    rows: group.diagnostics.length,
    hidden: group.rowsHidden ?? 0,
    detail: group.diagnostics.some((item) => item.fingerprint),
    more: group.more,
  }));
}

const head = (text: string) => text.slice(0, text.indexOf("\n", text.indexOf("  Codes: ")));

test("a Report Budget hides rows and groups, never the head, and shows more as it grows", () => {
  const total = result.diagnostics.length;
  const fullText = report("text", Infinity);
  const fullAgent = JSON.parse(report("agent", Infinity));
  const previous = { text: new Map<string, number>(), agent: new Map<string, number>() };
  for (let maxChars = 1000; maxChars <= 40_000; maxChars += 500) {
    const text = report("text", maxChars);
    const groups = textGroups(text);
    // Only a head and footer that don't fit on their own may pass the budget.
    if (text.length > maxChars) expect(groups).toEqual([]);
    expect(head(text)).toBe(head(fullText));
    for (const group of groups) expect(group.rows + group.hidden).toBe(group.count);
    const shown = groups.reduce((sum, group) => sum + group.rows, 0);
    const hidden = /^Hidden: ([\d,]+) of /m.exec(text);
    expect(hidden ? Number(hidden[1]!.replace(",", "")) : 0).toBe(total - shown);

    const agentText = report("agent", maxChars);
    const agent = JSON.parse(agentText);
    if (agentText.length > maxChars) expect(agent.groups).toEqual([]);
    expect(agent.summary).toEqual(fullAgent.summary);
    expect(agent.codes).toEqual(fullAgent.codes);
    const items = agentGroups(agentText);
    for (const group of items) expect(group.rows + group.hidden).toBe(group.count);
    const agentShown = items.reduce((sum, group) => sum + group.rows, 0);
    expect(agentShown + (agent.budget?.hidden.rows ?? 0)).toBe(total);

    for (const [format, list] of [
      ["text", groups],
      ["agent", items],
    ] as const) {
      const now = new Map(list.map((group) => [group.code, group.rows]));
      for (const [code, rows] of previous[format])
        expect(now.get(code) ?? -1).toBeGreaterThanOrEqual(rows);
      previous[format] = now;
    }
  }
});

test("the default Report Budget keeps text and agent reports under 8,000 characters", () => {
  const text = createReport(result, "text", { runOptions: options });
  const agent = createReport(result, "agent", { runOptions: options });
  expect(text.length).toBeLessThanOrEqual(8000);
  expect(agent.length).toBeLessThanOrEqual(8000);
  expect(text).toMatch(/^(Hidden: |Detail hidden for )/m);
  expect(JSON.parse(agent).budget).toMatchObject({ maxChars: 8000 });
});

test("each group's more flags show strictly more of that group", async () => {
  for (const format of ["text", "agent"] as const) {
    const output = createReport(result, format, { runOptions: options });
    const groups = format === "text" ? textGroups(output) : agentGroups(output);
    const hinted = groups.filter((group) => group.more);
    expect(hinted.length).toBeGreaterThan(0);
    for (const group of hinted) {
      const rules = group.more![group.more!.indexOf("--rules") + 1]!;
      const rerunOptions = {
        ...options,
        rules,
        maxChars: group.more!.includes("--full") ? Infinity : undefined,
      };
      const rerun = await runViteDoctor(rerunOptions);
      const next = createReport(rerun, format, { runOptions: rerunOptions });
      const again = (format === "text" ? textGroups(next) : agentGroups(next)).find(
        (item) => item.code === group.code,
      )!;
      expect(again.rows > group.rows || (again.detail && !group.detail)).toBe(true);
    }
  }
});

test("--full shows every Diagnostic in detail", () => {
  const agent = JSON.parse(report("agent", Infinity));
  expect(agent.budget).toBeUndefined();
  const fingerprints = agent.groups.flatMap((group: { diagnostics: object[] }) =>
    group.diagnostics.map((item) => (item as { fingerprint: string }).fingerprint),
  );
  expect(new Set(fingerprints)).toEqual(
    new Set(result.diagnostics.map((item) => item.fingerprint)),
  );
  expect(fingerprints).toHaveLength(result.diagnostics.length);
  const text = report("text", Infinity);
  expect(text).not.toContain("Hidden: ");
  expect(text.match(/^ {4}rule: /gm)).toHaveLength(result.diagnostics.length);
});

test("json and SARIF reports ignore the Report Budget", () => {
  for (const format of ["json", "sarif"] as const) {
    expect(createReport(result, format, { runOptions: { ...options, maxChars: 1000 } })).toBe(
      createReport(result, format, { runOptions: options }),
    );
  }
});

test("report commands drop mutating flags, redact header values, and name the root from cwd", () => {
  const runOptions = {
    ...options,
    fix: true,
    unsafeFix: true,
    updateBaseline: true,
    watch: true,
    maxChars: 2000,
  } as DoctorRunOptions;
  const agent = JSON.parse(createReport(result, "agent", { runOptions }));
  for (const args of Object.values(agent.commandArgs) as string[][]) {
    expect(args).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^--(fix|unsafe-fix|update-baseline|watch|max-chars)$/),
      ]),
    );
    expect(args.join(" ")).not.toContain("secret-token");
  }
  expect(agent.commandArgs.more).toEqual(
    expect.arrayContaining(["--mcp-header", "authorization: <redacted>"]),
  );
  expect(agent.commandArgs.full.at(-3)).toBe("--full");

  const text = createReport(result, "text", {
    runOptions,
    cwd: dirname(root),
    formatFlag: "text",
  });
  expect(text).not.toContain("secret-token");
  const everything = /^Everything: (.*)$/m.exec(text)![1]!;
  expect(everything).toMatch(
    new RegExp(`^vite-doctor \\./${root.split("/").at(-1)} .*--full --format text$`),
  );
  expect(everything).not.toMatch(/--(fix|unsafe-fix|update-baseline|watch|max-chars)\b/);
});

test("CI reads the complete text report unless maxChars sets a budget", () => {
  const ci = createReport(result, "text", { runOptions: options, reader: "ci" });
  expect(ci).toBe(report("text", Infinity));
  expect(ci).not.toMatch(/^ {2}more: /m);

  const budgeted = createReport(result, "text", {
    runOptions: { ...options, maxChars: 3000 },
    reader: "ci",
  });
  expect(budgeted.length).toBeLessThanOrEqual(3000);
  expect(budgeted).toMatch(/^Hidden: /m);
  // A CI rerun of one Rule is complete, so its hint needs no --full.
  expect(budgeted).toMatch(/^ {2}more: --rules \S+$/m);
  expect(budgeted).not.toMatch(/^ {2}more: .*--full$/m);
});

test("an agent report in CI keeps the default Report Budget", () => {
  const agent = createReport(result, "agent", { runOptions: options, reader: "ci" });
  expect(agent.length).toBeLessThanOrEqual(8000);
  expect(agent).toBe(report("agent"));
});
