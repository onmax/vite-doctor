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
