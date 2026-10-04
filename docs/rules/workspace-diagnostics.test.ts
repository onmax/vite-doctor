import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { runViteDoctor } from "../../src/doctor.js";
import { diagnosticsCollectionSource, getDiagnosticDocuments } from "./source.js";

const repeated = Array.from({ length: 12 }, (_, index) => `console.log(${index});`).join("\n");
const cases = [
  {
    code: "DOC0001",
    analysis: "graph",
    files: { "src/main.ts": 'import "./cycle.ts"', "src/cycle.ts": 'import "./main.ts"' },
  },
  {
    code: "DOC0002",
    analysis: "graph",
    files: { "src/one.ts": "export const value = 1", "src/two.ts": "export const value = 2" },
  },
  {
    code: "DOC0003",
    analysis: "dead-code",
    files: { "src/main.ts": 'import "missing-package"' },
  },
  {
    code: "DOC0004",
    analysis: "dead-code",
    files: { "src/main.ts": 'import "./missing.ts"' },
  },
  {
    code: "DOC0005",
    analysis: "dead-code",
    files: { "package.json": JSON.stringify({ dependencies: { "unused-package": "1.0.0" } }) },
  },
  {
    code: "DOC0006",
    analysis: "dead-code",
    files: { "src/orphan.ts": "export const unused = 1" },
  },
  {
    code: "DOC0007",
    analysis: "dead-code",
    files: { "src/orphan.ts": 'console.log("unreachable")' },
  },
  {
    code: "DOC0008",
    analysis: "dead-code",
    files: { "src/orphan.ts": "export type Unused = { id: string }" },
  },
  {
    code: "DOC0009",
    analysis: "dupes",
    files: { "src/one.ts": repeated, "src/two.ts": repeated },
  },
  {
    code: "DOC0010",
    analysis: "health",
    files: {
      "src/main.ts": Array.from({ length: 14 }, (_, index) => `if (flag${index}) run();`).join(
        "\n",
      ),
    },
  },
  {
    code: "DOC0011",
    analysis: "health",
    files: {
      "src/main.ts": Array.from({ length: 20 }, (_, index) => `import "package-${index}";`).join(
        "\n",
      ),
    },
  },
] satisfies { code: string; analysis: string; files: Record<string, string> }[];

test.each(cases)(
  "documents the emitted $code diagnostic and its analysis command",
  async (item) => {
    const root = await mkdtemp(join(tmpdir(), "doctor-workspace-docs-"));
    try {
      for (const [file, contents] of Object.entries({ "package.json": "{}", ...item.files })) {
        const target = join(root, file);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents!);
      }
      const result = await runViteDoctor({ root, analyses: item.analysis, cache: false });
      const emitted = result.diagnostics.find((diagnostic) => diagnostic.code === item.code);
      expect(emitted).toBeDefined();

      const document = getDiagnosticDocuments().find((diagnostic) => diagnostic.code === item.code);
      expect(document).toMatchObject({
        ruleId: emitted!.ruleId,
        severity: emitted!.severity,
        category: emitted!.category,
        pack: "vite-doctor/core",
        rulePath: "",
        path: `/diagnostics/${item.code}`,
      });
      expect(document!.framework).toBeUndefined();
      expect(emitted!.docs).toBe(`https://vite-doctor.onmax.me${document!.path}`);
      expect(await diagnosticsCollectionSource.getKeys()).toContain(document!.key);

      const markdown = await diagnosticsCollectionSource.getItem(document!.key);
      expect(markdown).toContain(`code: "${item.code}"`);
      expect(markdown).toContain("## Why it happens");
      expect(markdown).toContain("## Fix");
      expect(markdown).toContain("## Verify the fix");
      expect(markdown).toContain(`pnpm vite-doctor . --analyses ${item.analysis}`);
      expect(markdown).not.toContain("--rules workspace/");
      expect(markdown).not.toContain("framework:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
