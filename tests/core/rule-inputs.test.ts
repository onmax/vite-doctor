import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { RuleInputs } from "../../src/core/internal/rule-inputs.ts";
import { allDiagnostics, createRule } from "../../src/core/index.ts";
import { runProjectFixture } from "../../src/core/testkit.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-rule-inputs-"));
  mkdirSync(join(root, "src/nested/deep"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src/nested/b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "src/nested/deep/c.ts"), "export const c = 3;\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("ctx.fs records every read as a Rule input of the reading frame", () => {
  const inputs = new RuleInputs(root);
  const frame = inputs.frame();

  expect(frame.fs.readJson<{ name: string }>("package.json")?.name).toBe("fixture");
  expect(frame.fs.readText("missing.ts")).toBeUndefined();
  expect(frame.fs.exists("src")).toBe(true);
  expect(frame.fs.stat("src/a.ts")?.isFile()).toBe(true);
  expect(frame.fs.readDir("src")?.map((entry) => entry.name)).toContain("nested");
  expect(frame.fs.realpath("src")).toBe(join(root, "src"));

  expect(frame.readInputs()).toEqual([
    `t:${join(root, "package.json")}`,
    `t:${join(root, "missing.ts")}`,
    `e:${join(root, "src")}`,
    `e:${join(root, "src/a.ts")}`,
    `d:${join(root, "src")}`,
    `r:${join(root, "src")}`,
  ]);
  expect(inputs.frame().readInputs()).toEqual([]);
});

test("reading a file size records the size as its own Rule input", () => {
  const frame = new RuleInputs(root).frame();
  const stat = frame.fs.stat("src/a.ts")!;
  expect(frame.readInputs()).toEqual([`e:${join(root, "src/a.ts")}`]);
  expect(stat.size).toBe("export const a = 1;\n".length);
  expect(frame.readInputs()).toEqual([
    `e:${join(root, "src/a.ts")}`,
    `z:${join(root, "src/a.ts")}`,
  ]);
});

test("one Doctor Run answers each read once", () => {
  const inputs = new RuleInputs(root);
  const first = inputs.frame().fs.readText("src/a.ts");
  writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
  expect(inputs.frame().fs.readText("src/a.ts")).toBe(first);
  expect(new RuleInputs(root).frame().fs.readText("src/a.ts")).toBe("export const a = 2;\n");
});

test("readDirRecursive matches fs.readdirSync recursive order", () => {
  symlinkSync(join(root, "src/nested"), join(root, "src/linked"));
  const frame = new RuleInputs(root).frame();
  expect(frame.fs.readDirRecursive("src")).toEqual(
    readdirSync(join(root, "src"), { recursive: true }).map(String),
  );
  expect(frame.fs.readDirRecursive("absent")).toBeUndefined();
});

test("glob resolves matches and records its pattern", () => {
  const frame = new RuleInputs(root).frame();
  expect(frame.fs.glob("src/**/*.ts", { exclude: ["**/deep/**"] }).sort()).toEqual([
    join(root, "src/a.ts"),
    join(root, "src/nested/b.ts"),
  ]);
  expect(frame.readInputs()).toEqual([`g:${root}\0src/**/*.ts\0**/deep/**`]);
});

test("remembered values carry the inputs read to compute them", () => {
  const inputs = new RuleInputs(root);
  const writer = inputs.frame();
  writer.fs.readText("src/a.ts");
  expect(writer.cache.get("names")).toBeUndefined();
  writer.fs.readText("src/nested/b.ts");
  expect(writer.cache.get("inner")).toBeUndefined();
  writer.fs.readText("src/nested/deep/c.ts");
  writer.cache.set("inner", "c");
  writer.cache.set("names", ["b", "c"]);

  const reader = inputs.frame();
  expect(reader.cache.get("inner")).toBe("c");
  expect(reader.readInputs()).toEqual([`t:${join(root, "src/nested/deep/c.ts")}`]);
  const other = inputs.frame();
  expect(other.cache.get("names")).toEqual(["b", "c"]);
  expect(other.readInputs()).toEqual([
    `t:${join(root, "src/nested/b.ts")}`,
    `t:${join(root, "src/nested/deep/c.ts")}`,
  ]);
});

test("cache sets without a pending miss do not replace remembered inputs", () => {
  const inputs = new RuleInputs(root);
  const writer = inputs.frame();
  expect(writer.cache.get("value")).toBeUndefined();
  writer.fs.readText("src/a.ts");
  writer.cache.set("value", "first");

  const reader = inputs.frame();
  expect(reader.cache.get("value")).toBe("first");
  reader.fs.readText("src/nested/b.ts");
  reader.cache.set("value", "replacement");

  const next = inputs.frame();
  expect(next.cache.get("value")).toBe("first");
  expect(next.readInputs()).toEqual([`t:${join(root, "src/a.ts")}`]);
});

test("scoped frames keep remembered values apart", () => {
  const inputs = new RuleInputs(root);
  const appA = inputs.frame("packages/app-a");
  expect(appA.cache.get("sources")).toBeUndefined();
  appA.cache.set("sources", "a");

  const appB = inputs.frame("packages/app-b");
  expect(appB.cache.get("sources")).toBeUndefined();
  appB.cache.set("sources", "b");

  expect(inputs.frame().cache.get("sources")).toBeUndefined();
  expect(inputs.frame("packages/app-a").cache.get("sources")).toBe("a");
  expect(inputs.frame("packages/app-b").cache.get("sources")).toBe("b");
});

test("Rules read other project files through ctx.fs", async () => {
  const rule = createRule({
    meta: {
      id: "fixture/reads-sibling",
      title: "Reads a sibling file",
      category: "fixture",
      severity: "warn",
    },
    create(ctx) {
      if (!ctx.file.path.endsWith("a.ts")) return;
      const sibling = ctx.fs.readText("src/b.ts");
      if (!sibling?.includes("forbidden")) return;
      ctx.report(allDiagnostics.DOC9999({ why: "Sibling is forbidden.", fix: "Remove it." }), {
        range: ctx.range(0, 1),
      });
    },
  });
  const result = await runProjectFixture({
    framework: "vite",
    rules: [rule],
    files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const forbidden = 1;\n" },
  });
  expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
    "fixture/reads-sibling",
  ]);
});
