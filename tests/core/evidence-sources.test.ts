import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { createAgentReport, createJsonReport } from "../../src/core/reports.ts";
import { runViteDoctor } from "../../src/doctor.ts";
import type { DoctorExtension, EvidenceSource } from "../../src/extension.ts";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-sources-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  return root;
}

interface StatusInput {
  urls: string[];
  token?: string;
}

function statusSource(collected: StatusInput[] = []): EvidenceSource<StatusInput> {
  return {
    name: "status",
    label: "status page",
    options: {
      url: { help: "Read this status page.", value: "url", repeatable: true },
      token: { help: "Bearer token.", requires: "url", secret: true },
    },
    fromOptions: ({ url = [], token }) => ({ urls: url, token: token?.[0] }),
    toOptions: ({ urls, token }) => ({ url: urls, ...(token ? { token: [token] } : {}) }),
    validate({ urls }) {
      for (const url of urls) if (!URL.canParse(url)) throw new Error(`Not a URL: ${url}`);
    },
    async collect(input, { fetch }) {
      collected.push(input);
      const pages = await Promise.all(input.urls.map((url) => fetch(url).then((r) => r.status)));
      return {
        evidence: { pages },
        targets: input.urls.map((url) => new URL(url).host),
        gaps: input.urls
          .filter((_url, index) => pages[index] !== 200)
          .map((url) => ({ message: `Could not read ${new URL(url).host}.` })),
      };
    },
  };
}

const extension = (source: EvidenceSource): DoctorExtension => ({
  name: "fixture/status",
  sources: [source],
});

const fetchStatus = (status: number) => vi.fn(async () => new Response("", { status }));

test("a source without an input is never collected", async () => {
  const collected: StatusInput[] = [];
  const result = await runViteDoctor({
    root: project(),
    cache: false,
    extensions: [extension(statusSource(collected))],
  });
  expect(collected).toEqual([]);
  expect(result.evidenceSources).toBeUndefined();
  expect(result.project.runtimeEvidence?.status).toBeUndefined();
});

test("a source's evidence, targets, and gaps land in the run under its name", async () => {
  const fetch = fetchStatus(503);
  const result = await runViteDoctor({
    root: project(),
    cache: false,
    fetch,
    extensions: [extension(statusSource())],
    sources: { status: { urls: ["https://status.example.test/"], token: "s3cret" } },
  });
  expect(fetch).toHaveBeenCalledWith("https://status.example.test/");
  expect(result.project.runtimeEvidence?.status).toEqual({ pages: [503] });
  expect(result.project.evidenceGaps).toContainEqual({
    source: "status",
    message: "Could not read status.example.test.",
    files: [],
  });
  expect(result.evidenceSources).toEqual([
    {
      name: "status",
      label: "status page",
      targets: ["status.example.test"],
      args: ["--status-url", "https://status.example.test/", "--status-token", "<redacted>"],
    },
  ]);
  expect(JSON.parse(createJsonReport(result)).sources).toEqual([
    { name: "status", label: "status page", targets: ["status.example.test"] },
  ]);
  const agent = JSON.parse(createAgentReport(result, { runOptions: { format: "agent" } }));
  expect(agent.commandArgs.rerun).toEqual(
    expect.arrayContaining(["--status-url", "https://status.example.test/", "--status-token"]),
  );
  expect(JSON.stringify(agent)).not.toContain("s3cret");
});

test("every input is validated before any source is collected", async () => {
  const collected: StatusInput[] = [];
  await expect(
    runViteDoctor({
      root: project(),
      cache: false,
      extensions: [extension(statusSource(collected))],
      sources: { status: { urls: ["not a url"] } },
    }),
  ).rejects.toThrow("Not a URL: not a url");
  await expect(
    runViteDoctor({
      root: project(),
      cache: false,
      extensions: [extension(statusSource(collected))],
      sources: { status: { urls: ["https://status.example.test/"] }, uptime: {} },
    }),
  ).rejects.toThrow('No Doctor Extension provides the "uptime" Evidence Source');
  expect(collected).toEqual([]);
});

test("a source can't share its name with a Runtime Evidence contributor", async () => {
  await expect(
    runViteDoctor({
      root: project(),
      cache: false,
      extensions: [
        extension(statusSource()),
        {
          name: "fixture/contributor",
          setup(api) {
            api.registerRuntimeEvidenceContributor({ name: "status", contribute: () => ({}) });
          },
        },
      ],
    }),
  ).rejects.toThrow('"status" was registered more than once');
});

function configWithSource(root: string) {
  writeFileSync(
    join(root, "doctor.config.mjs"),
    `export default { extensions: [{ name: "fixture/status", sources: [{
      name: "status",
      label: "status page",
      options: {
        url: { help: "Read this status page.", value: "url", repeatable: true },
        token: { help: "Bearer token.", requires: "url", secret: true },
      },
      fromOptions: ({ url = [], token }) => ({ urls: url, token: token?.[0] }),
      toOptions: ({ urls, token }) => ({ url: urls, ...(token ? { token: [token] } : {}) }),
      collect: (input) => ({ evidence: { input }, targets: input.urls }),
    }] }] };\n`,
  );
}

async function cli(root: string, args: string[]) {
  let output = "";
  const capture = (chunk: unknown) => {
    output += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
  try {
    return { code: await main(args, root), output };
  } finally {
    vi.restoreAllMocks();
  }
}

test("the CLI reads a config Extension's source flags once the config loads", async () => {
  const root = project();
  configWithSource(root);
  const { code, output } = await cli(root, [
    ".",
    "--config",
    "doctor.config.mjs",
    "--status-url",
    "https://a.example.test/",
    "--status-url",
    "https://b.example.test/",
    "--status-token",
    "s3cret",
    "--format",
    "json",
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(output).sources).toEqual([
    {
      name: "status",
      label: "status page",
      targets: ["https://a.example.test/", "https://b.example.test/"],
    },
  ]);
});

test.each([
  [["--status-typo", "x"], "Unknown option `--status-typo`"],
  [["--status-token", "x"], "--status-token requires --status-url <url>."],
  [["--status-url"], "--status-url requires a value."],
])("the CLI rejects %j", async (flags, message) => {
  const root = project();
  configWithSource(root);
  const { code, output } = await cli(root, [
    ".",
    "--config",
    "doctor.config.mjs",
    ...flags,
    "--format",
    "text",
  ]);
  expect(code).toBe(2);
  expect(output).toContain(message);
});

test("an unknown flag stays an error without a config", async () => {
  const { code, output } = await cli(project(), [".", "--chnaged", "--format", "text"]);
  expect(code).toBe(2);
  expect(output).toContain("Unknown option `--chnaged`");
});
