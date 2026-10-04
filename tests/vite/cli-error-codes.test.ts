import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { consola } from "consola";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";

const roots: string[] = [];

function fixture(config?: string) {
  const root = mkdtempSync(join(tmpdir(), "doctor-cli-codes-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  if (config) writeFileSync(join(root, "doctor.config.json"), config);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function report(root: string, format: string, args: string[] = []) {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const code = await main([root, "--framework", "vite", "--no-cache", "--format", format, ...args]);
  expect(code).toBe(2);
  return JSON.parse(output);
}

for (const format of ["json", "agent", "sarif"]) {
  test(`${format} retains a Diagnostic Code for an invalid invocation`, async () => {
    const output = await report(fixture(), format, ["--extends", "missing/recommended"]);
    if (format === "sarif") {
      expect(output.runs[0].invocations[0].toolExecutionNotifications[0]).toMatchObject({
        properties: { diagnosticCode: "DOC0017" },
      });
    } else {
      expect(output).toMatchObject({
        status: "failed",
        error: { kind: "invocation", code: "DOC0017" },
      });
    }
  });

  test.each([
    ['{"rules":{"vite/test":["invalid-severity",{}]}}', "DOC0019"],
    ['{"rules":{"vite/test":"invalid-severity"}}', "DOC0020"],
  ])(`${format} retains %s through config error wrapping`, async (config, code) => {
    const root = fixture(config);
    const output = await report(root, format);
    if (format === "sarif") {
      expect(output.runs[0].invocations[0].toolExecutionNotifications[0]).toMatchObject({
        properties: { diagnosticCode: code },
      });
    } else {
      expect(output).toMatchObject({
        status: "failed",
        error: { kind: "config", code, file: join(root, "doctor.config.json") },
        next: { action: "fix-config" },
      });
    }
  });

  test(`${format} does not invent a code for an ordinary JSON syntax failure`, async () => {
    const output = await report(fixture("{"), format);
    if (format === "sarif") {
      expect(
        output.runs[0].invocations[0].toolExecutionNotifications[0].properties,
      ).toBeUndefined();
    } else {
      expect(output.error).not.toHaveProperty("code");
      expect(output.error.kind).toBe("config");
    }
  });
}

test("human invocation errors retain their Diagnostic Code", async () => {
  const error = vi.spyOn(consola, "error").mockImplementation(() => {});
  const code = await main([
    fixture(),
    "--framework",
    "vite",
    "--extends",
    "missing/recommended",
    "--format",
    "text",
  ]);
  expect(code).toBe(2);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("DOC0017"));
});
