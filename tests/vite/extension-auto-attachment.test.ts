import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { build, type Logger, type Plugin } from "vite";
import { expect, test } from "vite-plus/test";
import { resolveDoctorExtensions } from "../../src/core/internal/scan-session.ts";
import {
  createAgentReport,
  defineDoctorDiagnostics as defineBuiltInDiagnostics,
  runDoctor,
} from "../../src/core/index.ts";
import {
  createRule,
  defineDoctorDiagnostics,
  defineDoctorExtension,
  defineDoctorPluginApi,
  defineRulePack,
  type DoctorExtension,
} from "../../src/extension.ts";
import { doctor } from "../../src/plugin.ts";
import vitehubExtension from "../fixtures/extension-library/doctor.ts";

const legacyImport = 'import { kv } from "@vite-hub/kv/legacy";\nexport const store = kv;\n';

async function withProject(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "doctor-extension-attachment-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "entry.ts"), legacyImport);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function vitehubPlugin(extension?: Plugin["api"]): Plugin {
  return {
    name: "@vite-hub/kv",
    api: {
      doctor: defineDoctorPluginApi({
        extensions: [extension ?? (() => import("../fixtures/extension-library/doctor.ts"))],
      }),
    },
    resolveId(id) {
      return id.startsWith("@vite-hub/") ? `\0${id}` : undefined;
    },
    load(id) {
      return id.startsWith("\0@vite-hub/") ? "export const kv = {};" : undefined;
    },
  };
}

function captureLogger(messages: string[]): Logger {
  return {
    info: (message: string) => messages.push(message),
    warn: (message: string) => messages.push(message),
    warnOnce: (message: string) => messages.push(message),
    error: (message: string) => messages.push(message),
    clearScreen() {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

async function buildWith(root: string, plugins: Plugin[], messages: string[] = []) {
  await build({
    root,
    configFile: false,
    customLogger: captureLogger(messages),
    plugins,
    build: {
      write: false,
      lib: { entry: join(root, "entry.ts"), formats: ["es"] },
    },
  });
  return messages.join("\n");
}

test("the Vite Plugin Surface attaches Doctor Extensions exposed by other Vite plugins", async () => {
  await withProject(async (root) => {
    await expect(
      buildWith(root, [
        vitehubPlugin(),
        doctor({ framework: "vite", rules: "vitehub", cache: false, maxWarnings: 0 }),
      ]),
    ).rejects.toThrow("VHUB0001");

    const output = await buildWith(root, [
      doctor({ framework: "vite", rules: "vitehub", cache: false, mode: "warn" }),
      vitehubPlugin(),
    ]);
    expect(output).toContain("VHUB0001");
    expect(output).toContain("https://vitehub.example/doctor/VHUB0001");
    expect(output).not.toContain("vite-doctor.onmax.me/diagnostics/VHUB0001");
  });
});

test("an extension registered explicitly and by a Vite plugin runs once", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "entry.ts"), `${legacyImport}export * from "./other.ts";\n`);
    await writeFile(join(root, "other.ts"), 'export const other = "ok";\n');
    const messages: string[] = [];
    await buildWith(
      root,
      [
        vitehubPlugin(vitehubExtension),
        vitehubPlugin(),
        doctor({
          framework: "vite",
          rules: "vitehub",
          cache: false,
          mode: "warn",
          format: "json",
          extensions: [vitehubExtension],
        }),
      ],
      messages,
    );
    const report = JSON.parse(messages.find((message) => message.startsWith("{"))!);
    expect(report.diagnostics.map((item: { code: string }) => item.code)).toEqual(["VHUB0001"]);
  });
});

test("Doctor Extension inputs resolve loaders in order and keep the first registration per name", async () => {
  const named = (name: string, version: string): DoctorExtension => ({ name, version });
  const extensions = await resolveDoctorExtensions([
    named("b", "explicit"),
    () => named("a", "loader"),
    async () => ({ default: named("b", "plugin") }),
    named("c", "plugin"),
    named("a", "late"),
  ]);
  expect(extensions.map(({ name, version }) => `${name}@${version}`)).toEqual([
    "b@explicit",
    "a@loader",
    "c@plugin",
  ]);
});

test("third-party Diagnostic Codes keep their own docs in agent reports", async () => {
  await withProject(async (root) => {
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      extensions: [vitehubExtension],
    });
    const agent = JSON.parse(createAgentReport(result));
    expect(agent.diagnostics).toEqual([
      expect.objectContaining({
        code: "VHUB0001",
        rule: "vitehub/no-legacy-kv-import",
        severity: "warn",
        docs: "https://vitehub.example/doctor/VHUB0001",
        remediation: "Import from `@vite-hub/kv` instead.",
      }),
    ]);
  });
});

test("third-party Diagnostic Codes only get docs URLs their owner declares", () => {
  const registry = defineDoctorDiagnostics([
    { code: "ACME0001", ruleId: "acme/a" },
    { code: "ACME0002", ruleId: "acme/b", docs: "https://acme.example/b" },
  ]);
  expect(registry.docsByCode).toEqual({
    ACME0001: undefined,
    ACME0002: "https://acme.example/b",
  });
  expect(registry.diagnostics.ACME0001({ why: "a", fix: "b" }).docs).toBeUndefined();
  expect(
    defineDoctorDiagnostics([{ code: "ACME0001", ruleId: "acme/a" }], {
      docsBase: (code) => `https://acme.example/codes/${code.toLowerCase()}`,
    }).docsByCode.ACME0001,
  ).toBe("https://acme.example/codes/acme0001");
  expect(defineBuiltInDiagnostics([{ code: "VITE9001", ruleId: "vite/x" }]).docsByCode).toEqual({
    VITE9001: "https://vite-doctor.onmax.me/diagnostics/VITE9001",
  });
});

function packWithCodes(code: string) {
  return defineRulePack({
    name: "acme",
    version: "1.0.0",
    rules: [],
    diagnostics: { codesByRuleIdAll: { "acme/rule": [code] }, docsByCode: { [code]: undefined } },
    presets: { recommended: ["acme/rule"] },
  });
}

const thrownName = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as Error).name;
  }
  return undefined;
};

test("extension Diagnostic Codes cannot use built-in or malformed prefixes", () => {
  expect(thrownName(() => defineDoctorDiagnostics([{ code: "VITE9001", ruleId: "a" }]))).toBe(
    "DOC0028",
  );
  expect(thrownName(() => defineDoctorDiagnostics([{ code: "acme-1", ruleId: "a" }]))).toBe(
    "DOC0027",
  );
  expect(thrownName(() => packWithCodes("NUXT9001"))).toBe("DOC0028");
  expect(thrownName(() => packWithCodes("PINIA9001"))).toBe("DOC0028");
  expect(thrownName(() => packWithCodes("Acme0001"))).toBe("DOC0027");
  expect(packWithCodes("ACME0001").name).toBe("acme");
});

test("Rule Packs cannot share Diagnostic Codes", async () => {
  await withProject(async (root) => {
    const pack = (name: string) =>
      defineDoctorExtension({
        name,
        rulePacks: [{ ...packWithCodes("ACME0001"), name }],
      });
    await expect(
      runDoctor({ root, framework: "vite", cache: false, extensions: [pack("a"), pack("b")] }),
    ).rejects.toMatchObject({ name: "DOC0012" });
  });
});

test("ctx.report defaults ruleId, severity, and category to the reporting Rule", async () => {
  await withProject(async (root) => {
    const acme = defineDoctorDiagnostics([{ code: "ACME0001", ruleId: "acme/minimal" }]);
    const rule = createRule({
      meta: { id: "acme/minimal", title: "Minimal", category: "acme", severity: "info" },
      create(ctx) {
        return {
          ImportDeclaration(node) {
            ctx.report(acme.diagnostics.ACME0001({ why: "Found.", fix: "Fix." }), {
              range: ctx.range(node),
            });
          },
        };
      },
    });
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      extensions: [
        defineDoctorExtension({
          name: "acme",
          rulePacks: [
            defineRulePack({
              name: "acme",
              version: "1.0.0",
              rules: [rule],
              diagnostics: acme,
              presets: { recommended: ["acme/minimal"] },
            }),
          ],
        }),
      ],
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "ACME0001",
        ruleId: "acme/minimal",
        severity: "info",
        category: "acme",
      }),
    ]);
  });
});
