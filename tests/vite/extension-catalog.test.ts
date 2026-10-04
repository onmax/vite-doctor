import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main } from "../../src/cli.ts";
import { viteDoctorRulePacks } from "../../src/doctor.ts";
import { defineDoctorExtension, defineRulePack } from "../../src/extension.ts";

const roots: string[] = [];
const ruleId = "example/custom-rule";
const code = "EXAMPLE0001";
const meta = {
  id: ruleId,
  title: "Example custom Rule",
  category: "correctness" as const,
  severity: "warn" as const,
  diagnosticCodes: [code],
  docsUrl: "https://example.test/custom-rule",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doctor-extension-catalog-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  return root;
}

function config(root: string, registration: string) {
  const file = "doctor.config.mjs";
  const pack = `{name: "example/custom", version: "1.2.3", presets: {recommended: [${JSON.stringify(ruleId)}]}, rules: [{meta: ${JSON.stringify(meta)}, create() { throw new Error("Catalog executed a Rule"); }}]}`;
  writeFileSync(
    join(root, file),
    `const pack = ${pack}; export default {include: ["src/**"], extensions: [{name: "example/custom", ${registration === "static" ? "rulePacks: [pack]" : "async setup(api) { api.registerRulePack(pack); }"}}]};`,
  );
  return file;
}

async function run(root: string, args: string[]) {
  let output = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    return { code: await main(args, root), output };
  } finally {
    stdout.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const registration of ["static", "setup"]) {
  for (const format of ["json", "agent", "text"]) {
    test(`${registration} extensions appear in the ${format} Rule Catalog`, async () => {
      const root = fixture();
      const result = await run(root, [
        "rules",
        "--config",
        config(root, registration),
        "--format",
        format,
      ]);
      expect(result.code).toBe(0);
      if (format === "text") expect(result.output).toContain(ruleId);
      else
        expect(JSON.parse(result.output).rules).toContainEqual(
          expect.objectContaining({ id: ruleId, version: "1.2.3", diagnosticCodes: [code] }),
        );
    });

    test(`${registration} extensions can explain a code in ${format}`, async () => {
      const root = fixture();
      const result = await run(root, [
        "explain",
        code,
        "--config",
        config(root, registration),
        "--format",
        format,
      ]);
      expect(result.code).toBe(0);
      expect(result.output).toContain(ruleId);
      expect(result.output).not.toContain(`vite-doctor.onmax.me/diagnostics/${code}`);
      if (format !== "text")
        expect(JSON.parse(result.output)).toMatchObject({
          id: ruleId,
          docsUrl: meta.docsUrl,
          diagnosticCodes: [code],
        });
    });
  }
}

test.each([{ args: ["rules"] }, { args: ["explain", "VITE0009"] }])(
  "metadata command $args does not discover executable config",
  async ({ args }) => {
    const root = fixture();
    writeFileSync(join(root, "doctor.config.mjs"), 'throw new Error("Untrusted config executed");');
    const result = await run(root, [...args, "--format", "agent"]);
    expect(result.code).toBe(0);
  },
);

test.each([{ args: ["rules"] }, { args: ["explain", code] }])(
  "metadata command $args attributes missing explicit config",
  async ({ args }) => {
    const root = fixture();
    const result = await run(root, [...args, "--config", "missing.mjs", "--format", "agent"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      error: { kind: "config", file: join(root, "missing.mjs") },
      next: { action: "fix-config" },
    });
  },
);

test("generated explanation commands retain the trusted extension config", async () => {
  const root = fixture();
  const file = config(root, "static");
  const result = await run(root, [".", "--config", file, "--format", "agent"]);
  expect(result.code).toBe(0);
  const args = JSON.parse(result.output).commandArgs.explain.map((arg: string) =>
    arg === "<code>" ? code : arg,
  );
  const explained = await run(root, args.slice(1));
  expect(explained.code).toBe(0);
  expect(JSON.parse(explained.output)).toMatchObject({ id: ruleId, diagnosticCodes: [code] });
});

test("the Rule Pack API includes configured and setup-registered extensions without executing Rules", async () => {
  const root = fixture();
  const pack = defineRulePack({
    name: "example/custom",
    version: "1.2.3",
    rules: [
      {
        meta,
        create() {
          throw new Error("Catalog executed a Rule");
        },
      },
    ],
    presets: { recommended: [ruleId] },
  });
  const configured = defineDoctorExtension({ name: "example/configured", rulePacks: [pack] });
  const setup = defineDoctorExtension({
    name: "example/setup",
    async setup(api) {
      api.registerRulePack({ ...pack, name: "example/setup" });
    },
  });
  const packs = await viteDoctorRulePacks({
    root,
    config: { extensions: [configured] },
    extensions: [setup],
  });
  expect(packs.filter((p) => p.name.startsWith("example/"))).toEqual([
    pack,
    { ...pack, name: "example/setup" },
  ]);
});
