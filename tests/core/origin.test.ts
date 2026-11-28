import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test } from "vite-plus/test";
import { createDiagnosticFingerprint } from "../../src/core/internal/diagnostics.ts";
import { runViteDoctor } from "../../src/doctor.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tool = (annotations: string) =>
  `import { defineMcpTool } from 'nitro-mcp-toolkit'\nexport default defineMcpTool({\n  name: 'list_drops',\n  title: 'List drops',\n  annotations: ${annotations},\n  handler: () => [],\n})\n`;

function project(annotations = "{ readOnlyHint: true }") {
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-origin-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { "nitro-mcp-toolkit": "^0.4.0", h3: "^2.0.0" },
    }),
  );
  mkdirSync(join(root, "server/mcp/tools"), { recursive: true });
  writeFileSync(join(root, "server/mcp/tools/list_drops.ts"), tool(annotations));
  return root;
}

test("static MCP findings keep the scheme-5 tool fingerprint", async () => {
  const root = project();
  const result = await runViteDoctor({ root, cache: false });
  const finding = result.diagnostics.find((item) => item.code === "MCP0001");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "mcp/tools/require-annotation-title",
        "server/mcp/tools/list_drops.ts",
        "list_drops",
      ]),
    )
    .digest("hex");
  expect(finding?.fingerprint).toBe(fingerprint);
});

test("a scheme-4 baseline warns about a changed static MCP fingerprint", async () => {
  const root = project();
  const resultBefore = await runViteDoctor({ root, cache: false });
  const finding = resultBefore.diagnostics.find((item) => item.code === "MCP0001")!;
  const legacy = createDiagnosticFingerprint(root, finding, readFileSync(finding.file, "utf8"));
  writeFileSync(
    join(root, "baseline.json"),
    JSON.stringify({ version: 2, fingerprintScheme: 4, diagnostics: [{ fingerprint: legacy }] }),
  );
  const result = await runViteDoctor({ root, baseline: "baseline.json", newOnly: true });
  expect(result.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining(["DOC0032", "MCP0001"]),
  );
});
