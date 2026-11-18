import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { expect, test } from "vite-plus/test";
import { defineDoctorExtension, defineRulePack, runDoctor } from "../../src/core/index.ts";
import type { Diagnostic, DoctorRule } from "../../src/core/index.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { requireSafetyCommentForTypeAssertion } from "../../src/rule-packs/typescript/rules/require-safety-comment-for-type-assertion.ts";
import { noClientSecretPattern, noUntypedEnv } from "../../src/rules.ts";

const secret = noClientSecretPattern.meta.id;
const untyped = noUntypedEnv.meta.id;
const rules = [noClientSecretPattern, noUntypedEnv];

const inline = (diagnostics: Diagnostic[]) =>
  diagnostics.filter(
    (diagnostic) => diagnostic.code === "DOC0036" || diagnostic.code === "DOC0037",
  );

function applyFix(source: string, diagnostic: Diagnostic | undefined): string {
  let text = source;
  const edits = [...(diagnostic?.fix?.edits ?? [])].sort((a, b) => b.range.start - a.range.start);
  for (const edit of edits)
    text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end);
  return text;
}

test("a next-line directive that suppresses nothing reports DOC0036 with a safe deletion", async () => {
  const source = [
    "const url = import.meta.env.VITE_PUBLIC_URL;",
    `// doctor-disable-next-line ${secret} -- The secret moved server-side.`,
    "console.log(url);",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
    config: { rules: { [untyped]: "off" } },
  });
  const [report] = inline(result.diagnostics);
  expect(inline(result.diagnostics)).toHaveLength(1);
  expect(report).toMatchObject({
    code: "DOC0036",
    ruleId: "doctor/inline/unused-suppression",
    severity: "info",
    file: expect.stringMatching(/src\/main\.ts$/),
    range: { line: 2 },
    fix: { kind: "safe" },
  });
  expect(report!.why).toContain(secret);
  expect(report!.why).toContain("The secret moved server-side.");
  expect(applyFix(source, report)).toBe(
    ["const url = import.meta.env.VITE_PUBLIC_URL;", "console.log(url);", ""].join("\n"),
  );
});

test("a directive that suppresses a Diagnostic is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        `// doctor-disable-next-line ${secret} -- Read only in the server build.`,
        "console.log(import.meta.env.VITE_SECRET);",
        "",
      ].join("\n"),
    },
    config: { rules: { [untyped]: "off" } },
  });
  expect(inline(result.diagnostics)).toEqual([]);
  expect(result.suppressedDiagnostics).toMatchObject([{ ruleId: secret }]);
});

test("a same-line directive form is matched like the policy matches it", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        `console.log(import.meta.env.VITE_SECRET); // doctor-disable ${secret} -- Server build.`,
        `console.log(1); // doctor-disable ${secret} -- Stale.`,
        "",
      ].join("\n"),
    },
    config: { rules: { [untyped]: "off" } },
  });
  // The second directive's window reaches the first line, so both directives match it.
  expect(inline(result.diagnostics)).toEqual([]);
});

test("a trailing directive fix removes only the comment", async () => {
  const source = [
    "const a = 1;",
    "",
    "",
    `console.log(a); // doctor-disable ${secret} -- Stale.`,
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
  });
  const [report] = inline(result.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", range: { line: 4 } });
  expect(applyFix(source, report)).toBe(["const a = 1;", "", "", "console.log(a);", ""].join("\n"));
});

test("a multi-rule directive reports only the unused Rule and keeps the used one", async () => {
  const source = [
    `// doctor-disable-next-line ${untyped},${secret} -- Fixture values.`,
    "console.log(import.meta.env.VITE_PUBLIC_URL);",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
  });
  const reports = inline(result.diagnostics);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ code: "DOC0036", fix: { kind: "safe" } });
  expect(reports[0]!.why).toContain(secret);
  expect(applyFix(source, reports[0])).toBe(
    [
      `// doctor-disable-next-line ${untyped} -- Fixture values.`,
      "console.log(import.meta.env.VITE_PUBLIC_URL);",
      "",
    ].join("\n"),
  );
});

test("a directive inside a longer block comment removes only its own line", async () => {
  const source = [
    "/*",
    " * SAFETY: the value is public.",
    ` * doctor-disable-next-line ${secret} -- Stale.`,
    " */",
    "console.log(1);",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
  });
  const [report] = inline(result.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", range: { line: 3 } });
  expect(applyFix(source, report)).toBe(
    ["/*", " * SAFETY: the value is public.", " */", "console.log(1);", ""].join("\n"),
  );
});

test("a Vue template directive fix removes the whole HTML comment line", async () => {
  const source = [
    "<script setup>",
    "const url = 1;",
    "</script>",
    "<template>",
    `  <!-- doctor-disable-next-line ${secret} -- Stale. -->`,
    "  <p>{{ url }}</p>",
    "</template>",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vue",
    rules,
    files: { "src/App.vue": source },
  });
  const [report] = inline(result.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", range: { line: 5 } });
  expect(applyFix(source, report)).toBe(
    [
      "<script setup>",
      "const url = 1;",
      "</script>",
      "<template>",
      "  <p>{{ url }}</p>",
      "</template>",
      "",
    ].join("\n"),
  );
});

test("a JSX directive fix removes its empty expression container", async () => {
  const source = [
    "export const App = () => (",
    "  <div>",
    `    {/* doctor-disable-next-line ${secret} -- Stale. */}`,
    "    <p>hi</p>",
    "  </div>",
    ");",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/App.tsx": source },
  });
  const [report] = inline(result.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", range: { line: 3 } });
  expect(applyFix(source, report)).toBe(
    ["export const App = () => (", "  <div>", "    <p>hi</p>", "  </div>", ");", ""].join("\n"),
  );
});

test("a CRLF file keeps its line endings when a directive is deleted", async () => {
  const source = [`// doctor-disable-next-line ${secret} -- Stale.`, "console.log(1);", ""].join(
    "\r\n",
  );
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
  });
  const [report] = inline(result.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", range: { line: 1 } });
  expect(applyFix(source, report)).toBe("console.log(1);\r\n");
});

test("a fix keeps a SAFETY note written as the directive's reason", async () => {
  const source = [
    "declare const value: unknown;",
    `// doctor-disable-next-line ${secret} -- SAFETY: the value was validated above.`,
    "console.log(value as unknown as string);",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
  });
  const [report] = inline(result.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", fix: { kind: "safe" } });
  expect(applyFix(source, report)).toBe(
    [
      "declare const value: unknown;",
      "// SAFETY: the value was validated above.",
      "console.log(value as unknown as string);",
      "",
    ].join("\n"),
  );
});

test("a deletion that moves code under a same-line directive is only a suggestion", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        `console.log(import.meta.env.VITE_SECRET); // doctor-disable ${secret} -- Server build.`,
        `// doctor-disable-next-line ${untyped} -- Stale.`,
        "console.log(1);",
        "",
      ].join("\n"),
    },
  });
  expect(inline(result.diagnostics)).toMatchObject([
    { code: "DOC0036", range: { line: 2 }, fix: { kind: "suggestion" } },
  ]);
});

test("a directive above the wrong line says where its Rule still reports", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        `// doctor-disable-next-line ${secret} -- Server build.`,
        "const a = 1;",
        "console.log(a, import.meta.env.VITE_SECRET);",
        "",
      ].join("\n"),
    },
    config: { rules: { [untyped]: "off" } },
  });
  const [report] = inline(result.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", range: { line: 1 } });
  expect(report!.why).toContain("still reports VITE0009 on line 3");
});

test("a directive matched below the severity threshold is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        `// doctor-disable-next-line ${untyped} -- Declared elsewhere.`,
        "console.log(import.meta.env.VITE_PUBLIC_URL);",
        "",
      ].join("\n"),
    },
    run: { severity: "error" },
  });
  expect(inline(result.diagnostics)).toEqual([]);
});

const unusedDirective = {
  "src/main.ts": [
    `// doctor-disable-next-line ${secret} -- The secret moved server-side.`,
    "console.log(1);",
    "",
  ].join("\n"),
};

test.each([
  ["the Rule is turned off", { config: { rules: { [secret]: "off" as const } } }],
  ["another Rule is selected", { run: { rules: untyped } }],
  ["the run only runs analyses", { run: { analyses: "dead-code" } }],
  [
    "an override turns the Rule off for the file",
    { config: { overrides: [{ files: ["src/**"], rules: { [secret]: "off" as const } }] } },
  ],
])("a directive is not reported when %s", async (_, options) => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: unusedDirective,
    ...options,
  });
  expect(inline(result.diagnostics)).toEqual([]);
});

test("a directive is reported when its Rule is the selected Rule", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: unusedDirective,
    run: { rules: secret },
  });
  expect(inline(result.diagnostics)).toMatchObject([{ code: "DOC0036" }]);
});

test("a directive for a Rule outside the selected Presets is not reported", async () => {
  const root = await fixtureRoot(unusedDirective);
  try {
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      extensions: [fixtureExtension({ recommended: [untyped], strict: [untyped, secret] })],
    });
    expect(inline(result.diagnostics)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directive for a Rule that cannot run on the file is not reported", async () => {
  const templateOnly: DoctorRule = {
    ...noClientSecretPattern,
    meta: {
      ...noClientSecretPattern.meta,
      id: "vite/env/template-only",
      requires: { template: true },
    },
  };
  const result = await runProjectFixture({
    framework: "vite",
    rules: [templateOnly],
    files: {
      "src/main.ts": [
        "// doctor-disable-next-line vite/env/template-only -- Not a template.",
        "console.log(1);",
        "",
      ].join("\n"),
    },
  });
  expect(inline(result.diagnostics)).toEqual([]);
});

test("a directive for a Rule Pack that is not registered is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        "// doctor-disable-next-line vue/reactivity/defineprops-watch-getter -- From the Vue Rule Pack.",
        "console.log(1);",
        "",
      ].join("\n"),
    },
  });
  expect(inline(result.diagnostics)).toEqual([]);
});

test("a wildcard directive is never reported as unused", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": ["// doctor-disable-next-line * -- Generated.", "console.log(1);", ""].join(
        "\n",
      ),
    },
  });
  expect(inline(result.diagnostics)).toEqual([]);
});

test("a directive in a file Doctor could not parse is not reported", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        `// doctor-disable-next-line ${secret} -- Stale.`,
        "console.log(1);",
        "const = ;",
        "",
      ].join("\n"),
    },
  });
  expect(inline(result.diagnostics)).toEqual([]);
});

test("an unknown Rule ID in a registered namespace reports DOC0037", async () => {
  const source = [
    "// doctor-disable-next-line vite/env/no-removed-rule -- Old Rule.",
    "console.log(1);",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
  });
  const reports = inline(result.diagnostics);
  expect(reports).toMatchObject([
    {
      code: "DOC0037",
      ruleId: "doctor/inline/unknown-suppression-rule",
      severity: "info",
      range: { line: 1 },
      fix: { kind: "safe" },
    },
  ]);
  expect(reports[0]!.why).toContain("vite/env/no-removed-rule");
  expect(applyFix(source, reports[0])).toBe(["console.log(1);", ""].join("\n"));
});

test("a Diagnostic Code in a directive points at the Rule ID it belongs to", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": [
        "// doctor-disable-next-line VITE0009 -- Server build.",
        "console.log(import.meta.env.VITE_SECRET);",
        "",
      ].join("\n"),
    },
    config: { rules: { [untyped]: "off" } },
  });
  const reports = inline(result.diagnostics);
  expect(reports).toMatchObject([{ code: "DOC0037" }]);
  expect(reports[0]!.suggestion).toContain(secret);
});

test("a directive with unused and unknown Rule IDs shares one deletion", async () => {
  const source = [
    "const a = 1;",
    `// doctor-disable-next-line ${secret},vite/env/no-removed-rule -- Old.`,
    "console.log(a);",
    "",
  ].join("\n");
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: { "src/main.ts": source },
  });
  const reports = inline(result.diagnostics);
  expect(reports.map((report) => report.code).sort()).toEqual(["DOC0036", "DOC0037"]);
  expect(reports[0]!.fix!.edits).toEqual(reports[1]!.fix!.edits);
  expect(applyFix(source, reports[0])).toBe(["const a = 1;", "console.log(a);", ""].join("\n"));
});

test("--fix deletes unused directives and the next run is clean", async () => {
  const root = await fixtureRoot(unusedDirective);
  try {
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      fix: true,
      extensions: [fixtureExtension()],
    });
    expect(result.fixes).toMatchObject({ files: 1, edits: 1 });
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toBe("console.log(1);\n");
    expect(inline(result.diagnostics)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--fix preserves function braces, token separation and return line breaks", async () => {
  const directive = `doctor-disable-next-line ${secret} -- Stale.`;
  const root = await fixtureRoot({
    "src/main.js": [
      `export function empty() { /* ${directive} */ }`,
      `export const kind = typeof/* ${directive} */missing;`,
      `export function value() { return /* ${directive}`,
      "*/ 42; }",
      "",
    ].join("\n"),
  });
  try {
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      fix: true,
      extensions: [fixtureExtension()],
    });
    expect(result.fixes).toMatchObject({ files: 1, edits: 3 });
    const output = readFileSync(join(root, "src/main.js"), "utf8");
    const { empty, kind, value } = await import(
      `data:text/javascript,${encodeURIComponent(output)}`
    );
    expect(empty()).toBeUndefined();
    expect(kind).toBe("undefined");
    expect(value()).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  `/* doctor-disable-next-line ${secret} */ /* doctor-disable-next-line ${untyped} */`,
  [
    `console.log(import.meta.env.VITE_FIRST); // doctor-disable ${untyped}`,
    "/*",
    " *",
    " *",
    " *",
    ` * doctor-disable-next-line ${secret}`,
    " */",
  ].join("\n"),
])("--fix does not expand another directive's coverage: %s", async (comment) => {
  const source = `${comment}\nconsole.log(import.meta.env.VITE_UNDECLARED);\n`;
  const file = "src/main.ts";
  const root = await fixtureRoot({ [file]: source });
  try {
    const result = await runDoctor({
      root,
      framework: "vite",
      cache: false,
      fix: true,
      extensions: [fixtureExtension({ recommended: [secret, untyped] })],
    });
    expect(readFileSync(join(root, file), "utf8")).toBe(source);
    expect(result.diagnostics.some((diagnostic) => diagnostic.ruleId === untyped)).toBe(true);
    expect(inline(result.diagnostics)).toMatchObject([
      { code: "DOC0036", fix: { kind: "suggestion" } },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fix keeps a SAFETY reason continued onto another comment line", async () => {
  const source = [
    "declare const value: unknown;",
    "/*",
    ` * doctor-disable-next-line ${secret} -- SAFETY:`,
    " * The validator already checked the value.",
    " */",
    "console.log(value as string);",
    "",
  ].join("\n");
  const run = (text: string) =>
    runProjectFixture({
      framework: "vite",
      rules: [...rules, requireSafetyCommentForTypeAssertion],
      files: { "src/main.ts": text },
    });
  const before = await run(source);
  const [report] = inline(before.diagnostics);
  expect(report).toMatchObject({ code: "DOC0036", fix: { kind: "safe" } });
  const fixed = applyFix(source, report);
  expect(fixed).toContain(" * SAFETY:\n * The validator already checked the value.");
  expect((await run(fixed.replace("SAFETY:", "NOTE:"))).diagnostics).toContainEqual(
    expect.objectContaining({ code: "TS0008" }),
  );
  const after = await run(fixed);
  expect(after.diagnostics.filter(({ code }) => code === "TS0008")).toEqual([]);
  expect(inline(after.diagnostics)).toEqual([]);
});

test.each(["manifest", "workspace"] as const)(
  "a selected %s Rule without file coverage does not make its directive stale",
  async (execution) => {
    const projectRule: DoctorRule = {
      ...noUntypedEnv,
      meta: { ...noUntypedEnv.meta, execution },
      create: () => ({}),
    };
    const result = await runProjectFixture({
      framework: "vite",
      rules: [noClientSecretPattern, projectRule],
      files: {
        "src/main.ts": `// doctor-disable-next-line ${untyped}\nconsole.log(1);\n`,
      },
    });
    expect(inline(result.diagnostics)).toEqual([]);
  },
);

test("a line comment keeps a literal block terminator in its Rule ID", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    rules,
    files: {
      "src/main.ts": `// doctor-disable-next-line ${untyped}*/\nconsole.log(import.meta.env.VITE_UNDECLARED);\n`,
    },
  });
  expect(result.diagnostics.some((diagnostic) => diagnostic.ruleId === untyped)).toBe(true);
  expect(inline(result.diagnostics)).toMatchObject([{ code: "DOC0037" }]);
});

test("changed-file runs report only directives inside the change", async () => {
  const root = await fixtureRoot({
    "src/main.ts": "console.log(1);\n",
    "src/other.ts": unusedDirective["src/main.ts"],
  });
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init");
    git("add", ".");
    git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.com", "commit", "-m", "init");
    const run = () =>
      runDoctor({
        root,
        framework: "vite",
        cache: false,
        since: "HEAD",
        extensions: [fixtureExtension()],
      });

    writeFileSync(join(root, "src/main.ts"), "console.log(2);\n");
    expect(inline((await run()).diagnostics)).toEqual([]);

    writeFileSync(
      join(root, "src/main.ts"),
      `// doctor-disable-next-line ${secret} -- Added stale.\nconsole.log(2);\n`,
    );
    expect(inline((await run()).diagnostics)).toMatchObject([
      { code: "DOC0036", file: expect.stringMatching(/src\/main\.ts$/) },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureExtension(
  presets: { recommended: string[]; strict?: string[] } = { recommended: [secret] },
) {
  return defineDoctorExtension({
    name: "fixture",
    rulePacks: [defineRulePack({ name: "fixture", version: "0.0.0", rules, presets })],
  });
}

async function fixtureRoot(files: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "doctor-inline-suppression-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module", dependencies: { vite: "^7.0.0" } }),
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
