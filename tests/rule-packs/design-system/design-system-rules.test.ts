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

const fileRules = designSystemRules.filter((rule) => rule.meta.execution === "file");

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
    ["design-system/no-restyle", "DS0001", "src/Card.tsx", 5, 27],
    ["design-system/no-restyle", "DS0001", "src/Card.tsx", 5, 27],
    ["design-system/no-restyle", "DS0001", "src/Card.tsx", 5, 64],
    ["design-system/no-raw-colors", "DS0002", "src/Card.tsx", 4, 25],
    ["design-system/no-raw-colors", "DS0002", "src/Card.tsx", 5, 27],
    ["design-system/no-raw-colors", "DS0002", "src/Disabled.tsx", 3, 25],
    ["design-system/no-raw-colors", "DS0002", "src/Inline.tsx", 2, 44],
    ["design-system/no-arbitrary-values", "DS0003", "src/Card.tsx", 4, 25],
    ["design-system/no-arbitrary-values", "DS0003", "src/Card.tsx", 4, 25],
    ["design-system/no-inline-styles", "DS0004", "src/Card.tsx", 4, 92],
    ["design-system/no-inline-styles", "DS0004", "src/Inline.tsx", 2, 78],
    ["design-system/require-static-classes", "DS0005", "src/Card.tsx", 6, 24],
    ["design-system/no-unknown-classes", "DS0006", "src/Card.tsx", 4, 25],
  ]);
});

test("design-system Rules share one ESLint verify per file when they run file by file", async () => {
  const files = Object.entries(scriptFiles).map(([relativePath, text]) => ({
    path: `/project/${relativePath}`,
    relativePath,
    text,
    hash: relativePath,
    scriptAst: { type: "Program" },
  }));
  const lint = async (order: Array<[DoctorRule, (typeof files)[number]]>) => {
    const project = { root: "/project" };
    const reports: unknown[] = [];
    const report: RuleContext["report"] = (diagnostic, metadata) =>
      reports.push({ diagnostic, ...metadata });
    for (const [rule, file] of order)
      await rule.create({
        file,
        project,
        options: undefined,
        severity: "warn",
        cache: new Map(),
        report,
      } as unknown as RuleContext);
    return reports;
  };
  const ruleMajor = await lint(
    fileRules.flatMap((rule) => files.map((file) => [rule, file] as [DoctorRule, typeof file])),
  );

  const verify = vi.spyOn(Linter.prototype, "verify");
  const fileMajor = await lint(
    files.flatMap((file) => fileRules.map((rule) => [rule, file] as [DoctorRule, typeof file])),
  );

  // The first file teaches the run which design-system Rules are enabled; every later file is one verify.
  expect(verify).toHaveBeenCalledTimes(fileRules.length + files.length - 1);
  expect(fileMajor).toHaveLength(ruleMajor.length);
  expect(fileMajor).toEqual(expect.arrayContaining(ruleMajor));
});

test("design-system Rules skip the ESLint parse for files that cannot hold a class, style, or helper call", async () => {
  const verify = vi.spyOn(Linter.prototype, "verify");
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: designSystemRules,
    config: {
      rules: { "design-system/no-raw-colors": ["warn", { settings: { mergeFunctions: "tw" } }] },
    },
    files: {
      "src/server.ts": "export const handler = () => new Response('ok');\n",
      "src/math.tsx": "export const sum = (a: number, b: number) => a + b;\n",
      "src/Plain.vue": "<template>\n  <p>Hello</p>\n</template>\n",
      // Plain TypeScript has no JSX, so only class helpers count, including configured ones.
      "src/names.ts": "export const className = 'text-red-500';\n",
      "src/variants.ts": "export const card = tw('bg-red-500');\n",
      "src/Card.tsx": 'export const Card = () => <div className="bg-red-500" />;\n',
      "src/Card.vue": '<template>\n  <div class="bg-red-500" />\n</template>\n',
    },
  });

  const parsed = verify.mock.calls.map(([, , options]) =>
    typeof options === "string" ? options : options?.filename,
  );
  expect(new Set(parsed)).toEqual(new Set(["src/variants.ts", "src/Card.tsx", "src/Card.vue"]));
  expect(
    result.diagnostics
      .filter((d) => d.ruleId === "design-system/no-raw-colors")
      .map((d) => d.file.slice(d.file.indexOf("src/")))
      .sort(),
  ).toEqual(["src/Card.tsx", "src/Card.vue", "src/variants.ts"]);
});

test("design-system Rules parse files whose escapes or character references spell a class site", async () => {
  const result = await runProjectFixture({
    framework: "vue",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: designSystemRules,
    files: {
      "src/Spread.tsx":
        "export const Box = () => <div {...{ ['st\\u0079le']: { width: 100 } }} />;\n",
      "src/Bound.vue":
        "<template>\n  <div v-bind=\"{ ['st&#121;le']: { width: 100 } }\" />\n</template>\n",
      "src/helper.ts": [
        "declare function c\\u006e(...items: string[]): string;",
        "export const className = c\\u006e('bg-red-500', 'p-[13px]');",
        "",
      ].join("\n"),
    },
  });

  expect(
    result.diagnostics.map((d) => `${d.file.slice(d.file.indexOf("src/"))} ${d.code}`).toSorted(),
  ).toEqual([
    "src/Bound.vue DS0004",
    "src/Spread.tsx DS0004",
    "src/helper.ts DS0002",
    "src/helper.ts DS0003",
  ]);
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

test.each([
  [
    'Replace with "{{suggestions}}" (same value, on the scale).',
    'Replace with "p-3.25" (same value, on the scale).',
  ],
  [
    'Replace with   "{{suggestions}}" (same value, on the scale).',
    'Replace with   "p-3.25" (same value, on the scale).',
  ],
  ["Repeat this. Repeat this.", "Repeat this. Repeat this."],
])("preserves a custom message without repeating it as the remedy: %s", async (message, why) => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noArbitraryValues],
    config: { rules: { "design-system/no-arbitrary-values": ["warn", { message }] } },
    files: { "src/Box.tsx": 'export const Box = () => <div className="p-[13px]" />' },
  });
  expect(result.diagnostics).toMatchObject([{ why, fix: { kind: "suggestion" } }]);
  expect(result.diagnostics[0]?.suggestion).not.toBe(why);
});

test("preserves settings notes and distinguishing text on findings at the same location", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noArbitraryValues],
    config: {
      rules: {
        "design-system/no-arbitrary-values": [
          "warn",
          {
            options: {
              message: "Off-scale spacing value. Replace {{className}} with {{suggestions}}.",
            },
            settings: { note: "Apply only spacing tokens approved in DESIGN.md." },
          },
        ],
      },
    },
    files: { "src/Box.tsx": 'export const Box = () => <div className="p-[13px] m-[13px]" />' },
  });
  expect(result.diagnostics.map(({ why }) => why).sort()).toEqual([
    "Off-scale spacing value. Replace m-[13px] with m-3.25. Apply only spacing tokens approved in DESIGN.md.",
    "Off-scale spacing value. Replace p-[13px] with p-3.25. Apply only spacing tokens approved in DESIGN.md.",
  ]);
});

test("uses the imported Tailwind theme in a project outside the working directory", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noArbitraryValues],
    files: {
      "src/theme.css": '@import "tailwindcss";\n@theme { --spacing: 5px; }',
      "src/Box.tsx":
        'import "./theme.css";\nexport const Box = () => <div className="p-[13px] m-[15px]" />',
    },
  });
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ why: expect.stringContaining('"p-[13px]"'), fix: null }),
      expect.objectContaining({
        why: expect.stringContaining('"m-[15px]"'),
        fix: expect.objectContaining({ message: expect.stringContaining('"m-3"') }),
      }),
    ]),
  );
});

test("a structured suggestion applies cleanly to BOM-prefixed JSX", async () => {
  const source = '\uFEFFexport const Box = () => <div className="p-[13px]" />';
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noArbitraryValues],
    files: { "src/Box.tsx": source },
  });
  const edit = result.diagnostics[0]?.fix?.edits?.[0];
  expect(edit).toBeDefined();
  const { range, text } = edit!;
  expect(source.slice(0, range.start) + text + source.slice(range.end)).toBe(
    '\uFEFFexport const Box = () => <div className="p-3.25" />',
  );
});

test.each([
  ["text-[13px]", '"text-xs" (12px)', '"text-sm" (14px)'],
  ["rounded-[5px]", '"rounded-sm" (4px)', '"rounded-md" (6px)'],
])("keeps measurements outside the quoted replacement for %s", async (className, first, second) => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noArbitraryValues],
    files: { "src/Box.tsx": `export const Box = () => <div className="${className}" />` },
  });
  expect(result.diagnostics[0]?.suggestion).toBe(
    `Replace "${className}" with one of the nearest scale values: ${first}, ${second}.`,
  );
});

test("warns when a baseline predates the Design System rename", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noArbitraryValues],
    files: {
      "src/Box.tsx": 'export const Box = () => <div className="p-[13px]" />',
      "baseline.json": JSON.stringify({
        version: 2,
        fingerprintScheme: 3,
        diagnostics: [{ fingerprint: "a".repeat(64) }],
      }),
    },
    run: { baseline: "baseline.json", newOnly: true },
  });
  expect(result.diagnostics.map(({ code }) => code)).toContain("DOC0032");
});

test("Nuxt UI tokens do not exempt a restyled design-system component", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0", "@nuxt/ui": "^4.0.0" },
    rules: designSystemRules,
    files: {
      "src/styles.css": '@import "tailwindcss";\n@theme { --color-primary: #3b82f6; }\n',
      "src/components/ui/button.tsx": scriptFiles["src/components/ui/button.tsx"],
      "src/Card.tsx": [
        'import { Button } from "@/components/ui/button";',
        "export const Card = () => (",
        "  <>",
        '    <Button className="text-primary" />',
        '    <Button className="bg-muted" />',
        "  </>",
        ");",
      ].join("\n"),
    },
  });
  expect(result.diagnostics.filter((d) => d.code === "DS0001").map((d) => d.range?.line)).toEqual([
    4, 5,
  ]);
});

test("reports JSX colors after a self-closing SVG mask", async () => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: designSystemRules,
    files: {
      "src/styles.css": '@import "tailwindcss";\n@theme { --color-primary: #3b82f6; }\n',
      "src/Icon.tsx": [
        "export const Icon = () => (",
        "  <svg>",
        '    <mask id="a"><path fill="#ffffff" /></mask>',
        '    <mask id="b" />',
        '    <path fill="#123456" />',
        "  </svg>",
        ");",
      ].join("\n"),
    },
  });
  expect(result.diagnostics.filter((d) => d.code === "DS0002").map((d) => d.range?.line)).toEqual([
    5,
  ]);
});

test.each([
  ["", []],
  [`<path fill="url( '#fade' )" />`, [4]],
  ['<linearGradient id="paint" xlinkHref="#fade" /><path fill="url(#paint)" />', [4]],
])("only exempts a provably mask-only JSX gradient (%s)", async (paint, lines) => {
  const result = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: designSystemRules,
    files: {
      "src/styles.css": '@import "tailwindcss";\n',
      "src/Icon.tsx": [
        "export const Icon = () => (",
        "  <svg>",
        "    <defs>",
        '      <linearGradient id="fade"><stop stopColor="#123456" /></linearGradient>',
        `      <mask id="clip"><rect fill="url( '#fade' )" /></mask>`,
        "    </defs>",
        paint,
        "  </svg>",
        ");",
      ].join("\n"),
    },
  });
  expect(
    result.diagnostics
      .filter((finding) => finding.code === "DS0002")
      .map((finding) => finding.range?.line),
  ).toEqual(lines);
});

test("skips Next.js image routes only in a Next.js app", async () => {
  const route = 'export default function Image() { return <div style={{ color: "#21201c" }} /> }\n';
  const files = {
    "src/styles.css": '@import "tailwindcss";\n@theme { --color-primary: #3b82f6; }\n',
    "app/opengraph-image.tsx": route,
    "src/components/opengraph-image.tsx": route,
  };
  const vite = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0" },
    rules: [noInlineStyles],
    files,
  });
  expect(
    vite.diagnostics
      .map((d) => d.file.slice(d.file.lastIndexOf("/", d.file.lastIndexOf("/") - 1) + 1))
      .toSorted(),
  ).toEqual(["app/opengraph-image.tsx", "components/opengraph-image.tsx"]);
  const next = await runProjectFixture({
    framework: "vite",
    dependencies: { tailwindcss: "^4.0.0", next: "^16.0.0" },
    rules: [noInlineStyles],
    files,
  });
  expect(next.diagnostics.map((d) => d.file.slice(d.file.indexOf("/src/") + 1))).toEqual([
    "src/components/opengraph-image.tsx",
  ]);
});
