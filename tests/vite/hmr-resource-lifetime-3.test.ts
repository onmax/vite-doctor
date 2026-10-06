import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { requireDisposeForSideEffects } from "../../src/rule-packs/vite/rules/plugin-hmr.ts";

for (const [name, source, leaks] of [
  [
    "for break skips update",
    "for (; true; setInterval(refresh)) { break }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "for return skips update",
    "function setup() { for (; true; setInterval(refresh)) { return } }; setup(); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "for throw skips update",
    "try { for (; true; setInterval(refresh)) { throw Error() } } catch {}; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "for continue reaches update",
    "for (; ready; setInterval(refresh)) { continue }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "for conditional continue reaches update",
    "for (; ready; setInterval(refresh)) { if (flag) continue; break }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "for update observes body binding",
    "let create = () => {}; for (; ready; create()) { create = () => setInterval(refresh) }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "switch fallthrough cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { case 0: saveState(); default: clearInterval(timer) } })",
    false,
  ],
  [
    "switch chained fallthrough cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { case 0: saveState(); case 1: saveState(); default: clearInterval(timer) } })",
    false,
  ],
  [
    "switch break skips cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { case 0: break; default: clearInterval(timer) } })",
    true,
  ],
  [
    "switch return skips cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { case 0: return; default: clearInterval(timer) } })",
    true,
  ],
  [
    "switch without default may skip cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { case 0: saveState(); case 1: clearInterval(timer) } })",
    true,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const loop of [
  "while ((timer = setInterval(refresh), enabled))",
  "for (; (timer = setInterval(refresh), enabled);)",
]) {
  for (const [body, leaks] of [
    ["break", false],
    ["continue", true],
    ["if (flag) continue; break", true],
  ] as const) {
    test(`${loop} with ${body} tracks test repetition`, async () => {
      const result = await runRuleFixture({
        framework: "vite",
        rule: requireDisposeForSideEffects,
        files: {
          "src/main.ts": `let timer; ${loop} { ${body} }; import.meta.hot.accept(); import.meta.hot.dispose(() => clearInterval(timer))`,
        },
      });
      expect(result.diagnostics.length > 0).toBe(leaks);
    });
  }
}

for (const [name, source, leaks] of [
  [
    "case search preserves cleanup on default",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { case (clearInterval(timer), 0): break; default: break } })",
    false,
  ],
  [
    "case search evaluates tests after a leading default",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { default: break; case (clearInterval(timer), 0): break } })",
    false,
  ],
  [
    "literal switch skips unreachable resource",
    "switch (0) { case 1: setInterval(refresh) }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "literal switch skips later tests after match",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (0) { case 0: break; case (clearInterval(timer), 1): break } })",
    true,
  ],
  [
    "call forwards cleanup arguments",
    "const timer = setInterval(refresh); function cleanup(h) { clearInterval(h) }; import.meta.hot.dispose(() => cleanup.call(null, timer))",
    false,
  ],
  [
    "apply forwards cleanup receiver",
    "const holder = { timer: setInterval(refresh) }; function cleanup(h) { clearInterval(this.timer); clearInterval(h) }; const other = setInterval(refresh); import.meta.hot.dispose(() => cleanup.apply(holder, [other]))",
    false,
  ],
  [
    "for of cleans every concrete handle",
    "const timers = [setInterval(refresh), setInterval(refresh)]; import.meta.hot.dispose(() => { for (const timer of timers) clearInterval(timer) })",
    false,
  ],
  [
    "for of break leaves later handles live",
    "const timers = [setInterval(refresh), setInterval(refresh)]; import.meta.hot.dispose(() => { for (const timer of timers) { clearInterval(timer); break } })",
    true,
  ],
  [
    "for of continue reaches later handles",
    "const timers = [setInterval(refresh), setInterval(refresh)]; import.meta.hot.dispose(() => { for (const timer of timers) { clearInterval(timer); continue } })",
    false,
  ],
  [
    "null optional call skips resource argument",
    "null?.(setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "optional chain skips computed key and arguments",
    "const absent = null; absent?.[setInterval(refresh)](setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "non-null optional call tracks resource argument",
    "function setup(h) {}; setup?.(setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const [name, source, leaks] of [
  [
    "Promise executor creates a live timer",
    "new Promise(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "Promise executor exposes its timer for cleanup",
    "let timer; new Promise(() => { timer = setInterval(refresh) }); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "Promise executor throw does not stop module evaluation",
    "new Promise(() => { throw error }); const timer = setInterval(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "shadowed Promise does not invoke its argument",
    "function Promise(executor) {}; new Promise(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "static arrow captures class receiver",
    "class Worker { static timer = setInterval(refresh); static cleanup = () => clearInterval(this.timer) }; import.meta.hot.dispose(Worker.cleanup)",
    false,
  ],
  [
    "static field aliases class resource",
    "class Worker { static timer = setInterval(refresh); static alias = this.timer }; import.meta.hot.dispose(() => clearInterval(Worker.alias))",
    false,
  ],
  [
    "static block captures class receiver",
    "class Worker { static timer = setInterval(refresh); static { this.cleanup = () => clearInterval(this.timer) } }; import.meta.hot.dispose(Worker.cleanup)",
    false,
  ],
  [
    "helper returns alternate handles",
    "function start() { if (flag) return setInterval(a); return setInterval(b) }; const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "inline helper returns alternate handles",
    "function start() { if (flag) return setInterval(a); return setInterval(b) }; clearInterval(start()); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "returning one of two live handles preserves leak",
    "function start() { const a = setInterval(refresh); const b = setInterval(refresh); if (flag) return a; return b }; const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "missing optional method skips argument",
    "const object = {}; object.missing?.(setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "missing optional method skips chained key",
    "const object = {}; object.missing?.()[setInterval(refresh)]; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "present optional method evaluates argument",
    "const object = { method() {} }; object.method?.(setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const [name, source, leaks] of [
  [
    "implicit optional returned handle",
    "function start() { if (flag) return setInterval(refresh) }; const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "explicit optional returned handle",
    "function start() { if (flag) return setInterval(refresh); return undefined }; clearInterval(start()); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "optional return cannot hide an unreturned live handle",
    "function start() { const timer = setInterval(refresh); if (flag) return timer }; const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "filter callback creates a resource",
    "[1].filter(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "empty filter skips callback",
    "[].filter(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "filter retains original resource handles",
    "const timers = [setInterval(refresh)].filter(() => true); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "filter discards resource handles on false",
    "const timers = [setInterval(refresh)].filter(() => false); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "do while break skips test",
    "do { break } while (setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "do while return skips test",
    "function start() { do { return } while (setInterval(refresh)) }; start(); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "do while continue reaches test",
    "do { continue } while (setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "do while normal body reaches test",
    "do { refresh() } while (setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "member branches preserve alternative handles",
    "const state = {}; if (flag) state.timer = setInterval(a); else state.timer = setInterval(b); import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  [
    "optional member preserves handle",
    "const state = {}; if (flag) state.timer = setInterval(a); import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  [
    "member branches cannot hide two live handles",
    "const a = setInterval(refresh); const b = setInterval(refresh); const state = {}; if (flag) state.timer = a; else state.timer = b; import.meta.hot.dispose(() => clearInterval(state.timer))",
    true,
  ],
  [
    "do while guarantees first cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { do { clearInterval(timer) } while (false) })",
    false,
  ],
  [
    "do while break after cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { do { clearInterval(timer); break } while (flag) })",
    false,
  ],
  [
    "do while conditional early break leaks",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { do { if (flag) break; clearInterval(timer) } while (false) })",
    true,
  ],
  [
    "do while conditional cleanup leaks",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { do { if (flag) clearInterval(timer) } while (false) })",
    true,
  ],
  [
    "pushed timer is cleaned",
    "const timers = []; timers.push(setInterval(refresh)); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "pushed timers retain aliases and existing entries",
    "const timers = [setInterval(refresh)]; const alias = timers; alias.push(setInterval(refresh), setTimeout(refresh)); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "pushed timer remains live without cleanup",
    "const timers = []; timers.push(setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "pushed timer can be indexed",
    "const timers = []; timers.push(setInterval(refresh)); import.meta.hot.dispose(() => clearInterval(timers[0]))",
    false,
  ],
  [
    "array forEach forwards thisArg",
    "const owner = { timer: setInterval(refresh) }; import.meta.hot.dispose(() => [0].forEach(function () { clearInterval(this.timer) }, owner))",
    false,
  ],
  [
    "array map forwards thisArg",
    "const owner = { timer: setInterval(refresh) }; import.meta.hot.dispose(() => [0].map(function () { clearInterval(this.timer) }, owner))",
    false,
  ],
  [
    "array filter forwards thisArg",
    "const owner = { timer: setInterval(refresh) }; import.meta.hot.dispose(() => [0].filter(function () { clearInterval(this.timer) }, owner))",
    false,
  ],
  [
    "array arrow callback ignores thisArg",
    "const owner = { timer: setInterval(refresh) }; import.meta.hot.dispose(() => [0].forEach(() => clearInterval(this.timer), owner))",
    true,
  ],
  [
    "pushed timer supports for of cleanup",
    "const timers = []; timers.push(setInterval(refresh)); import.meta.hot.dispose(() => { for (const timer of timers) clearInterval(timer) })",
    false,
  ],
  [
    "pushed timer supports destructuring cleanup",
    "const timers = []; timers.push(setInterval(refresh)); const [timer] = timers; import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "overwritten push does not retain handles",
    "const timers = []; timers.push = () => {}; timers.push(setInterval(refresh)); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "conditional push of existing timer still leaks",
    "const timer = setInterval(refresh); const timers = []; if (flag) timers.push(timer); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "array callback thisArg overrides method owner",
    "const original = { timer: setInterval(refresh), cleanup() { clearInterval(this.timer) } }; const owner = { timer: setInterval(refresh) }; import.meta.hot.dispose(() => [0].forEach(original.cleanup, owner))",
    true,
  ],
  [
    "array callback without thisArg does not retain method owner",
    "const owner = { timer: setInterval(refresh), cleanup() { clearInterval(this.timer) } }; import.meta.hot.dispose(() => [0].forEach(owner.cleanup))",
    true,
  ],
  [
    "large array length does not allocate analysis elements",
    "const timers = []; timers.length = 4294967295; timers.push(setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "branch selected objects preserve resource members",
    "let state; if (flag) state = { timer: setInterval(a) }; else state = { timer: setInterval(b) }; import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  [
    "branch selected objects cannot hide separate live resources",
    "const a = setInterval(refresh); const b = setInterval(refresh); let state; if (flag) state = { timer: a }; else state = { timer: b }; import.meta.hot.dispose(() => clearInterval(state.timer))",
    true,
  ],
  [
    "branch selected nested objects preserve resource members",
    "let state; if (flag) state = { inner: { timer: setInterval(a) } }; else state = { inner: { timer: setInterval(b) } }; import.meta.hot.dispose(() => clearInterval(state.inner.timer))",
    false,
  ],
  [
    "branch selected objects preserve assigned members",
    "let state; if (flag) { state = {}; state.timer = setInterval(a) } else { state = {}; state.timer = setInterval(b) }; import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  [
    "branch selected cyclic objects preserve resource members",
    "let state; if (flag) { state = { timer: setInterval(a) }; state.self = state } else { state = { timer: setInterval(b) }; state.self = state }; import.meta.hot.dispose(() => clearInterval(state.self.timer))",
    false,
  ],
  [
    "branch arrays retain timers",
    "let timers; if (flag) timers = [setInterval(a)]; else timers = [setInterval(b)]; import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "branch arrays preserve separate leaks",
    "const a = setInterval(refresh); const b = setInterval(refresh); const timers = flag ? [a] : [b]; import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "assignment expressions return handles",
    "let slot; const timer = (slot = setInterval(refresh)); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "member assignment expressions return handles",
    "const state = {}; const timer = (state.timer = setInterval(refresh)); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "qualified cleanup aliases retain identity",
    "const stop = window.clearInterval; const timer = setInterval(refresh); import.meta.hot.dispose(() => stop(timer))",
    false,
  ],
  [
    "stable member guards correlate registration",
    "const state = { enabled }; let timer; if (state.enabled) timer = setInterval(refresh); if (state.enabled) import.meta.hot.dispose(() => clearInterval(timer)); else import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "changed member guards do not correlate",
    "const state = { enabled }; let timer; if (state.enabled) timer = setInterval(refresh); state.enabled = other; if (state.enabled) import.meta.hot.dispose(() => clearInterval(timer)); else import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "true while executes cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { while (true) { clearInterval(timer); break } })",
    false,
  ],
  [
    "unconditional for executes cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { for (;;) { clearInterval(timer); break } })",
    false,
  ],
  [
    "mandatory loop preserves early exit leaks",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { while (true) { if (flag) break; clearInterval(timer); break } })",
    true,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const [name, source, leaks] of [
  [
    "shifted conditional arrays",
    "const timer = setInterval(refresh); const timers = flag ? [timer] : [, timer]; import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "shifted assigned arrays",
    "const timer = setInterval(refresh); let timers; if(flag) timers = [timer]; else timers = [,timer]; import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "shifted arrays preserve other leaks",
    "const timer = setInterval(refresh); const other = setInterval(refresh); const timers = flag ? [timer, other] : [, timer]; import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "shifted arrays preserve callback indices",
    "const timer = setInterval(refresh); const timers = flag ? [timer] : [, timer]; import.meta.hot.dispose(() => timers.forEach((t,i) => { if (i === 0) clearInterval(t) }))",
    true,
  ],
  [
    "awaited async handle",
    "async function start() { return setInterval(refresh) }; const timer = await start(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "unawaited async handle",
    "async function start() { return setInterval(refresh) }; const timer = start(); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "nested awaited async handle",
    "async function start() { return setInterval(refresh) }; async function outer() { return start() }; const timer = await outer(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "nested async rejection prevents cleanup",
    "async function fail() { throw Error() }; async function outer() { return fail() }; const timer = setInterval(refresh); import.meta.hot.dispose(async () => { await outer(); clearInterval(timer) })",
    true,
  ],
  [
    "removal pop()",
    "const timers = [setInterval(refresh)]; timers.pop(); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "removal shift()",
    "const timers = [setInterval(refresh)]; timers.shift(); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "removal splice(0, 1)",
    "const timers = [setInterval(refresh)]; timers.splice(0, 1); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "forward factory setInterval.call(window, refresh) True",
    "const timer = setInterval.call(window, refresh); import.meta.hot.dispose(() => { clearInterval(timer) })",
    false,
  ],
  [
    "forward factory setInterval.call(window, refresh) False",
    "const timer = setInterval.call(window, refresh); import.meta.hot.dispose(() => {  })",
    true,
  ],
  [
    "forward factory setInterval.apply(window, [refresh]) True",
    "const timer = setInterval.apply(window, [refresh]); import.meta.hot.dispose(() => { clearInterval(timer) })",
    false,
  ],
  [
    "forward factory setInterval.apply(window, [refresh]) False",
    "const timer = setInterval.apply(window, [refresh]); import.meta.hot.dispose(() => {  })",
    true,
  ],
  [
    "forward factory window.setTimeout.call(window, refresh) True",
    "const timer = window.setTimeout.call(window, refresh); import.meta.hot.dispose(() => { clearInterval(timer) })",
    false,
  ],
  [
    "forward factory window.setTimeout.call(window, refresh) False",
    "const timer = window.setTimeout.call(window, refresh); import.meta.hot.dispose(() => {  })",
    true,
  ],
  [
    "synchronous some",
    "[1,2].some(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "synchronous every",
    "[1,2].every(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "synchronous find",
    "[1,2].find(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "synchronous findIndex",
    "[1,2].findIndex(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "synchronous findLast",
    "[1,2].findLast(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "synchronous findLastIndex",
    "[1,2].findLastIndex(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "synchronous reduce",
    "[1,2].reduce(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "synchronous reduceRight",
    "[1,2].reduceRight(() => { setInterval(refresh); return true }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "short circuit some",
    "[true,false].some(x => { if (x) return true; setInterval(refresh); return false }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "short circuit find",
    "[true,false].find(x => { if (x) return true; setInterval(refresh); return false }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "logical guard &&",
    "let timer; enabled && (timer = setInterval(refresh)); enabled && import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "logical initializer retains guarded timer",
    "const timer = enabled && setInterval(refresh); import.meta.hot.dispose(() => { if (enabled) clearInterval(timer) })",
    false,
  ],
  [
    "bound global timer factory leaks",
    "const start = setInterval.bind(globalThis); start(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "bound global timer factory cleans up",
    "const start = setInterval.bind(globalThis); const timer = start(refresh); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "known object spread retains timer",
    "const state = { ...{ timer: setInterval(refresh) } }; import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  [
    "computed key mutation invalidates timer handle",
    "const state = { timer: setInterval(refresh) }; const key = 'timer'; state[key] = undefined; import.meta.hot.dispose(() => clearInterval(state.timer))",
    true,
  ],
  [
    "Object.assign mutation invalidates timer handle",
    "const state = { timer: setInterval(refresh) }; Object.assign(state, { timer: undefined }); import.meta.hot.dispose(() => clearInterval(state.timer))",
    true,
  ],
  [
    "Object.assign retains assigned timer handle",
    "const state = {}; Object.assign(state, { timer: setInterval(refresh) }); import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  [
    "Object.assign reads a replaced source member",
    "const source = { timer: setInterval(refresh) }; source.timer = undefined; const target = {}; Object.assign(target, source); import.meta.hot.dispose(() => clearInterval(target.timer))",
    true,
  ],
  [
    "Object.assign reads an added source member",
    "const source = {}; source.timer = setInterval(refresh); const target = {}; Object.assign(target, source); import.meta.hot.dispose(() => clearInterval(target.timer))",
    false,
  ],
  [
    "Object.assign invokes target setter that discards timer",
    "const target = { set timer(value) {} }; const timer = setInterval(refresh); Object.assign(target, { timer }); import.meta.hot.dispose(() => clearInterval(target.timer))",
    true,
  ],
  [
    "Object.assign invokes target setter that cleans timer",
    "const target = { set timer(value) { clearInterval(value) } }; Object.assign(target, { timer: setInterval(refresh) }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "truthy timer guard cleans timer",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (timer) clearInterval(timer) })",
    false,
  ],
  [
    "truthy timer logical guard cleans timer",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => timer && clearInterval(timer))",
    false,
  ],
  [
    "timer callback creates a resource before dispose",
    "const pending = setTimeout(() => setInterval(refresh), 0); import.meta.hot.dispose(() => clearTimeout(pending))",
    true,
  ],
  [
    "sliced array retains timer handle",
    "const timers = [setInterval(refresh)].slice(); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "deleting object member invalidates timer handle",
    "const state = { timer: setInterval(refresh) }; delete state.timer; import.meta.hot.dispose(() => clearInterval(state.timer))",
    true,
  ],
  [
    "spread getter creates a timer",
    "const source = { get timer() { setInterval(refresh); return 0 } }; const state = { ...source }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "Array.from mapper creates a timer",
    "Array.from([1], () => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "reading a getter creates a timer",
    "const source = { get timer() { return setInterval(refresh) } }; source.timer; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "object spread retains a getter-created timer",
    "const source = { get timer() { return setInterval(refresh) } }; const state = { ...source }; import.meta.hot.dispose(() => clearInterval(state.timer))",
    false,
  ],
  [
    "shadowed getter does not run during spread",
    "const source = { get timer() { setInterval(refresh); return 0 }, timer: 0 }; ({ ...source }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "destination override still reads spread getter",
    "const source = { get timer() { setInterval(refresh); return 0 } }; ({ ...source, timer: 0 }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "copied getter becomes a data property",
    "const original = { get timer() { setInterval(refresh); return 0 } }; const source = { ...original }; ({ ...source }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "computed getter creates a timer",
    "const key = 'timer'; const source = { get [key]() { return setInterval(refresh) } }; source[key]; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "shadowed computed getter does not run",
    "const key = 'timer'; const source = { get [key]() { setInterval(refresh); return 0 }, timer: 0 }; source[key]; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "setter cleans up assigned timer",
    "const timer = setInterval(refresh); const owner = { set timer(value) { clearInterval(value) } }; import.meta.hot.dispose(() => { owner.timer = timer })",
    false,
  ],
  [
    "tagged template invokes resource factory",
    "function start() { setInterval(refresh) }; start`now`; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "resolved promise reaction creates a timer",
    "Promise.resolve().then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "resolved promise reaction runs after synchronous cleanup",
    "let timer; Promise.resolve().then(() => { timer = setInterval(refresh) }); clearInterval(timer); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "null event listener does not register a resource",
    "addEventListener('click', null); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "listener-rejected await creates an undisposed resource in catch",
    "let rejectReady; const ready = new Promise((resolve, reject) => { rejectReady = reject }); async function start() { try { await ready } catch { setInterval(refresh) } } start(); const handler = () => rejectReady(Error()); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "awaited promise reaction retains a timer",
    "const pending = Promise.resolve().then(() => setInterval(refresh)); const timer = await pending; import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "listener registration is not truthy",
    "const target = document; const handler = () => {}; const result = target.addEventListener('change', handler); import.meta.hot.dispose(() => { if (result) target.removeEventListener('change', handler) })",
    true,
  ],
  [
    "synchronously canceled timeout never fires",
    "const pending = setTimeout(() => setInterval(refresh), 0); clearTimeout(pending); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "canceling timeout during disposal cannot credit its callback cleanup",
    "const timer = setInterval(refresh); const pending = setTimeout(() => clearInterval(timer), 0); import.meta.hot.dispose(() => clearTimeout(pending))",
    true,
  ],
  [
    "timeout replacement is cleaned in both disposal orderings",
    "let timer = setInterval(refresh); const pending = setTimeout(() => { clearInterval(timer); timer = setInterval(refresh) }, 0); import.meta.hot.dispose(() => { clearTimeout(pending); clearInterval(timer) })",
    false,
  ],
  [
    "uncanceled timeout replacement leaks after disposal",
    "let timer = setInterval(refresh); setTimeout(() => { clearInterval(timer); timer = setInterval(refresh) }, 0); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "intermediate timeout firing leaves a live interval",
    "let timer; const first = setTimeout(() => { timer = setInterval(refresh) }, 0); const second = setTimeout(() => clearInterval(timer), 100); import.meta.hot.dispose(() => { clearTimeout(first); clearTimeout(second) })",
    true,
  ],
  [
    "built-in superclass creates a socket",
    "class Socket extends WebSocket {}; new Socket(url); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "built-in superclass socket closes",
    "class Socket extends WebSocket {}; const socket = new Socket(url); import.meta.hot.dispose(() => socket.close())",
    false,
  ],
  [
    "built-in superclass never creates a socket before throwing",
    "class Socket extends WebSocket { constructor() { throw Error() } }; try { new Socket() } catch {}; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "built-in superclass creates a socket after explicit super",
    "class Socket extends WebSocket { constructor(url) { super(url) } }; new Socket(url); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "constant comparison guards cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (1 === 1) clearInterval(timer) })",
    false,
  ],
  [
    "coercive equality guard cannot credit unreachable cleanup",
    'const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (0 == "0") saveState(); else clearInterval(timer) })',
    true,
  ],
  [
    "coercive equality guard selects cleanup",
    'const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (0 == "0") clearInterval(timer) })',
    false,
  ],
  [
    "coercive inequality guard cannot credit unreachable cleanup",
    'const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (0 != "0") clearInterval(timer) })',
    true,
  ],
  [
    "coercive inequality guard selects cleanup",
    'const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (0 != "1") clearInterval(timer) })',
    false,
  ],
  [
    "subscription results have unknown truthiness",
    "const sub = events.subscribe(refresh); import.meta.hot.dispose(() => { if (sub) sub.unsubscribe() })",
    true,
  ],
  [
    "resolved rejecting promise skips fulfilled reaction",
    "async function fail() { throw Error('no') }; Promise.resolve(fail()).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "rejected promise catch creates a timer",
    "async function fail() { throw Error('no') }; fail().catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "rejected promise then handler creates a timer",
    "async function fail() { throw Error('no') }; fail().then(undefined, () => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "fulfilled promise skips catch handler",
    "Promise.resolve().catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "mixed async rejection handler creates timer",
    "async function maybe() { if (flag) return 1; throw Error() }; maybe().then(undefined, () => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "mixed async catch handler creates timer",
    "async function maybe() { if (flag) return 1; throw Error() }; maybe().catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "mixed promise fulfillment cleanup cannot hide rejection leak",
    "const timer = setInterval(refresh); async function maybe() { if (flag) return 1; throw Error() }; maybe().then(() => clearInterval(timer), () => {}); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "fulfilled promise finally handler creates timer",
    "Promise.resolve().finally(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "rejected promise finally handler creates timer",
    "async function fail() { throw Error() }; fail().finally(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "timeout callback receives timer arguments",
    "const pending = setTimeout(start => { if (start) setInterval(refresh) }, 0, false); import.meta.hot.dispose(() => clearTimeout(pending))",
    false,
  ],
  [
    "aborted signal skips listener registration",
    "const controller = new AbortController(); controller.abort(); window.addEventListener('resize', refresh, { signal: controller.signal }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "conditional abort cannot skip listener registration",
    "const controller = new AbortController(); if (flag) controller.abort(); window.addEventListener('resize', refresh, { signal: controller.signal }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "optional dispose registers cleanup",
    "const timer = setInterval(refresh); import.meta.hot?.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "unreachable catch does not create timer",
    "try {} catch { setInterval(refresh) }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "Promise constructor fulfillment handler creates timer",
    "new Promise(resolve => resolve()).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "Promise constructor rejection handler creates timer",
    "new Promise((resolve, reject) => reject(Error())).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "Array.at retains the interval handle",
    "const timer = [setInterval(refresh)].at(0); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "sorted array may move the timer away from index zero",
    "const timer = setInterval(refresh); const values = [timer, '']; values.sort(); import.meta.hot.dispose(() => clearInterval(values[0]))",
    true,
  ],
  [
    "conditional async rejection prevents cleanup",
    "const timer = setInterval(refresh); async function fail() { throw Error('no') }; async function outer() { if (flag) return fail(); return 1 }; import.meta.hot.dispose(async () => { await outer(); clearInterval(timer) })",
    true,
  ],
  [
    "object spread override retains latest timer",
    "const state = { timer: setInterval(refresh), ...{ timer: setInterval(refresh) } }; import.meta.hot.dispose(() => clearInterval(state.timer))",
    true,
  ],
  [
    "logical guard ||",
    "let timer; enabled || (timer = setInterval(refresh)); enabled || import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "removed timer can be cleaned",
    "const timers = [setInterval(refresh)]; const timer = timers.pop(); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "splice returns removed handles",
    "const timers = [setInterval(refresh)]; const removed = timers.splice(0,1); import.meta.hot.dispose(() => removed.forEach(clearInterval))",
    false,
  ],
  [
    "reduce forwards accumulator handles",
    "const timer = [1].reduce(() => setInterval(refresh), null); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "some does not guarantee later cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => [true,false].some(first => { if (first) return flag; clearInterval(timer); return true }))",
    true,
  ],
  [
    "changed logical guards preserve leaks",
    "let timer; let enabled = flag; enabled && (timer = setInterval(refresh)); enabled = other; enabled && import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "mixed logical and if guards correlate",
    "let timer; enabled && (timer = setInterval(refresh)); if(enabled) import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "forwarded timer cleanup",
    "const timer = setInterval.call(window, refresh); import.meta.hot.dispose(() => clearInterval.apply(window, [timer]))",
    false,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

for (const [name, source, leaks] of [
  [
    "unawaited rejection before setup",
    "async function fail(){ throw Error() }; fail(); setInterval(refresh); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "unawaited rejection before cleanup",
    "async function fail(){ throw Error() }; const timer = setInterval(refresh); import.meta.hot.dispose(() => { fail(); clearInterval(timer) })",
    false,
  ],
  [
    "awaited rejection prevents cleanup",
    "async function fail(){ throw Error() }; const timer = setInterval(refresh); import.meta.hot.dispose(async () => { await fail(); clearInterval(timer) })",
    true,
  ],
  [
    "flatMap setup",
    "[1].flatMap(() => { setInterval(refresh); return [] }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "flatMap returned handles",
    "const timers = [1].flatMap(() => [setInterval(refresh)]); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  ...["find", "findIndex", "findLast", "findLastIndex"].map(
    (method) =>
      [
        `${method} visits holes`,
        `[,].${method}(() => { setInterval(refresh); return false }); import.meta.hot.dispose(() => {})`,
        true,
      ] as const,
  ),
  ...["find", "findLast"].flatMap((method) => [
    [
      `${method} returns handle`,
      `const timer = [setInterval(refresh)].${method}(() => true); import.meta.hot.dispose(() => clearInterval(timer))`,
      false,
    ] as const,
    [
      `${method} Boolean returns handle`,
      `const timer = [setInterval(refresh)].${method}(Boolean); import.meta.hot.dispose(() => clearInterval(timer))`,
      false,
    ] as const,
    [
      `${method} Boolean returns nested handle`,
      `const timer = setInterval(refresh); const selected = [[timer]].${method}(Boolean); import.meta.hot.dispose(() => selected.forEach(clearInterval))`,
      false,
    ] as const,
    [
      `${method} uncertain selection`,
      `const timers = [setInterval(refresh), setInterval(refresh)]; const timer = timers.${method}(() => flag); import.meta.hot.dispose(() => clearInterval(timer))`,
      true,
    ] as const,
  ]),
  [
    "spread helper cleanup",
    "const timer = setInterval(refresh); function cleanup(handle) { clearInterval(handle) }; import.meta.hot.dispose(() => cleanup(...[timer]))",
    false,
  ],
  [
    "spread direct cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(...[timer]))",
    false,
  ],
  [
    "hot data cleanup",
    "import.meta.hot.data.timer = setInterval(refresh); import.meta.hot.dispose(data => clearInterval(data.timer))",
    false,
  ],
  [
    "hot data destructured cleanup",
    "import.meta.hot.data.timer = setInterval(refresh); import.meta.hot.dispose(({timer}) => clearInterval(timer))",
    false,
  ],
  [
    "sort comparator setup",
    "[2,1].sort(() => { setInterval(refresh); return 0 }); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "sort comparator cleans its resources",
    "[2,1].sort(() => { const timer = setInterval(refresh); clearInterval(timer); return 0 }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "sort repeated comparator leaks",
    "let timer; [3,2,1].sort(() => { timer = setInterval(refresh); return 0 }); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "nested spread cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => clearInterval(...[...[timer]]))",
    false,
  ],
  [
    "sort singleton skips comparator",
    "[1].sort(() => { setInterval(refresh); return 0 }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "sort skips undefined comparator",
    "[undefined, 1].sort(() => { setInterval(refresh); return 0 }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "sort retains timer handles",
    "const timers = [setInterval(refresh), setInterval(refresh)]; timers.sort(); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "sort retains array identity",
    "const timers = []; const same = timers.sort(); same.push(setInterval(refresh)); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "listener-scheduled timeout can leak a nested interval",
    "let pending; const start = () => { pending = setTimeout(() => setInterval(refresh), 0) }; document.addEventListener('click', start); import.meta.hot.dispose(() => { document.removeEventListener('click', start); clearTimeout(pending) })",
    true,
  ],
  [
    "expired timeout does not require guarded disposal",
    "let pending = setTimeout(() => { pending = null }, 0); import.meta.hot.dispose(() => { if (pending !== null) clearTimeout(pending) })",
    false,
  ],
  [
    "Set forEach cleans handles added before disposal",
    "const timers = new Set(); timers.add(setInterval(refresh)); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "Set forEach cleans handles from a known iterable",
    "const timers = new Set([setInterval(refresh)]); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "Set forEach cleans more than 64 known handles",
    `const timers = new Set([${Array.from({ length: 65 }, (_, index) => `setInterval(refresh${index})`).join(", ")}]); import.meta.hot.dispose(() => timers.forEach(clearInterval))`,
    false,
  ],
  [
    "Set delete removes cleanup credit",
    "const timer = setInterval(refresh); const timers = new Set([timer]); timers.delete(timer); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "Set clear removes cleanup credit",
    "const timers = new Set([setInterval(refresh)]); timers.clear(); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "Set re-add restores cleanup credit",
    "const timer = setInterval(refresh); const timers = new Set([timer]); timers.delete(timer); timers.add(timer); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "canceled short timer does not fire in alternate ordering",
    "const long = setTimeout(() => {}, 100); const short = setTimeout(() => setInterval(refresh), 0); clearTimeout(short); import.meta.hot.dispose(() => clearTimeout(long))",
    false,
  ],
  [
    "one-shot listener timer can leak a nested interval",
    "const start = () => { setTimeout(() => setInterval(refresh), 0) }; document.addEventListener('click', start, { once: true }); import.meta.hot.dispose(() => document.removeEventListener('click', start))",
    true,
  ],
  [
    "Promise.resolve adopts possible rejection from unknown calls",
    "Promise.resolve(getPromise()).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "pending async continuation can create a resource after disposal",
    "let timer; async function start() { await fetch('/data'); timer = setInterval(refresh) } start(); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "listener-resolved promise resumes an async resource creator",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); async function start() { await ready; setInterval(refresh) } start(); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "disposal cleans a resource created after listener resolves an await",
    "let finish; let timer; const ready = new Promise(resolve => { finish = resolve }); async function start() { await ready; timer = setInterval(refresh) } start(); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => { removeEventListener('click', handler); clearInterval(timer) })",
    false,
  ],
] as const) {
  test(name, async () => {
    const result = await runRuleFixture({
      framework: "vite",
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}

// Explores orderings up to the Rule's cap, so it takes ~1s idle and several seconds on a loaded
// machine; an uncapped 11! exploration would still blow far past this timeout.
test("many listeners have bounded ordering exploration", async () => {
  const handlers = Array.from({ length: 11 }, (_, index) => index);
  const source = `${handlers.map((index) => `const handler${index} = () => { ${index === 0 ? "setInterval(refresh)" : ""} }; document.addEventListener('event${index}', handler${index});`).join(" ")} import.meta.hot.dispose(() => { ${handlers.map((index) => `document.removeEventListener('event${index}', handler${index});`).join(" ")} })`;
  const result = await runRuleFixture({
    framework: "vite",
    rule: requireDisposeForSideEffects,
    files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
  });
  expect(result.diagnostics.length > 0).toBe(true);
}, 30_000);
