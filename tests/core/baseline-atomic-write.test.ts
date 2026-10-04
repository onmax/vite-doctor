import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import { allDiagnostics, runDoctor } from "../../src/core/index.ts";
import { createRule, defineDoctorExtension, defineRulePack } from "../../src/extension.ts";
import {
  writeBaseline,
  type BaselineWriteHooks,
} from "../../src/core/internal/diagnostic-policy.ts";

function findings(root: string, name: string, fingerprint: string) {
  return [
    {
      ruleId: "test/baseline",
      file: join(root, name),
      fingerprint,
    },
  ] as any;
}

function temporaryFiles(root: string): string[] {
  return readdirSync(root).filter(
    (name) => name.includes(".vite-doctor-") && name.endsWith(".tmp"),
  );
}

const reportRule = createRule({
  meta: {
    id: "test/baseline-atomic",
    title: "Baseline atomic fixture",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: any) {
        if (node.type !== "Program") return;
        ctx.report(
          allDiagnostics.DOC9999({
            why: "The baseline atomic fixture reports.",
            fix: "Keep the baseline atomic fixture.",
          }),
          {
            ruleId: "test/baseline-atomic",
            severity: "warn",
            category: "correctness",
            file: ctx.file.path,
          },
        );
      },
    };
  },
});

test("a temporary write failure preserves the previous baseline and cleans its artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
  try {
    const baseline = "reports/baseline.json";
    writeBaseline(root, baseline, findings(root, "src/old.ts", "old"));
    const file = join(root, baseline);
    const previous = readFileSync(file, "utf8");
    const hooks: BaselineWriteHooks = {
      writeFileSync: ((path: any, data: any, options?: any) => {
        nodeWriteFileSync(path, data, options);
        throw new Error("injected baseline write failure");
      }) as BaselineWriteHooks["writeFileSync"],
    };

    expect(() => writeBaseline(root, baseline, findings(root, "src/new.ts", "new"), hooks)).toThrow(
      "injected baseline write failure",
    );
    expect(readFileSync(file, "utf8")).toBe(previous);
    expect(temporaryFiles(dirname(file))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rename failure preserves the previous baseline and cleans its artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
  try {
    const baseline = "baseline.json";
    writeBaseline(root, baseline, findings(root, "src/old.ts", "old"));
    const file = join(root, baseline);
    const previous = readFileSync(file, "utf8");
    const hooks: BaselineWriteHooks = {
      renameSync: (() => {
        throw new Error("injected baseline rename failure");
      }) as BaselineWriteHooks["renameSync"],
    };

    expect(() => writeBaseline(root, baseline, findings(root, "src/new.ts", "new"), hooks)).toThrow(
      "injected baseline rename failure",
    );
    expect(readFileSync(file, "utf8")).toBe(previous);
    expect(temporaryFiles(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("atomic updates preserve baseline permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
  try {
    const baseline = "baseline.json";
    writeBaseline(root, baseline, findings(root, "src/old.ts", "old"));
    const file = join(root, baseline);
    chmodSync(file, 0o640);
    writeBaseline(root, baseline, findings(root, "src/new.ts", "new"));

    expect(statSync(file).mode & 0o777).toBe(0o640);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic updates create and refresh baseline contents", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
  try {
    const baseline = "baseline.json";
    writeBaseline(root, baseline, []);
    const file = join(root, baseline);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, diagnostics: [] });

    writeBaseline(root, baseline, findings(root, "src/new.ts", "new"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      version: 1,
      diagnostics: [{ fingerprint: "new", file: "src/new.ts" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public runDoctor updates and consumes a baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    nodeWriteFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    nodeWriteFileSync(join(root, "src/app.ts"), "export const value = true;\n");
    const extensions = [
      defineDoctorExtension({
        name: "test/baseline-atomic",
        rulePacks: [
          defineRulePack({
            name: "test/baseline-atomic",
            version: "0.0.0",
            rules: [reportRule],
            presets: { recommended: [reportRule.meta.id] },
          }),
        ],
      }),
    ];
    const options = {
      root,
      framework: "vite" as const,
      baseline: "reports/baseline.json",
      cache: false,
      extensions,
    };
    const first = await runDoctor({ ...options, updateBaseline: true });
    const second = await runDoctor({ ...options, newOnly: true });

    expect(first.diagnostics).toHaveLength(1);
    expect(second.diagnostics).toEqual([]);
    expect(second.suppressedDiagnostics).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, options.baseline), "utf8"))).toMatchObject({
      version: 1,
      diagnostics: [{ fingerprint: first.diagnostics[0]!.fingerprint }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "atomic updates write through an existing baseline symlink",
  () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
    try {
      mkdirSync(join(root, "actual"), { recursive: true });
      const target = join(root, "actual/baseline.json");
      writeBaseline(root, "actual/baseline.json", findings(root, "src/old.ts", "old"));
      mkdirSync(join(root, "links"), { recursive: true });
      const link = join(root, "links/baseline.json");
      symlinkSync("../actual/baseline.json", link);

      writeBaseline(root, "links/baseline.json", findings(root, "src/new.ts", "new"));

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe("../actual/baseline.json");
      expect(JSON.parse(readFileSync(target, "utf8")).diagnostics[0].fingerprint).toBe("new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "atomic updates follow dangling symlink chains to their missing target",
  () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
    try {
      symlinkSync("second.json", join(root, "first.json"));
      symlinkSync("actual.json", join(root, "second.json"));

      writeBaseline(root, "first.json", []);

      expect(lstatSync(join(root, "first.json")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(root, "second.json")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "actual.json"), "utf8"))).toEqual({
        version: 1,
        diagnostics: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "atomic updates resolve relative targets through symlinked parent directories",
  () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
    try {
      mkdirSync(join(root, "physical/config"), { recursive: true });
      symlinkSync("physical/config", join(root, "logical"));
      symlinkSync("../target.json", join(root, "physical/config/baseline.json"));

      writeBaseline(root, "logical/baseline.json", []);

      expect(lstatSync(join(root, "logical/baseline.json")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "physical/target.json"), "utf8"))).toEqual({
        version: 1,
        diagnostics: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("atomic updates reject symlink loops", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-baseline-atomic-"));
  try {
    symlinkSync("second.json", join(root, "first.json"));
    symlinkSync("first.json", join(root, "second.json"));

    expect(() => writeBaseline(root, "first.json", [])).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(lstatSync(join(root, "first.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, "second.json")).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
