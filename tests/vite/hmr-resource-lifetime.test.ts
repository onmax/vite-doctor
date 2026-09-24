import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { requireDisposeForSideEffects } from "../../src/rule-packs/vite/rules/plugin-hmr.ts";

test("an unrelated dispose callback does not hide a leaked interval", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: {
      "src/main.ts": `const timer = setInterval(refresh, 1000)
import.meta.hot.accept()
import.meta.hot.dispose(() => { console.log('disposing') })`,
    },
  });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain(
    requireDisposeForSideEffects.meta.id,
  );
});

test("a matching cleanup satisfies the rule", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: {
      "src/main.ts": `const timer = setInterval(refresh, 1000)
import.meta.hot.accept()
import.meta.hot.dispose(() => { clearInterval(timer) })`,
    },
  });
  expect(
    result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
  ).toBe(false);
});

test("finds cleanup after a nested dispose block", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: {
      "src/main.ts": `const timer = setInterval(refresh, 1000)
import.meta.hot.accept()
import.meta.hot.dispose(() => {
  if (ready) { saveState() }
  clearInterval(timer)
})`,
    },
  });
  expect(
    result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
  ).toBe(false);
});

for (const [kind, setup, cleanup] of [
  ["interval", "const handle = setInterval(refresh, 1000)", "clearInterval(handle)"],
  ["timeout", "const handle = setTimeout(refresh, 1000)", "clearTimeout(handle)"],
  ["socket", "const handle = new WebSocket(url)", "handle.close()"],
  ["subscription", "const handle = events.subscribe(refresh)", "handle.unsubscribe()"],
]) {
  for (const callback of [
    (body: string) => `data => { ${body} }`,
    (body: string) => `function (data) { ${body} }`,
    (body: string) => `() => ${body}`,
    () => "cleanup",
  ]) {
    for (const cleaned of [false, true]) {
      test(`${kind}: ${callback("cleanup()")} ${cleaned ? "cleans" : "leaks"}`, async () => {
        const body = cleaned ? cleanup : "saveState()";
        const result = await runRuleFixture({
          framework: "vite",
          rule: requireDisposeForSideEffects,
          files: {
            "src/main.ts": `${setup}
function cleanup() { ${body} }
import.meta.hot.accept()
import.meta.hot.dispose(${callback(body)})`,
          },
        });
        expect(
          result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
        ).toBe(!cleaned);
      });
    }
  }
}

for (const [name, source, leaks] of [
  [
    "later cleanup replaces unrelated callback",
    `import.meta.hot.dispose(() => saveState())
import.meta.hot.dispose(() => clearInterval(timer))`,
    false,
  ],
  [
    "later unrelated callback replaces cleanup",
    `import.meta.hot.dispose(() => clearInterval(timer))
import.meta.hot.dispose(() => saveState())`,
    true,
  ],
  ["unknown callback cannot establish cleanup", "import.meta.hot.dispose(externalCleanup)", true],
  [
    "nested function is not executed by disposal",
    "import.meta.hot.dispose(() => { const cleanup = () => clearInterval(timer) })",
    true,
  ],
  [
    "local arrow callback",
    "const cleanup = () => clearInterval(timer); import.meta.hot.dispose(cleanup)",
    false,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: {
        "src/main.ts": `import.meta.hot.accept()
${source}
const timer = setInterval(refresh, 1000)`,
      },
    });
    expect(
      result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
    ).toBe(leaks);
  });
}

test("resources in deferred functions are not live module resources", async () => {
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: {
      "src/main.ts": `function start() { const timer = setInterval(refresh, 1000) }
import.meta.hot.accept()
import.meta.hot.dispose(() => saveState())`,
    },
  });
  expect(result.diagnostics).toEqual([]);
});

for (const [name, setup, callback, leaks] of [
  ["delegated helper", "function cleanup() { clearInterval(handle) }", "() => cleanup()", false],
  [
    "transitive helper",
    "const cleanup = () => finish(); function finish() { clearInterval(handle) }",
    "() => cleanup()",
    false,
  ],
  ["nested helper", "", "() => { function cleanup() { clearInterval(handle) }; cleanup() }", false],
  ["recursive helper without cleanup", "function cleanup() { cleanup() }", "() => cleanup()", true],
  [
    "recursive helper with cleanup",
    "function cleanup() { clearInterval(handle); cleanup() }",
    "() => cleanup()",
    false,
  ],
  ["shadowed helper", "function cleanup() { clearInterval(handle) }", "cleanup => cleanup()", true],
  ["window cleanup", "", "() => window.clearInterval(handle)", false],
  ["global cleanup", "", "() => globalThis.clearInterval(handle)", false],
  ["shadowed global", "", "window => window.clearInterval(handle)", true],
  ["shadowed cleanup function", "", "clearInterval => clearInterval(handle)", true],
  [
    "lexical helper scope",
    "function cleanup() { clearInterval(handle) }",
    "handle => cleanup()",
    false,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: {
        "src/main.ts": `const handle = setInterval(refresh, 1000)
${setup}
import.meta.hot.accept()
import.meta.hot.dispose(${callback})`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const [setup, cleanup] of [
  ["setInterval(refresh, 1000)", "clearInterval(handle)"],
  ["setTimeout(refresh, 1000)", "globalThis.clearTimeout(handle)"],
  ["new WebSocket(url)", "handle.close()"],
  ["events.subscribe(refresh)", "handle.unsubscribe()"],
]) {
  for (const callback of [
    `handle => { ${cleanup} }`,
    `() => { const handle = other; ${cleanup} }`,
    `() => { { const handle = other; ${cleanup} } }`,
    `({ handle }) => { ${cleanup} }`,
    `() => { try {} catch (handle) { ${cleanup} } }`,
    `() => { { var handle = other }; ${cleanup} }`,
  ]) {
    test(`shadowed ${setup}: ${callback}`, async () => {
      const result = await runRuleFixture({
        framework: "vite",
        rule: requireDisposeForSideEffects,
        files: {
          "src/main.ts": `const handle = ${setup}
import.meta.hot.accept()
import.meta.hot.dispose(${callback})`,
        },
      });
      expect(result.diagnostics.length).toBe(1);
    });
  }
}

for (const callback of ["unsubscribe", "() => unsubscribe()", "() => { unsubscribe() }"]) {
  test(`callable subscription: ${callback}`, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: {
        "src/main.ts": `const unsubscribe = store.subscribe(refresh)
import.meta.hot.accept()
import.meta.hot.dispose(${callback})`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });
}

for (const qualifier of ["window", "globalThis", "self"]) {
  test(`${qualifier} clears a timeout`, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: {
        "src/main.ts": `const timer = setTimeout(refresh, 1000)
import.meta.hot.accept()
import.meta.hot.dispose(() => ${qualifier}.clearTimeout(timer))`,
      },
    });
    expect(result.diagnostics).toEqual([]);
  });
}
