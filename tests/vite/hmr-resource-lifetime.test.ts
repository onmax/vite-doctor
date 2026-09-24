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

for (const [setup, cleanup] of [
  ["setInterval(refresh, 1000)", "clearInterval(value)"],
  ["setTimeout(refresh, 1000)", "clearTimeout(value)"],
  ["new WebSocket(url)", "value.close()"],
  ["events.subscribe(refresh)", "value.unsubscribe()"],
  ["events.subscribe(refresh)", "value()"],
]) {
  for (const [name, helpers, body, leaks] of [
    ["parameter", `function cleanup(value) { ${cleanup} }`, "cleanup(handle)", false],
    [
      "forwarded parameter",
      `function cleanup(value) { ${cleanup} }; function forward(value) { cleanup(value) }`,
      "forward(handle)",
      false,
    ],
    ["unrelated argument", `function cleanup(value) { ${cleanup} }`, "cleanup(other)", true],
    [
      "shadowed argument",
      `function cleanup(value) { ${cleanup} }`,
      "{ const handle = other; cleanup(handle) }",
      true,
    ],
    [
      "repeated helper",
      `function cleanup(value) { ${cleanup} }`,
      "cleanup(other); cleanup(handle)",
      false,
    ],
    ["asserted handle", "", cleanup.replaceAll("value", "handle!"), false],
    ["cast handle", "", cleanup.replaceAll("value", "(handle as any)"), false],
  ] as const) {
    test(`${setup}: ${name}`, async () => {
      const result = await runRuleFixture({
        framework: "vite",
        rule: requireDisposeForSideEffects,
        files: {
          "src/main.ts": `const handle = ${setup}
${helpers}
import.meta.hot.accept()
import.meta.hot.dispose(() => { ${body} })`,
        },
      });
      expect(result.diagnostics.length > 0).toBe(leaks);
    });
  }
}

for (const [name, source, leaks] of [
  [
    "imported timer",
    "import { setInterval } from 'scheduler'; const handle = setInterval(refresh); import.meta.hot.dispose(() => handle.cancel())",
    false,
  ],
  [
    "local timer",
    "function setTimeout() { return scheduler.start() }; const handle = setTimeout(); import.meta.hot.dispose(() => handle.cancel())",
    false,
  ],
  [
    "overwritten timer",
    "let timer = setInterval(refresh); timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "overwritten with non-resource",
    "let timer = setInterval(refresh); timer = other; import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "assigned timer cleaned",
    "let timer; timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "assigned timer leaked",
    "let timer; timer = setInterval(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `import.meta.hot.accept(); ${source}` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const [name, source, leaks] of [
  [
    "cleanup before reassignment",
    "let timer = setInterval(refresh); clearInterval(timer); timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "alias retains displaced resource",
    "let timer = setInterval(refresh); const previous = timer; timer = setInterval(refresh); import.meta.hot.dispose(() => { clearInterval(previous); clearInterval(timer) })",
    false,
  ],
  [
    "module handle alias",
    "const timer = setInterval(refresh); const activeTimer = timer; import.meta.hot.dispose(() => clearInterval(activeTimer))",
    false,
  ],
  [
    "callback handle alias",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { const activeTimer = timer; clearInterval(activeTimer) })",
    false,
  ],
  [
    "reassigned callback",
    "const timer = setInterval(refresh); let cleanup = () => clearInterval(timer); cleanup = saveState; import.meta.hot.dispose(cleanup)",
    true,
  ],
  [
    "callback reassigned after registration",
    "const timer = setInterval(refresh); let cleanup = () => clearInterval(timer); import.meta.hot.dispose(cleanup); cleanup = saveState",
    false,
  ],
  [
    "EventSource leak",
    "const stream = new EventSource(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "EventSource cleanup",
    "const stream = new EventSource(url); import.meta.hot.dispose(() => stream.close())",
    false,
  ],
  [
    "listener leak",
    "window.addEventListener('resize', refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "listener cleanup",
    "window.addEventListener('resize', refresh); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh))",
    false,
  ],
  [
    "listener wrong event",
    "window.addEventListener('resize', refresh); import.meta.hot.dispose(() => window.removeEventListener('scroll', refresh))",
    true,
  ],
  [
    "listener wrong capture",
    "window.addEventListener('resize', refresh, true); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh))",
    true,
  ],
  [
    "bare listener cleanup",
    "addEventListener('resize', refresh); import.meta.hot.dispose(() => removeEventListener('resize', refresh))",
    false,
  ],
  [
    "listener wrong handler",
    "window.addEventListener('resize', refresh); import.meta.hot.dispose(() => window.removeEventListener('resize', other))",
    true,
  ],
  [
    "listener wrong target",
    "window.addEventListener('resize', refresh); import.meta.hot.dispose(() => document.removeEventListener('resize', refresh))",
    true,
  ],
  [
    "listener shadowed handler",
    "window.addEventListener('resize', refresh); import.meta.hot.dispose(refresh => window.removeEventListener('resize', refresh))",
    true,
  ],
  [
    "reassigned cleanup helper",
    "const timer = setInterval(refresh); let cleanup = () => clearInterval(timer); cleanup = saveState; import.meta.hot.dispose(() => cleanup())",
    true,
  ],
  [
    "callback alias",
    "const timer = setInterval(refresh); const cleanup = () => clearInterval(timer); const finish = cleanup; import.meta.hot.dispose(finish)",
    false,
  ],
  [
    "listener capture options",
    "window.addEventListener('resize', refresh, { capture: true }); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh, true))",
    false,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `function refresh() {}; import.meta.hot.accept(); ${source}` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}
