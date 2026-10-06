import { Linter } from "eslint";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  noInlineStyles,
  shadcnRulePack,
  shadcnRules,
} from "../../../src/rule-packs/shadcn/index.ts";
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
    expect.objectContaining({ code: "SHAD0004", ruleId: "shadcn/no-inline-styles" }),
  ]);
});

test("strict shadcn Rules parse each file once and report only their own findings", async () => {
  const verify = vi.spyOn(Linter.prototype, "verify");
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: shadcnRules,
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
    ["shadcn/no-raw-colors", "SHAD0002", "src/Card.tsx", 4, 25],
    ["shadcn/no-raw-colors", "SHAD0002", "src/Card.tsx", 5, 27],
    ["shadcn/no-raw-colors", "SHAD0002", "src/Disabled.tsx", 3, 25],
    ["shadcn/no-raw-colors", "SHAD0002", "src/Inline.tsx", 2, 44],
    ["shadcn/no-arbitrary-values", "SHAD0003", "src/Card.tsx", 4, 25],
    ["shadcn/no-arbitrary-values", "SHAD0003", "src/Card.tsx", 4, 25],
    ["shadcn/no-inline-styles", "SHAD0004", "src/Card.tsx", 4, 92],
    ["shadcn/no-inline-styles", "SHAD0004", "src/Inline.tsx", 2, 78],
    ["shadcn/no-unknown-classes", "SHAD0006", "src/Card.tsx", 4, 25],
  ]);
});

test("shadcn Rules share one ESLint verify per file when they run file by file", async () => {
  const files = Object.entries(scriptFiles).map(([relativePath, text]) => ({
    path: `/project/${relativePath}`,
    relativePath,
    text,
    hash: relativePath,
    scriptAst: { type: "Program" },
  }));
  const lint = async (order: Array<[DoctorRule, (typeof files)[number]]>) => {
    const cache = {};
    const reports: unknown[] = [];
    const report: RuleContext["report"] = (diagnostic, metadata) =>
      reports.push({ diagnostic, ...metadata });
    for (const [rule, file] of order)
      await rule.create({
        file,
        cache,
        options: undefined,
        severity: "warn",
        report,
      } as unknown as RuleContext);
    return reports;
  };
  const ruleMajor = await lint(
    shadcnRules.flatMap((rule) => files.map((file) => [rule, file] as [DoctorRule, typeof file])),
  );

  const verify = vi.spyOn(Linter.prototype, "verify");
  const fileMajor = await lint(
    files.flatMap((file) => shadcnRules.map((rule) => [rule, file] as [DoctorRule, typeof file])),
  );

  // The first file teaches the run which shadcn Rules are enabled; every later file is one verify.
  expect(verify).toHaveBeenCalledTimes(shadcnRules.length + files.length - 1);
  expect(fileMajor).toHaveLength(ruleMajor.length);
  expect(fileMajor).toEqual(expect.arrayContaining(ruleMajor));
});

test("uses Tailwind package activation and composed presets", () => {
  expect(shadcnRulePack.activation).toEqual({ packages: ["tailwindcss"] });
  expect(shadcnRulePack.presets.recommended).toEqual([
    "shadcn/no-raw-colors",
    "shadcn/no-arbitrary-values",
    "shadcn/no-inline-styles",
  ]);
  expect(shadcnRulePack.presets.strict).toEqual([
    "shadcn/no-restyle",
    "shadcn/no-raw-colors",
    "shadcn/no-arbitrary-values",
    "shadcn/no-inline-styles",
    "shadcn/require-static-classes",
    "shadcn/no-unknown-classes",
  ]);
});
