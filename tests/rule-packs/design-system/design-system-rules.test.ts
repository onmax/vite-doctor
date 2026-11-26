import { Linter } from "eslint";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  noArbitraryValues,
  noInlineStyles,
  designSystemRulePack,
  designSystemRules,
} from "../../../src/rule-packs/design-system/index.ts";
import {
  designSystemCopy,
  designSystemMessageCopy,
} from "../../../src/rule-packs/design-system/rules/copy.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import type { DoctorRule, RuleContext } from "../../../src/core/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const scriptFiles = {
  "src/components/ui/button.tsx":
    'export function Button(props: any) { return <button className="bg-primary px-4" {...props} /> }\n',
  "src/Card.tsx": [
    'import { Button } from "@/components/ui/button";',
    'import { cn } from "@/lib/utils";',
    "export function Card({ active }: { active: boolean }) {",
    '  return <div className="bg-red-500 p-[13px] text-[#ff0000] made-up-class" style={{ color: "red" }}>',
    '    <Button className={cn("rounded-none bg-blue-500", active ? "font-bold" : "")} />',
    "    <Button className={`px-${active ? 2 : 4}`} />",
    "  </div>",
    "}",
  ].join("\n"),
  "src/Disabled.tsx": [
    "export function Disabled() {",
    "  // eslint-disable-next-line shadcn/no-inline-styles",
    '  return <div className="bg-red-500" style={{ color: "red" }} />',
    "}",
  ].join("\n"),
  "src/Inline.tsx": [
    "/* eslint shadcn/no-raw-colors: [ */",
    'export const Inline = () => <div className="text-green-500" style={{ margin: 1 }} />',
  ].join("\n"),
  "src/Broken.tsx":
    "export const Broken = () => <div className=\"bg-red-500\" style={{ color: 'red' }}",
};

test("activates for Tailwind projects and adapts upstream diagnostics", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noInlineStyles],
    files: {
      "src/Button.tsx": "export function Button() { return <button style={{color: 'red'}} /> }",
    },
  });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "DS0004", ruleId: "design-system/no-inline-styles" }),
  ]);
});

test("strict design-system Rules parse each file once and report only their own findings", async () => {
  const verify = vi.spyOn(Linter.prototype, "verify");
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: designSystemRules,
    files: {
      "src/styles.css":
        '@import "tailwindcss";\n@theme { --color-primary: #3b82f6; --color-muted: #f4f4f5; }\n',
      ...scriptFiles,
    },
  });

  const parses = verify.mock.calls.filter(([source]) => typeof source === "string");
  expect(parses).toHaveLength(Object.keys(scriptFiles).length);
  expect(
    result.diagnostics.map((d) => [
      d.ruleId,
      d.code,
      d.file.slice(d.file.indexOf("src/")),
      d.range?.line,
      d.range?.column,
    ]),
  ).toEqual([
    ["design-system/no-raw-colors", "DS0002", "src/Card.tsx", 4, 25],
    ["design-system/no-raw-colors", "DS0002", "src/Card.tsx", 5, 27],
    ["design-system/no-raw-colors", "DS0002", "src/Disabled.tsx", 3, 25],
    ["design-system/no-raw-colors", "DS0002", "src/Inline.tsx", 2, 44],
    ["design-system/no-arbitrary-values", "DS0003", "src/Card.tsx", 4, 25],
    ["design-system/no-arbitrary-values", "DS0003", "src/Card.tsx", 4, 25],
    ["design-system/no-inline-styles", "DS0004", "src/Card.tsx", 4, 92],
    ["design-system/no-inline-styles", "DS0004", "src/Inline.tsx", 2, 78],
    ["design-system/no-unknown-classes", "DS0006", "src/Card.tsx", 4, 25],
  ]);
});

test("design-system Rules share one ESLint verify per file when they run file by file", async () => {
  const lintRules = designSystemRules.filter((rule) => rule.meta.execution === "file");
  const files = Object.entries(scriptFiles).map(([relativePath, text]) => ({
    path: `/project/${relativePath}`,
    relativePath,
    text,
    hash: relativePath,
    scriptAst: { type: "Program" },
  }));
  const lint = async (order: Array<[DoctorRule, (typeof files)[number]]>) => {
    const project = {};
    const reports: unknown[] = [];
    const report: RuleContext["report"] = (diagnostic, metadata) =>
      reports.push({ diagnostic, ...metadata });
    for (const [rule, file] of order)
      await rule.create({
        file,
        project,
        options: undefined,
        severity: "warn",
        report,
      } as unknown as RuleContext);
    return reports;
  };
  const ruleMajor = await lint(
    lintRules.flatMap((rule) => files.map((file) => [rule, file] as [DoctorRule, typeof file])),
  );

  const verify = vi.spyOn(Linter.prototype, "verify");
  const fileMajor = await lint(
    files.flatMap((file) => lintRules.map((rule) => [rule, file] as [DoctorRule, typeof file])),
  );

  // The first file teaches the run which design-system Rules are enabled; every later file is one verify.
  expect(verify).toHaveBeenCalledTimes(lintRules.length + files.length - 1);
  expect(fileMajor).toHaveLength(ruleMajor.length);
  expect(fileMajor).toEqual(expect.arrayContaining(ruleMajor));
});

test("uses Tailwind and Nuxt UI package activation and composed presets", () => {
  expect(designSystemRulePack.activation).toEqual({ packages: ["tailwindcss", "@nuxt/ui"] });
  expect(designSystemRulePack.presets.recommended.toSorted()).toEqual([
    "design-system/no-arbitrary-values",
    "design-system/no-inline-styles",
    "design-system/no-raw-colors",
    "design-system/prefer-project-component",
    "design-system/unreadable-contract",
  ]);
  expect(designSystemRulePack.presets.strict?.toSorted()).toEqual([
    "design-system/no-arbitrary-values",
    "design-system/no-inline-styles",
    "design-system/no-raw-colors",
    "design-system/no-restyle",
    "design-system/no-unknown-classes",
    "design-system/prefer-project-component",
    "design-system/require-static-classes",
    "design-system/unreadable-contract",
  ]);
});

test("every upstream @shadcn/lint messageId has Doctor copy", async () => {
  const { plugin } = await import("@shadcn/lint");
  const missing = Object.entries(plugin.rules).flatMap(([rule, definition]) =>
    Object.keys(definition.meta?.messages ?? {})
      .filter((messageId) => !designSystemMessageCopy[rule]?.[messageId])
      .map((messageId) => `${rule}:${messageId}`),
  );
  expect(missing).toEqual([]);
});

test("every upstream finding gets a consequence and a remedy distinct from its why", async () => {
  const { plugin } = await import("@shadcn/lint");
  for (const [rule, definition] of Object.entries(plugin.rules)) {
    const templates = (definition.meta?.messages ?? {}) as Record<string, string>;
    for (const [messageId, template] of Object.entries(templates)) {
      const entry = designSystemMessageCopy[rule]?.[messageId];
      if (entry === "suggestion") continue;
      const message = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => `<${name}>`);
      const copy = designSystemCopy(
        rule,
        { messageId, message } as Linter.LintMessage,
        templates,
        "https://example.com",
      );
      const label = `${rule}:${messageId}`;
      expect(copy.why.endsWith(` ${entry?.consequence}`), label).toBe(true);
      expect(copy.fix, label).not.toBe("");
      expect(copy.fix, label).not.toBe(copy.why);
      expect(`${copy.why} ${copy.fix}`, label).not.toMatch(/\{\{|undefined/);
    }
  }
});

test("splits upstream findings into problem and consequence, then the remedy", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noInlineStyles],
    files: {
      "src/Button.tsx": "export function Button() { return <button style={{color: 'red'}} /> }",
    },
  });
  const [diagnostic] = result.diagnostics;
  expect(diagnostic?.why).toBe(
    "Inline style sets color. Inline styles skip the theme, so this element keeps the same look when the theme, dark mode, or a hover or breakpoint state changes.",
  );
  expect(diagnostic?.suggestion).toBe(
    "Style through classes; use CSS custom properties for dynamic values.",
  );
});

test("carries the upstream suggestion as a structured suggestion edit", async () => {
  const source = 'export const Box = () => <div className="p-[13px]" />';
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noArbitraryValues],
    files: { "src/Box.tsx": source },
  });
  const [diagnostic] = result.diagnostics;
  const start = source.indexOf('"p-[13px]"');
  expect(diagnostic?.fix).toEqual({
    kind: "suggestion",
    message: 'Replace with "p-3.25" (same value, on the scale).',
    edits: [{ range: { start, end: start + '"p-[13px]"'.length }, text: '"p-3.25"' }],
  });
  expect(diagnostic?.why).toBe(
    '"p-[13px]" hardcodes an off-token value. One-off values sit off the spacing and sizing scale, so this element lines up differently from the rest of the interface.',
  );
  expect(diagnostic?.suggestion).toBe(
    'Replace "p-[13px]" with "p-3.25" (same value, on the scale).',
  );
});

test("a custom upstream message keeps its text as the why and points the fix at the Rule docs", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noInlineStyles],
    config: {
      rules: {
        "design-system/no-inline-styles": ["warn", { message: "Inline styles are banned" }],
      },
    },
    files: {
      "src/Button.tsx": "export function Button() { return <button style={{color: 'red'}} /> }",
    },
  });
  const [diagnostic] = result.diagnostics;
  expect(diagnostic?.why).toBe("Inline styles are banned");
  expect(diagnostic?.suggestion).toBe(`Resolve it as ${noInlineStyles.meta.docsUrl} describes.`);
});
