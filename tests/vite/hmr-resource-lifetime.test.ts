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
  [
    "aliased global target mismatch",
    "const target = window; const other = document; target.addEventListener('resize', refresh); import.meta.hot.dispose(() => other.removeEventListener('resize', refresh))",
    true,
  ],
  [
    "aliased global target cleanup",
    "const target = window; target.addEventListener('resize', refresh); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh))",
    false,
  ],
  [
    "aliased unresolved handler mismatch",
    "const handler = externalHandler; const other = otherHandler; window.addEventListener('resize', handler); import.meta.hot.dispose(() => window.removeEventListener('resize', other))",
    true,
  ],
  [
    "named capture object",
    "const options = { capture: true }; window.addEventListener('resize', refresh, options); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh, options))",
    false,
  ],
  [
    "named capture boolean",
    "const options = true; window.addEventListener('resize', refresh, options); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh, true))",
    false,
  ],
  [
    "named capture mismatch",
    "const options = { capture: true }; window.addEventListener('resize', refresh, options); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh, false))",
    true,
  ],
  [
    "shadowed listener functions",
    "function addEventListener() {}; function removeEventListener() {}; addEventListener('resize', refresh); import.meta.hot.dispose(() => removeEventListener('resize', refresh))",
    false,
  ],
  [
    "imported listener functions",
    "import { addEventListener, removeEventListener } from 'custom'; addEventListener('resize', refresh); import.meta.hot.dispose(() => removeEventListener('resize', refresh))",
    false,
  ],
  [
    "window setInterval(refresh) leak",
    "const resource = window.setInterval(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "window setInterval(refresh) cleanup",
    "const resource = window.setInterval(refresh); import.meta.hot.dispose(() => clearInterval(resource))",
    false,
  ],
  [
    "window setTimeout(refresh) leak",
    "const resource = window.setTimeout(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "window setTimeout(refresh) cleanup",
    "const resource = window.setTimeout(refresh); import.meta.hot.dispose(() => clearTimeout(resource))",
    false,
  ],
  [
    "window new WebSocket(url) leak",
    "const resource = new window.WebSocket(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "window new WebSocket(url) cleanup",
    "const resource = new window.WebSocket(url); import.meta.hot.dispose(() => resource.close())",
    false,
  ],
  [
    "window new EventSource(url) leak",
    "const resource = new window.EventSource(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "window new EventSource(url) cleanup",
    "const resource = new window.EventSource(url); import.meta.hot.dispose(() => resource.close())",
    false,
  ],
  [
    "shadowed window constructor",
    "const window = custom; const resource = window.setInterval(refresh); import.meta.hot.dispose(() => saveState())",
    false,
  ],
  [
    "globalThis setInterval(refresh) leak",
    "const resource = globalThis.setInterval(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "globalThis setInterval(refresh) cleanup",
    "const resource = globalThis.setInterval(refresh); import.meta.hot.dispose(() => clearInterval(resource))",
    false,
  ],
  [
    "globalThis setTimeout(refresh) leak",
    "const resource = globalThis.setTimeout(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "globalThis setTimeout(refresh) cleanup",
    "const resource = globalThis.setTimeout(refresh); import.meta.hot.dispose(() => clearTimeout(resource))",
    false,
  ],
  [
    "globalThis new WebSocket(url) leak",
    "const resource = new globalThis.WebSocket(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "globalThis new WebSocket(url) cleanup",
    "const resource = new globalThis.WebSocket(url); import.meta.hot.dispose(() => resource.close())",
    false,
  ],
  [
    "globalThis new EventSource(url) leak",
    "const resource = new globalThis.EventSource(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "globalThis new EventSource(url) cleanup",
    "const resource = new globalThis.EventSource(url); import.meta.hot.dispose(() => resource.close())",
    false,
  ],
  [
    "shadowed globalThis constructor",
    "const globalThis = custom; const resource = globalThis.setInterval(refresh); import.meta.hot.dispose(() => saveState())",
    false,
  ],
  [
    "self setInterval(refresh) leak",
    "const resource = self.setInterval(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "self setInterval(refresh) cleanup",
    "const resource = self.setInterval(refresh); import.meta.hot.dispose(() => clearInterval(resource))",
    false,
  ],
  [
    "self setTimeout(refresh) leak",
    "const resource = self.setTimeout(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "self setTimeout(refresh) cleanup",
    "const resource = self.setTimeout(refresh); import.meta.hot.dispose(() => clearTimeout(resource))",
    false,
  ],
  [
    "self new WebSocket(url) leak",
    "const resource = new self.WebSocket(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "self new WebSocket(url) cleanup",
    "const resource = new self.WebSocket(url); import.meta.hot.dispose(() => resource.close())",
    false,
  ],
  [
    "self new EventSource(url) leak",
    "const resource = new self.EventSource(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "self new EventSource(url) cleanup",
    "const resource = new self.EventSource(url); import.meta.hot.dispose(() => resource.close())",
    false,
  ],
  [
    "shadowed self constructor",
    "const self = custom; const resource = self.setInterval(refresh); import.meta.hot.dispose(() => saveState())",
    false,
  ],
  [
    "bound socket cleanup",
    "const socket = new WebSocket(url); import.meta.hot.dispose(socket.close.bind(socket))",
    false,
  ],
  [
    "bound socket wrong receiver",
    "const socket = new WebSocket(url); const other = new WebSocket(url); import.meta.hot.dispose(socket.close.bind(other))",
    true,
  ],
  [
    "bound helper",
    "const timer = setInterval(refresh); function cleanup() { clearInterval(timer) }; import.meta.hot.dispose(cleanup.bind(null))",
    false,
  ],
  [
    "bound helper argument",
    "const timer = setInterval(refresh); function cleanup(handle) { clearInterval(handle) }; const dispose = cleanup.bind(null, timer); import.meta.hot.dispose(dispose)",
    false,
  ],
  [
    "bound unrelated helper",
    "const timer = setInterval(refresh); function cleanup() { saveState() }; import.meta.hot.dispose(cleanup.bind(null))",
    true,
  ],
  [
    "abort listener",
    'const controller = new AbortController(); window.addEventListener("resize", refresh, { signal: controller.signal }); import.meta.hot.dispose(() => controller.abort())',
    false,
  ],
  [
    "abort other controller",
    'const controller = new AbortController(); const other = new AbortController(); window.addEventListener("resize", refresh, { signal: controller.signal }); import.meta.hot.dispose(() => other.abort())',
    true,
  ],
  [
    "abort aliased signal",
    'const controller = new AbortController(); const signal = controller.signal; const options = { signal }; window.addEventListener("resize", refresh, options); import.meta.hot.dispose(controller.abort.bind(controller))',
    false,
  ],
  [
    "mutated event member",
    'const names = { current: "resize" }; window.addEventListener(names.current, refresh); names.current = "scroll"; import.meta.hot.dispose(() => window.removeEventListener(names.current, refresh))',
    true,
  ],
  [
    "mutated handler member",
    'const handlers = { current: refresh }; window.addEventListener("resize", handlers.current); handlers.current = other; import.meta.hot.dispose(() => window.removeEventListener("resize", handlers.current))',
    true,
  ],
  [
    "mutated capture object",
    'const options = { capture: false }; window.addEventListener("resize", refresh, options); options.capture = true; import.meta.hot.dispose(() => window.removeEventListener("resize", refresh, options))',
    true,
  ],
  [
    "mutated capture alias",
    'const options = { capture: false }; const alias = options; window.addEventListener("resize", refresh, options); import.meta.hot.dispose(() => { alias.capture = true; window.removeEventListener("resize", refresh, options) })',
    true,
  ],
  [
    "computed custom resource key",
    "const setInterval = customKey; const timer = window[setInterval](refresh); import.meta.hot.dispose(() => saveState())",
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

for (const [name, source, leaks] of [
  [
    "computed listener cleanup",
    "document.body['addEventListener']('resize', refresh); import.meta.hot.dispose(() => document.body['removeEventListener']('resize', refresh))",
    false,
  ],
  [
    "computed abort cleanup",
    "const controller = new AbortController(); window.addEventListener('resize', refresh, { signal: controller.signal }); import.meta.hot.dispose(() => controller['abort']())",
    false,
  ],
  [
    "void helper argument",
    "const timer = setInterval(refresh); function cleanup(handle = timer) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup(void 0))",
    false,
  ],
  [
    "null helper argument",
    "const timer = setInterval(refresh); function cleanup(handle = timer) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup(null))",
    true,
  ],
  [
    "shadowed undefined argument",
    "const timer = setInterval(refresh); function cleanup(handle = timer) { clearInterval(handle) }; import.meta.hot.dispose(() => { const undefined = other; cleanup(undefined) })",
    true,
  ],
  [
    "assigned listener signal",
    "const controller = new AbortController(); const options = {}; options.signal = controller.signal; window.addEventListener('resize', refresh, options); import.meta.hot.dispose(() => controller.abort())",
    false,
  ],
  [
    "replaced listener signal",
    "const old = new AbortController(); const current = new AbortController(); const options = { signal: old.signal }; options.signal = current.signal; window.addEventListener('resize', refresh, options); import.meta.hot.dispose(() => old.abort())",
    true,
  ],
  [
    "effective listener signal",
    "const old = new AbortController(); const current = new AbortController(); const options = { signal: old.signal }; options.signal = current.signal; window.addEventListener('resize', refresh, options); import.meta.hot.dispose(() => current.abort())",
    false,
  ],
  [
    "signal snapshot at registration",
    "const old = new AbortController(); const current = new AbortController(); const options = { signal: old.signal }; window.addEventListener('resize', refresh, options); options.signal = current.signal; import.meta.hot.dispose(() => current.abort())",
    true,
  ],
  [
    "stable member target",
    "document.body.addEventListener('resize', refresh); import.meta.hot.dispose(() => document.body.removeEventListener('resize', refresh))",
    false,
  ],
  [
    "stable member handler",
    "window.addEventListener('resize', handlers.refresh); import.meta.hot.dispose(() => window.removeEventListener('resize', handlers.refresh))",
    false,
  ],
  [
    "changed member target",
    "document.body.addEventListener('resize', refresh); document.body = other; import.meta.hot.dispose(() => document.body.removeEventListener('resize', refresh))",
    true,
  ],
  [
    "different member target",
    "document.body.addEventListener('resize', refresh); import.meta.hot.dispose(() => document.head.removeEventListener('resize', refresh))",
    true,
  ],
  [
    "computed socket cleanup",
    "const socket = new WebSocket(url); import.meta.hot.dispose(() => socket['close']())",
    false,
  ],
  [
    "computed subscription cleanup",
    "const subscription = events.subscribe(refresh); import.meta.hot.dispose(() => subscription['unsubscribe']())",
    false,
  ],
  [
    "dynamic socket cleanup",
    "const socket = new WebSocket(url); import.meta.hot.dispose(() => socket[close]())",
    true,
  ],
  [
    "default helper argument",
    "const timer = setInterval(refresh); function cleanup(handle = timer) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup())",
    false,
  ],
  [
    "supplied helper argument",
    "const timer = setInterval(refresh); function cleanup(handle = other) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup(timer))",
    false,
  ],
  [
    "overridden helper default",
    "const timer = setInterval(refresh); function cleanup(handle = timer) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup(other))",
    true,
  ],
  [
    "undefined helper argument",
    "const timer = setInterval(refresh); function cleanup(handle = timer) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup(undefined))",
    false,
  ],
  [
    "earlier parameter default",
    "const timer = setInterval(refresh); function cleanup(first, handle = first) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup(timer))",
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

for (const [name, source, leaks] of [
  ["unassigned interval", "setInterval(refresh); import.meta.hot.dispose(() => {})", true],
  [
    "member timer handle",
    "state.timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  ["unassigned socket", "new WebSocket(url); import.meta.hot.dispose(() => {})", true],
  [
    "invoked setup helper",
    "let timer; function start() { timer = setInterval(refresh) }; start(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "cleaned setup helper",
    "let timer; function start() { timer = setInterval(refresh) }; start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "conditional cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (shouldStop) clearInterval(timer) })",
    true,
  ],
  [
    "unreachable cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { return; clearInterval(timer) })",
    true,
  ],
  [
    "conditional early return",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (skip) return; clearInterval(timer) })",
    true,
  ],
  [
    "both cleanup branches",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (choice) clearInterval(timer); else clearInterval(timer) })",
    false,
  ],
  [
    "cleanup before early return",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (choice) { clearInterval(timer); return }; clearInterval(timer) })",
    false,
  ],
  [
    "short circuit cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => shouldStop && clearInterval(timer))",
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
    "getter listener target",
    `let calls = 0; const targets = { get current() { return calls++ ? document : window } }; targets.current.addEventListener('resize', refresh); import.meta.hot.dispose(() => targets.current.removeEventListener('resize', refresh))`,
    true,
  ],
  [
    "stable object listener target",
    `const targets = { current: window }; targets.current.addEventListener('resize', refresh); import.meta.hot.dispose(() => targets.current.removeEventListener('resize', refresh))`,
    false,
  ],
  [
    "replaced socket cleanup",
    `const socket = new WebSocket(url); socket.close = saveState; import.meta.hot.dispose(() => socket['close']())`,
    true,
  ],
  [
    "replaced subscription cleanup",
    `const sub = events.subscribe(refresh); sub.unsubscribe = saveState; import.meta.hot.dispose(() => sub.unsubscribe())`,
    true,
  ],
  [
    "replaced listener cleanup",
    `window.addEventListener('resize', refresh); window.removeEventListener = saveState; import.meta.hot.dispose(() => window.removeEventListener('resize', refresh))`,
    true,
  ],
  [
    "replaced abort cleanup",
    `const controller = new AbortController(); window.addEventListener('resize', refresh, { signal: controller.signal }); controller.abort = saveState; import.meta.hot.dispose(() => controller.abort())`,
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

for (const [name, setup, cleanup] of [
  [
    "object member callback",
    "const disposers = { cleanup: () => clearInterval(timer) }",
    "import.meta.hot.dispose(disposers.cleanup)",
  ],
  [
    "computed member callback",
    "const disposers = { cleanup: () => clearInterval(timer) }",
    "import.meta.hot.dispose(disposers['cleanup'])",
  ],
  [
    "object parameter",
    "function cleanup({ timer: handle }) { clearInterval(handle) }",
    "import.meta.hot.dispose(() => cleanup({ timer }))",
  ],
  [
    "nested parameter",
    "function cleanup({ resources: [handle] }) { clearInterval(handle) }",
    "import.meta.hot.dispose(() => cleanup({ resources: [timer] }))",
  ],
  [
    "array parameter",
    "function cleanup([, handle]) { clearInterval(handle) }",
    "import.meta.hot.dispose(() => cleanup([null, timer]))",
  ],
  [
    "rest parameter",
    "function cleanup(...handles) { clearInterval(handles[1]) }",
    "import.meta.hot.dispose(() => cleanup(null, timer))",
  ],
  [
    "array rest parameter",
    "function cleanup([, ...handles]) { clearInterval(handles[0]) }",
    "import.meta.hot.dispose(() => cleanup([null, timer]))",
  ],
  [
    "object rest parameter",
    "function cleanup({ ignored, ...handles }) { clearInterval(handles.timer) }",
    "import.meta.hot.dispose(() => cleanup({ ignored: null, timer }))",
  ],
  [
    "destructured default",
    "function cleanup({ handle = timer } = {}) { clearInterval(handle) }",
    "import.meta.hot.dispose(() => cleanup())",
  ],
  [
    "array default",
    "function cleanup([handle = timer]) { clearInterval(handle) }",
    "import.meta.hot.dispose(() => cleanup([]))",
  ],
] as const) {
  for (const leaks of [false, true]) {
    test(`${name} ${leaks ? "preserves unmatched resources" : "disposes matching resources"}`, async () => {
      const result = await runRuleFixture({
        framework: "vite",
        rule: requireDisposeForSideEffects,
        files: {
          "src/main.ts": `import.meta.hot.accept(); const timer = setInterval(refresh); ${leaks ? setup.replace(/clearInterval\([^)]*\)/g, "clearInterval(other)") : setup}; ${cleanup}`,
        },
      });
      expect(result.diagnostics.length > 0).toBe(leaks);
    });
  }
}

for (const [name, source, leaks] of [
  [
    "rest excludes extracted keys",
    "function cleanup({ timer: ignored, ...rest }) { clearInterval(rest.timer) }; import.meta.hot.dispose(() => cleanup({ timer }))",
    true,
  ],
  [
    "rest snapshots array entries",
    "let handle = timer; function cleanup([...rest]) { handle = other; clearInterval(rest[0]) }; import.meta.hot.dispose(() => cleanup([handle]))",
    false,
  ],
  [
    "spread array does not establish a default",
    "function cleanup([ignored, handle = timer]) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup([...unknown]))",
    true,
  ],
  [
    "getter callback remains unknown",
    "const callbacks = { get cleanup() { return () => clearInterval(timer) } }; import.meta.hot.dispose(callbacks.cleanup)",
    true,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: {
        "src/main.ts": `import.meta.hot.accept(); const timer = setInterval(refresh); ${source}`,
      },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const [name, source, leaks] of [
  [
    "module false branch",
    "const timer = setInterval(refresh); if (false) clearInterval(timer); import.meta.hot.dispose(saveState)",
    true,
  ],
  [
    "module uncertain branch",
    "const timer = setInterval(refresh); if (stop) clearInterval(timer); import.meta.hot.dispose(saveState)",
    true,
  ],
  [
    "module both branches",
    "const timer = setInterval(refresh); if (stop) clearInterval(timer); else clearInterval(timer); import.meta.hot.dispose(saveState)",
    false,
  ],
  [
    "module true branch",
    "const timer = setInterval(refresh); if (true) clearInterval(timer); import.meta.hot.dispose(saveState)",
    false,
  ],
  [
    "repeated loop resource",
    "let timer; for (let i = 0; i < 2; i++) timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "repeated setup resource",
    "let timer; function start() { timer = setInterval(refresh) }; start(); start(); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "cleaned repeated setup",
    "let timer; function start() { timer = setInterval(refresh) }; start(); clearInterval(timer); start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "return from try",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { if (skip) return } finally { saveState() }; clearInterval(timer) })",
    true,
  ],
  [
    "infinite loop before cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { while (true) {}; clearInterval(timer) })",
    true,
  ],
  [
    "do loop before cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { do { return } while (false); clearInterval(timer) })",
    true,
  ],
  [
    "throwing helper before cleanup",
    "const timer = setInterval(refresh); function fail() { throw new Error('stop') }; import.meta.hot.dispose(() => { fail(); clearInterval(timer) })",
    true,
  ],
  [
    "conditionally throwing helper",
    "const timer = setInterval(refresh); function fail() { if (skip) throw new Error('stop') }; import.meta.hot.dispose(() => { fail(); clearInterval(timer) })",
    true,
  ],
  [
    "returning helper before cleanup",
    "const timer = setInterval(refresh); function done() { if (skip) return; saveState() }; import.meta.hot.dispose(() => { done(); clearInterval(timer) })",
    false,
  ],
  [
    "cleanup before throwing helper",
    "const timer = setInterval(refresh); function fail() { throw new Error('stop') }; import.meta.hot.dispose(() => { clearInterval(timer); fail() })",
    false,
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
    "destructured array resource",
    "const [timer] = [setInterval(refresh)]; import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "destructured object resource",
    "const { timer } = { timer: setInterval(refresh) }; import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "destructured resource mismatch",
    "const [timer] = [setInterval(refresh)]; import.meta.hot.dispose(() => clearInterval(other))",
    true,
  ],
  [
    "returned resource handle",
    "function start() { return setInterval(refresh) }; const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "arrow returned resource handle",
    "const start = () => setInterval(refresh); const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "returned resource mismatch",
    "function start() { return setInterval(refresh) }; const timer = start(); import.meta.hot.dispose(() => clearInterval(other))",
    true,
  ],
  [
    "aliased global resource leak",
    "const timers = window; const timer = timers.setInterval(refresh); import.meta.hot.dispose(saveState)",
    true,
  ],
  [
    "aliased global resource cleanup",
    "const timers = window; const timer = timers.setInterval(refresh); import.meta.hot.dispose(() => timers.clearInterval(timer))",
    false,
  ],
  [
    "computed rest exclusion",
    "const timer = setInterval(refresh); const key = 'timer'; function cleanup({ [key]: ignored, ...rest }) { clearInterval(rest.timer) }; import.meta.hot.dispose(() => cleanup({ timer }))",
    true,
  ],
  [
    "unknown rest exclusion",
    "const timer = setInterval(refresh); function cleanup({ [key]: ignored, ...rest }) { clearInterval(rest.timer) }; import.meta.hot.dispose(() => cleanup({ timer }))",
    true,
  ],
  [
    "computed rest retained key",
    "const timer = setInterval(refresh); const key = 'other'; function cleanup({ [key]: ignored, ...rest }) { clearInterval(rest.timer) }; import.meta.hot.dispose(() => cleanup({ timer }))",
    false,
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
    "member setup leak",
    "const helpers = { start() { setInterval(refresh) } }; helpers.start(); import.meta.hot.dispose(saveState)",
    true,
  ],
  [
    "member setup cleanup",
    "const helpers = { start() { return setInterval(refresh) } }; const timer = helpers.start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "static template event",
    "addEventListener(`resize`, refresh); import.meta.hot.dispose(() => removeEventListener(`resize`, refresh))",
    false,
  ],
  [
    "template and string event",
    "const event = `resize`; addEventListener(event, refresh); import.meta.hot.dispose(() => removeEventListener('resize', refresh))",
    false,
  ],
  [
    "different template events",
    "addEventListener(`resize`, refresh); import.meta.hot.dispose(() => removeEventListener(`scroll`, refresh))",
    true,
  ],
  [
    "dynamic template events",
    "addEventListener(`resize${suffix}`, refresh); import.meta.hot.dispose(() => removeEventListener(`resize${suffix}`, refresh))",
    true,
  ],
  [
    "direct recursion before cleanup",
    "const timer = setInterval(refresh); function recurse() { recurse() }; import.meta.hot.dispose(() => { recurse(); clearInterval(timer) })",
    true,
  ],
  [
    "mutual recursion before cleanup",
    "const timer = setInterval(refresh); function first() { second() }; function second() { first() }; import.meta.hot.dispose(() => { first(); clearInterval(timer) })",
    true,
  ],
  [
    "cleanup before recursion",
    "const timer = setInterval(refresh); function recurse() { recurse() }; import.meta.hot.dispose(() => { clearInterval(timer); recurse() })",
    false,
  ],
  [
    "conditional recursion before cleanup",
    "const timer = setInterval(refresh); function recurse() { if (again) recurse() }; import.meta.hot.dispose(() => { recurse(); clearInterval(timer) })",
    true,
  ],
  [
    "stale returned resource",
    "function start() { return setInterval(refresh) }; const first = start(); clearInterval(first); const second = start(); import.meta.hot.dispose(() => clearInterval(first))",
    true,
  ],
  [
    "distinct returned resources cleaned",
    "function start() { return setInterval(refresh) }; const first = start(); const second = start(); import.meta.hot.dispose(() => { clearInterval(first); clearInterval(second) })",
    false,
  ],
  [
    "latest returned resource cleaned",
    "function start() { return setInterval(refresh) }; const first = start(); clearInterval(first); const second = start(); import.meta.hot.dispose(() => clearInterval(second))",
    false,
  ],
  [
    "stale nested returned resource",
    "function create() { return setInterval(refresh) }; function start() { return create() }; const first = start(); clearInterval(first); const second = start(); import.meta.hot.dispose(() => clearInterval(first))",
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
    "deferred instance field",
    "class Worker { timer = setInterval(refresh) }; import.meta.hot.dispose(() => save())",
    false,
  ],
  [
    "static field executes",
    "class Worker { static timer = setInterval(refresh) }; import.meta.hot.dispose(() => save())",
    true,
  ],
  [
    "computed instance field key executes",
    "class Worker { [setInterval(refresh)] = 1 }; import.meta.hot.dispose(() => save())",
    true,
  ],
  [
    "conditional timers",
    "const timer = fast ? setInterval(a) : setInterval(b); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "nested conditional timers",
    "const timer = fast ? setInterval(a) : slow ? setInterval(b) : setInterval(c); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "constant conditional timer",
    "const timer = true ? setInterval(a) : setInterval(b); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "conditional sockets",
    "const socket = fast ? new WebSocket(a) : new WebSocket(b); import.meta.hot.dispose(() => socket.close())",
    false,
  ],
  [
    "conditional existing timers still leak",
    "const a = setInterval(refresh); const b = setInterval(refresh); const timer = fast ? a : b; import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "conditional extra timer leaks",
    "const timer = fast ? (setInterval(a), setInterval(b)) : setInterval(c); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "method setup receiver",
    "const helpers = { start() { this.timer = setInterval(refresh) } }; helpers.start(); import.meta.hot.dispose(() => clearInterval(helpers.timer))",
    false,
  ],
  [
    "method cleanup receiver",
    "const state = { timer: setInterval(refresh), cleanup() { clearInterval(this.timer) } }; import.meta.hot.dispose(() => state.cleanup())",
    false,
  ],
  [
    "unrelated method receiver",
    "const a = { timer: setInterval(refresh), cleanup() { clearInterval(this.timer) } }; const b = { cleanup: a.cleanup }; import.meta.hot.dispose(() => b.cleanup())",
    true,
  ],
  [
    "detached method receiver",
    "const state = { timer: setInterval(refresh), cleanup() { clearInterval(this.timer) } }; const cleanup = state.cleanup; import.meta.hot.dispose(() => cleanup())",
    true,
  ],
  [
    "arrow keeps lexical receiver",
    "const state = { start() { this.timer = setInterval(refresh); this.cleanup = () => clearInterval(this.timer) } }; state.start(); import.meta.hot.dispose(() => state.cleanup())",
    false,
  ],
  [
    "arrow does not use method receiver",
    "const state = { timer: setInterval(refresh), cleanup: () => clearInterval(this.timer) }; import.meta.hot.dispose(() => state.cleanup())",
    true,
  ],
  [
    "conditional disposer registration",
    "const timer = setInterval(refresh); if (enabled) import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "both registration paths clean up",
    "const timer = setInterval(refresh); if (enabled) import.meta.hot.dispose(() => clearInterval(timer)); else import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "conditional replacement loses cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer)); if (enabled) import.meta.hot.dispose(() => save())",
    true,
  ],
  [
    "finally disposes after unknown call",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { save() } finally { clearInterval(timer) } })",
    false,
  ],
  [
    "finally disposes after return",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { return } finally { clearInterval(timer) } })",
    false,
  ],
  [
    "finally disposes after throw",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { throw Error() } finally { clearInterval(timer) } })",
    false,
  ],
  [
    "conditional finally cleanup leaks",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { save() } finally { if (enabled) clearInterval(timer) } })",
    true,
  ],
  [
    "constructed field leaks",
    "class Worker { timer = setInterval(refresh) }; new Worker(); import.meta.hot.dispose(() => save())",
    true,
  ],
  [
    "constructed field disposed",
    "class Worker { timer = setInterval(refresh) }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "constructed instances are distinct",
    "class Worker { timer = setInterval(refresh) }; const a = new Worker(); const b = new Worker(); import.meta.hot.dispose(() => clearInterval(b.timer))",
    true,
  ],
  [
    "two receivers retain arrow closures",
    "const a = { start() { this.timer = setInterval(refresh); this.cleanup = () => clearInterval(this.timer) } }; const b = { start: a.start }; a.start(); b.start(); import.meta.hot.dispose(() => { a.cleanup(); b.cleanup() })",
    false,
  ],
  [
    "finally early return leaks",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { save() } finally { if (skip) return; clearInterval(timer) } })",
    true,
  ],
  [
    "cleanup after returning try is unreachable",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { return } finally { save() }; clearInterval(timer) })",
    true,
  ],
  [
    "finally repeats cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { clearInterval(timer); return } finally { clearInterval(timer) } })",
    false,
  ],
  [
    "hot conditional guard",
    "const timer = setInterval(refresh); if (import.meta.hot) import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "hot logical guard",
    "const timer = setInterval(refresh); import.meta.hot && import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "uninitialized class field",
    "class Worker { empty; timer = setInterval(refresh) }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "generator disposer",
    "const timer = setInterval(refresh); import.meta.hot.dispose(function* () { clearInterval(timer) })",
    true,
  ],
  [
    "immediate nested cleanup",
    "clearInterval(setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "conditional callbacks clean",
    "const timer = setInterval(refresh); import.meta.hot.dispose(ready ? () => clearInterval(timer) : () => clearInterval(timer))",
    false,
  ],
  [
    "conditional callback leaks",
    "const timer = setInterval(refresh); import.meta.hot.dispose(ready ? () => clearInterval(timer) : () => {})",
    true,
  ],
  [
    "returning registration leaks",
    "const timer = setInterval(refresh); function setup() { if (ready) { import.meta.hot.dispose(() => {}); return }; import.meta.hot.dispose(() => clearInterval(timer)) }; setup()",
    true,
  ],
  [
    "throwing registration leaks",
    "const timer = setInterval(refresh); function setup() { if (ready) { import.meta.hot.dispose(() => {}); throw Error() }; import.meta.hot.dispose(() => clearInterval(timer)) }; setup()",
    true,
  ],
  [
    "inherited field leaks",
    "class Base { timer = setInterval(refresh) }; class Worker extends Base {}; new Worker(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "inherited constructor cleans",
    "class Base { constructor() { this.timer = setInterval(refresh) } }; class Worker extends Base {}; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "replacement constructor leaks",
    "class Worker { timer = setInterval(refresh); constructor() { return {} } }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    true,
  ],
  [
    "primitive constructor cleans",
    "class Worker { timer = setInterval(refresh); constructor() { return 1 } }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "inline static resource leaks",
    "new (class { static timer = setInterval(refresh) })(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "inline computed resource leaks",
    "new (class { [setInterval(refresh)] = 1 })(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "explicit superclass arguments clean",
    "class Base { constructor(timer) { this.timer = timer } }; class Worker extends Base { constructor(timer) { super(timer) } }; const worker = new Worker(setInterval(refresh)); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "inherited closure cleans",
    "class Base { timer = setInterval(refresh); cleanup = () => clearInterval(this.timer) }; class Worker extends Base { other = setInterval(refresh) }; const worker = new Worker(); import.meta.hot.dispose(() => { worker.cleanup(); clearInterval(worker.other) })",
    false,
  ],
  [
    "derived replacement cleans",
    "class Base { constructor() { return {} } }; class Worker extends Base { timer = setInterval(refresh) }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "function superclass leaks",
    "function Base() { this.timer = setInterval(refresh) }; class Worker extends Base {}; new Worker()",
    true,
  ],
  [
    "function superclass cleans",
    "function Base() { this.timer = setInterval(refresh) }; class Worker extends Base {}; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "function expression superclass arguments clean",
    "const Base = function(timer) { this.timer = timer }; class Worker extends Base { constructor(timer) { super(timer) } }; const worker = new Worker(setInterval(refresh)); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "function superclass replacement initializes derived fields",
    "function Base() { return {} }; class Worker extends Base { timer = setInterval(refresh) }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "derived regexp return allows registration",
    "let timer; class Base {}; class Worker extends Base { constructor() { super(); timer = setInterval(refresh); return /valid/ } }; new Worker(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  ...["1", "null", "false", "'invalid'", "-1", "`invalid`"].map(
    (value) =>
      [
        `derived primitive return ${value} prevents registration`,
        `let timer; class Base {}; class Worker extends Base { constructor() { super(); timer = setInterval(refresh); return ${value} } }; new Worker(); import.meta.hot.dispose(() => clearInterval(timer))`,
        true,
      ] as const,
  ),
  ...["1 + 1", "1 < 2", "1 in {}"].map(
    (value) =>
      [
        `derived binary return ${value} prevents registration`,
        `let timer; class Base {}; class Worker extends Base { constructor() { super(); timer = setInterval(refresh); return ${value} } }; new Worker(); import.meta.hot.dispose(() => clearInterval(timer))`,
        true,
      ] as const,
  ),
  ...["", "undefined", "void 0"].map(
    (value) =>
      [
        `derived undefined return ${value} allows registration`,
        `let timer; class Base {}; class Worker extends Base { constructor() { super(); timer = setInterval(refresh); return ${value} } }; new Worker(); import.meta.hot.dispose(() => clearInterval(timer))`,
        false,
      ] as const,
  ),
  [
    "function constructor leaks",
    "function Worker() { this.timer = setInterval(refresh) }; new Worker(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "function constructor cleanup",
    "function Worker() { this.timer = setInterval(refresh) }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "static method leaks",
    "class Worker { static start() { setInterval(refresh) } }; Worker.start(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "static method cleanup",
    "class Worker { static start() { return setInterval(refresh) } }; const timer = Worker.start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  ["disposal creates timer", "import.meta.hot.dispose(() => setInterval(refresh))", true],
  [
    "disposal replaces timer",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { clearInterval(timer); setInterval(refresh) })",
    true,
  ],
  [
    "disposal cleans its timer",
    "import.meta.hot.dispose(() => { const timer = setInterval(refresh); clearInterval(timer) })",
    false,
  ],
  [
    "disposal creates listener",
    'import.meta.hot.dispose(() => window.addEventListener("click", refresh))',
    true,
  ],
  [
    "try catch guaranteed cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { clearInterval(timer) } catch { clearInterval(timer) } })",
    false,
  ],
  [
    "try catch incomplete cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { clearInterval(timer) } catch {} })",
    true,
  ],
  [
    "disposal loop creates timer",
    "import.meta.hot.dispose(() => { for (const item of items) setInterval(refresh) })",
    true,
  ],
  [
    "alternative disposers clean their own timers",
    "import.meta.hot.dispose(flag ? () => { const timer = setInterval(refresh); clearInterval(timer) } : () => { const timer = setInterval(refresh); clearInterval(timer) })",
    false,
  ],
  [
    "function expression constructor cleanup",
    "const Worker = function() { this.timer = setInterval(refresh) }; const worker = new Worker(); import.meta.hot.dispose(() => clearInterval(worker.timer))",
    false,
  ],
  [
    "branch resources match their disposers",
    "if (flag) { const timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer)) } else { const socket = new WebSocket(url); import.meta.hot.dispose(() => socket.close()) }",
    false,
  ],
  [
    "branch leak remains visible",
    "if (flag) { const timer = setInterval(refresh); import.meta.hot.dispose(() => {}) } else { const socket = new WebSocket(url); import.meta.hot.dispose(() => socket.close()) }",
    true,
  ],
  [
    "shared resource must be cleaned on both branches",
    "const timer = setInterval(refresh); if (flag) { import.meta.hot.dispose(() => clearInterval(timer)) } else { import.meta.hot.dispose(() => {}) }",
    true,
  ],
  [
    "caught throw cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { throw Error() } catch { clearInterval(timer) } })",
    false,
  ],
  [
    "catch rethrow skips cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { throw Error() } catch { throw Error() }; clearInterval(timer) })",
    true,
  ],
  [
    "sequence initializer cleanup",
    "const timer = (prepare(), setInterval(refresh)); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "logical false && setInterval(refresh)",
    "false && setInterval(refresh); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "logical true || setInterval(refresh)",
    "true || setInterval(refresh); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "logical 1 ?? setInterval(refresh)",
    "1 ?? setInterval(refresh); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "logical 0 && setInterval(refresh)",
    "0 && setInterval(refresh); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "logical null ?? setInterval(refresh)",
    "null ?? setInterval(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "logical true && setInterval(refresh)",
    "true && setInterval(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "caught helper throw cleanup",
    "const timer = setInterval(refresh); function fail() { throw Error() }; import.meta.hot.dispose(() => { try { fail() } catch { clearInterval(timer) } })",
    false,
  ],
  [
    "caught exception in cleanup helper returns normally",
    "const timer = setInterval(refresh); function recover() { try { throw Error() } catch {} }; import.meta.hot.dispose(() => { recover(); clearInterval(timer) })",
    false,
  ],
  [
    "return from try still requires cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { if (flag) return; throw Error() } catch { clearInterval(timer) } })",
    true,
  ],
  [
    "nested branch resources and disposers",
    "if (flag) { if (other) { const timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer)) } else { const socket = new WebSocket(url); import.meta.hot.dispose(() => socket.close()) } } else { const timer = setTimeout(refresh); import.meta.hot.dispose(() => clearTimeout(timer)) }",
    false,
  ],
  [
    "logical initializer cleanup",
    "const timer = true && setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "sequence early resource still leaks",
    "const timer = (setInterval(refresh), setInterval(refresh)); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "default parameter creates a resource",
    "function start(timer = setInterval(refresh)) {}; start(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "default parameter resource can be returned",
    "function start(timer = setInterval(refresh)) { return timer }; const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "supplied parameter skips default resource",
    "function start(timer = setInterval(refresh)) {}; start(1); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "cleanup function alias",
    "const stop = clearInterval; const timer = setInterval(refresh); import.meta.hot.dispose(() => stop(timer))",
    false,
  ],
  [
    "shadowed cleanup alias",
    "const clearInterval = () => {}; const stop = clearInterval; const timer = setInterval(refresh); import.meta.hot.dispose(() => stop(timer))",
    true,
  ],
  [
    "branch assigned handles",
    "let timer; if (flag) timer = setInterval(a); else timer = setInterval(b); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "branch overwritten handle still leaks",
    "let timer = setInterval(a); if (flag) timer = setInterval(b); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "static field handle cleanup",
    "class Worker { static timer = setInterval(refresh) }; import.meta.hot.dispose(() => clearInterval(Worker.timer))",
    false,
  ],
  [
    "cleanup before caught throw",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { clearInterval(timer); throw Error() } catch {} })",
    false,
  ],
  [
    "partial cleanup before caught throw",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { if (flag) { clearInterval(timer); throw Error() }; throw Error() } catch {} })",
    true,
  ],
  [
    "repeated condition correlates lifetimes",
    "if (flag) window.addEventListener('resize', refresh); if (flag) import.meta.hot.dispose(() => window.removeEventListener('resize', refresh)); else import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "different conditions cannot correlate lifetimes",
    "if (flag) window.addEventListener('resize', refresh); if (other) import.meta.hot.dispose(() => window.removeEventListener('resize', refresh)); else import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "reassigned condition cannot correlate lifetimes",
    "let enabled = flag; if (enabled) window.addEventListener('resize', refresh); enabled = other; if (enabled) import.meta.hot.dispose(() => window.removeEventListener('resize', refresh)); else import.meta.hot.dispose(() => {})",
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
    "aliased timer creation",
    "const start = setInterval; start(refresh); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "aliased timer cleanup",
    "const start = setInterval; const timer = start(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "aliased socket creation",
    "const Socket = WebSocket; new Socket(url); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "shadowed timer creation alias",
    "const setInterval = () => {}; const start = setInterval; start(refresh); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "optional timer cleanup",
    "let timer; if (flag) timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "optional timer overwritten",
    "let timer = setInterval(refresh); if (flag) timer = undefined; import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "named recursive cleanup",
    "const timer = setInterval(refresh); const cleanup = function again() { again(); clearInterval(timer) }; import.meta.hot.dispose(cleanup)",
    true,
  ],
  [
    "catch sees assigned timer",
    "let timer; try { timer = setInterval(refresh); throw Error() } catch { clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "catch sees overwritten timer",
    "let timer = setInterval(refresh); try { timer = 0; throw Error() } catch { clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "catch sees assigned property",
    "const state = {}; try { state.timer = setInterval(refresh); throw Error() } catch { clearInterval(state.timer) }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "catch merges throw states",
    "let timer = setInterval(refresh); try { if (flag) { timer = 0; throw Error() }; throw Error() } catch { clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "opposite guards correlate lifetimes",
    "if (flag) window.addEventListener('resize', refresh); if (!flag) import.meta.hot.dispose(() => {}); else import.meta.hot.dispose(() => window.removeEventListener('resize', refresh))",
    false,
  ],
  [
    "opposite unrelated guards retain leaks",
    "if (flag) window.addEventListener('resize', refresh); if (!other) import.meta.hot.dispose(() => {}); else import.meta.hot.dispose(() => window.removeEventListener('resize', refresh))",
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
    "switch later return before cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (flag) { case 0: break; case 1: return }; clearInterval(timer) })",
    true,
  ],
  [
    "switch cleanup cannot cover another case",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (flag) { case 0: clearInterval(timer); break; case 1: return }; clearInterval(timer) })",
    true,
  ],

  [
    "iteration break before cleanup",
    "for (const item of items) { const timer = setInterval(refresh); if (flag) break; clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "iteration continue before cleanup",
    "for (const item of items) { const timer = setInterval(refresh); if (flag) continue; clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "iteration cleanup before break",
    "for (const item of items) { const timer = setInterval(refresh); clearInterval(timer); break }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "nested conditional creator",
    "const create = flag ? custom : other ? globalThis.setTimeout : setInterval; create(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],

  [
    "conditional timer creator",
    "const start = flag ? setInterval : custom; start(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "conditional timer creator cleanup",
    "const start = flag ? setInterval : custom; const timer = start(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "branch assigned timer creator",
    "let start; if (flag) start = setInterval; else start = custom; start(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "conditional socket creator",
    "const Socket = flag ? WebSocket : custom; new Socket(url); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "conditional shadowed creator",
    "const setInterval = () => {}; const start = flag ? setInterval : custom; start(refresh); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "switch before cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (0) { default: break }; clearInterval(timer) })",
    false,
  ],
  [
    "switch return before cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (flag) { case 1: return; default: break }; clearInterval(timer) })",
    true,
  ],
  [
    "iteration cleanup",
    "for (const item of items) { const timer = setInterval(refresh); clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "conditional iteration cleanup",
    "for (const item of items) { const timer = setInterval(refresh); if (flag) clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "iteration return before cleanup",
    "function setup() { for (const item of items) { const timer = setInterval(refresh); if (flag) return; clearInterval(timer) } }; setup(); import.meta.hot.dispose(() => {})",
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
    "synchronous array callback leak",
    "[1].forEach(() => setInterval(refresh)); import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "empty array callback",
    "[].forEach(() => setInterval(refresh)); import.meta.hot.dispose(() => saveState())",
    false,
  ],
  [
    "array callback local cleanup",
    "[1, 2].forEach(() => { const timer = setInterval(refresh); clearInterval(timer) }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "mapped timer cleanup",
    "const timers = [1, 2].map(() => setInterval(refresh)); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "truthy logical assignment",
    "let timer = setInterval(refresh); timer ||= setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "nullish logical assignment",
    "let timer; timer ??= setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "executed logical assignment leaks old handle",
    "let timer = setInterval(refresh); timer &&= setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "awaited timer handle",
    "const timer = await setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "interval canceled by clearTimeout",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => clearTimeout(timer))",
    false,
  ],
  [
    "timeout canceled by clearInterval",
    "const timer = setTimeout(refresh); import.meta.hot.dispose(() => window.clearInterval(timer))",
    false,
  ],
  [
    "labeled block continuation",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { block: { break block }; clearInterval(timer) })",
    false,
  ],
  [
    "conditional labeled block continuation",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { block: { if (flag) break block }; clearInterval(timer) })",
    false,
  ],
  [
    "labeled block skips cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { block: { break block; clearInterval(timer) } })",
    true,
  ],
  [
    "labeled block callback return",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { block: { if (flag) return; break block }; clearInterval(timer) })",
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
    "returned arrow parameter",
    "function make(h) { return () => clearInterval(h) }; const timer = setInterval(refresh); import.meta.hot.dispose(make(timer))",
    false,
  ],
  [
    "returned function local",
    "function make(h) { const local = h; return function () { clearInterval(local) } }; const timer = setInterval(refresh); import.meta.hot.dispose(make(timer))",
    false,
  ],
  [
    "returned arrow reassigned local",
    "function make(h) { let local; const cb = () => clearInterval(local); local = h; return cb }; const timer = setInterval(refresh); import.meta.hot.dispose(make(timer))",
    false,
  ],
  [
    "returned callback wrong resource",
    "function make(h) { return () => clearInterval(h) }; const timer = setInterval(refresh); import.meta.hot.dispose(make(other))",
    true,
  ],
  [
    "unreachable while",
    "while (false) { setInterval(refresh) }; import.meta.hot.dispose(() => saveState())",
    false,
  ],
  [
    "unreachable for",
    "for (; false;) { setInterval(refresh) }; import.meta.hot.dispose(() => saveState())",
    false,
  ],
  [
    "for initializer still runs",
    "for (setInterval(refresh); false;) {}; import.meta.hot.dispose(() => saveState())",
    true,
  ],
  [
    "do while executes once",
    "do { setInterval(refresh) } while (false); import.meta.hot.dispose(() => saveState())",
    true,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(
      result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
    ).toBe(leaks);
  });
}
