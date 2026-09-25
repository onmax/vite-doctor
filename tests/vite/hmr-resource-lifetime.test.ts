import { expect, test } from "vite-plus/test";
import { runRuleFixture } from "../../src/core/testkit.ts";
import { requireDisposeForSideEffects } from "../../src/rule-packs/vite/rules/plugin-hmr.ts";

for (const [name, source, leaks] of [
  [
    "native timer factory as promise handler creates resource",
    "Promise.resolve(refresh).then(setInterval); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "native timeout factory as promise handler creates resource",
    "Promise.resolve(refresh).then(setTimeout); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "once listener is removed before its callback runs",
    "let fired = false; const handler = () => { fired = true }; addEventListener('click', handler, { once: true }); import.meta.hot.dispose(() => { if (!fired) removeEventListener('click', handler) })",
    false,
  ],
  [
    "await suspends before evaluating later call arguments",
    "let timer; async function start() { consume(await Promise.resolve(), timer = setInterval(refresh)) } start(); clearInterval(timer); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "await does not repeat earlier call arguments",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); async function start() { consume(setInterval(refresh), await ready) } start(); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "awaited value in a suspended expression follows the eventual settlement",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); async function start() { consume(await ready, setInterval(refresh)) } start(); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "pending rejection survives finally",
    "let rejectReady; const ready = new Promise((resolve, reject) => { rejectReady = reject }); ready.finally(() => {}).catch(() => setInterval(refresh)); const handler = () => rejectReady(Error()); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "pending async return settles only after its await resumes",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); async function start() { await ready; return setInterval(refresh) } start().then(clearInterval); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    false,
  ],
  [
    "pending promise passes its resolved handle to a reaction",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); ready.then(clearInterval); const handler = () => finish(setInterval(refresh)); addEventListener('click', handler, { once: true }); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    false,
  ],
  [
    "Promise.all reacts to a later settled input",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); Promise.all([ready]).then(() => setInterval(refresh)); const handler = () => finish(1); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "Promise.allSettled reacts only after all inputs settle",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); Promise.allSettled([ready]).then(() => setInterval(refresh)); const handler = () => finish(1); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "Promise.allSettled retains the value of an input settled later",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); Promise.allSettled([ready]).then(results => clearInterval(results[0].value)); const handler = () => finish(setInterval(refresh)); addEventListener('click', handler, { once: true }); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    false,
  ],
  [
    "Promise.race reacts when its first input settles later",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); Promise.race([ready]).then(() => setInterval(refresh)); const handler = () => finish(1); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "array callbacks read slots after preceding callbacks mutate the array",
    "const timers = [setInterval(a), setInterval(b)]; import.meta.hot.dispose(() => timers.forEach((timer, index) => { if (!index) timers.pop(); clearInterval(timer) }))",
    true,
  ],
  [
    "timer callbacks can register listeners that create resources",
    "const handler = () => setInterval(refresh); const timer = setTimeout(() => addEventListener('click', handler), 0); import.meta.hot.dispose(() => { clearTimeout(timer); removeEventListener('click', handler) })",
    true,
  ],
  [
    "mixed promise settlement preserves rejection-only resource creation",
    "let resolveReady, rejectReady; const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject }); ready.catch(() => setInterval(refresh)); const handler = () => { if (Math.random()) resolveReady(1); else rejectReady(Error()) }; addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "settled await defers a resource until after synchronous cleanup",
    "let timer; async function start() { await Promise.resolve(); timer = setInterval(refresh) } start(); clearInterval(timer); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "nested timer callbacks can leave a resource live",
    "let inner; const outer = setTimeout(() => { inner = setTimeout(() => setInterval(refresh), 0) }, 0); import.meta.hot.dispose(() => { clearTimeout(outer); clearTimeout(inner) })",
    true,
  ],
  [
    "allSettled waits for every input",
    "let finish; const pending = new Promise(resolve => { finish = resolve }); const timer = setInterval(refresh); Promise.allSettled([pending]).then(() => clearInterval(timer)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "browser timer typeof guard cleans resource",
    "const timer = window.setInterval(refresh); import.meta.hot.dispose(() => { if (typeof timer === 'number') clearInterval(timer) })",
    false,
  ],
  [
    "Map get returns stored resource handle",
    "const timers = new Map([['refresh', setInterval(refresh)]]); import.meta.hot.dispose(() => clearInterval(timers.get('refresh')))",
    false,
  ],
  [
    "race skips pending input when selecting settled winner",
    "let finish; const pending = new Promise(resolve => { finish = resolve }); const timer = setInterval(refresh); Promise.race([pending, Promise.resolve(timer)]).then(clearInterval); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "Map delete returns true for an existing key",
    "const timer = setInterval(refresh); const timers = new Map([['refresh', timer]]); import.meta.hot.dispose(() => { if (timers.delete('refresh')) clearInterval(timer) })",
    false,
  ],
  [
    "Set constructor deduplicates aliased values",
    "const marker = {}; const values = new Set([marker, marker]); let first = true; values.forEach(() => { if (!first) setInterval(refresh); first = false }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "pending promise fulfillment propagates past a missing handler",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); ready.catch(() => {}).then(() => setInterval(refresh)); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "Map constructor overwrites duplicate keys",
    "const first = setInterval(refresh); const second = setInterval(refresh); const timers = new Map([['key', first], ['key', second]]); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "Map forEach skips deleted unvisited entries",
    "const first = setInterval(refresh); const second = setInterval(refresh); const timers = new Map([['first', first], ['second', second]]); import.meta.hot.dispose(() => timers.forEach((handle, key) => { clearInterval(handle); if (key === 'first') timers.delete('second') }))",
    true,
  ],
  [
    "Map forEach visits entries appended during iteration",
    "const first = setInterval(refresh); const second = setInterval(refresh); const timers = new Map([['first', first]]); import.meta.hot.dispose(() => timers.forEach((handle, key) => { clearInterval(handle); if (key === 'first') timers.set('second', second) }))",
    false,
  ],
  [
    "Map forEach uses overwritten unvisited values",
    "const first = setInterval(refresh); const second = setInterval(refresh); const replacement = setInterval(refresh); const timers = new Map([['first', first], ['second', second]]); import.meta.hot.dispose(() => timers.forEach((handle, key) => { clearInterval(handle); if (key === 'first') timers.set('second', replacement) }))",
    true,
  ],
  [
    "Promise.race selects first settled fulfillment",
    "const timer = setInterval(refresh); let selected; Promise.race([Promise.resolve(timer), Promise.reject(Error())]).then(handle => { selected = handle }); import.meta.hot.dispose(() => clearInterval(selected))",
    false,
  ],
  [
    "Promise.race selects first settled rejection",
    "Promise.race([Promise.reject(Error()), Promise.resolve(1)]).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "Promise.any uses first fulfillable value",
    "const timer = setInterval(refresh); let selected; Promise.any([Promise.reject(Error()), Promise.resolve(timer)]).then(handle => { selected = handle }); import.meta.hot.dispose(() => clearInterval(selected))",
    false,
  ],
  [
    "Promise.allSettled exposes fulfilled result value",
    "const timer = setInterval(refresh); Promise.allSettled([Promise.resolve(timer)]).then(results => clearInterval(results[0].value)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "Map forEach cleans known entry values",
    "const timers = new Map([['refresh', setInterval(refresh)]]); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    false,
  ],
  [
    "Map set and delete update disposer membership",
    "const timers = new Map(); const handle = setInterval(refresh); timers.set('refresh', handle); timers.delete('refresh'); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "Map deleted handle without disposer still leaks",
    "const timers = new Map(); const handle = setInterval(refresh); timers.set('refresh', handle); timers.delete('refresh'); import.meta.hot.dispose(() => {})",
    true,
  ],
  ...["allSettled", "race", "any"].map(
    (method) =>
      [
        `Promise.${method} fulfillment runs its reaction`,
        `Promise.${method}([Promise.resolve(1)]).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})`,
        true,
      ] as const,
  ),
  [
    "Promise.allSettled fulfills after rejected entries",
    "Promise.allSettled([Promise.reject(Error())]).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "Promise.any rejects an empty iterable",
    "Promise.any([]).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "Promise.race stays pending for an empty iterable",
    "Promise.race([]).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "class listener handleEvent getter creates a resource",
    "class Handler { get handleEvent() { setInterval(refresh); return () => {} } }; const handler = new Handler(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "class listener handleEvent getter returns a resource-creating callback",
    "class Handler { get handleEvent() { return () => setInterval(refresh) } }; const handler = new Handler(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "chained pending promise reactions create a resource",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); ready.then(() => 1).then(() => setInterval(refresh)); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "third interval firing creates an undisposed timer",
    "let stage = 0; const outer = setInterval(() => { if (stage === 2) setInterval(refresh); else stage++ }, 1000); import.meta.hot.dispose(() => clearInterval(outer))",
    true,
  ],
  [
    "listener signal accessor creates a resource",
    "const handler = () => {}; const options = { get signal() { setInterval(refresh); return undefined } }; addEventListener('click', handler, options); import.meta.hot.dispose(() => removeEventListener('click', handler, options))",
    true,
  ],
  [
    "listener passive accessor creates a resource",
    "const handler = () => {}; const options = { get passive() { setInterval(refresh); return true } }; addEventListener('click', handler, options); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "listener handleEvent accessor creates a resource when fired",
    "const handler = { get handleEvent() { setInterval(refresh); return () => {} } }; addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "listener handleEvent accessor returns a resource-creating callback",
    "const handler = { get handleEvent() { return () => setInterval(refresh) } }; addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "typeof known timer guard cleans resource",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (typeof timer !== 'undefined') clearInterval(timer) })",
    false,
  ],
  [
    "chronological timers preserve intermediate callback state",
    "let stage = 0; setTimeout(() => { if (stage === 2) setInterval(refresh) }, 30); setTimeout(() => { if (stage === 1) stage = 2 }, 20); setTimeout(() => { stage = 1 }, 10); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "resolver retained by listener settles a pending promise",
    "let finish; const ready = new Promise(resolve => { finish = resolve }); ready.then(() => setInterval(refresh)); const handler = () => finish(); addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "third listener firing creates an undisposed timer",
    "let stage = 0; const handler = () => { if (stage === 0) stage = 1; else if (stage === 1) stage = 2; else setInterval(refresh) }; addEventListener('click', handler); import.meta.hot.dispose(() => removeEventListener('click', handler))",
    true,
  ],
  [
    "pending fetch fulfillment cannot guarantee late cleanup",
    "const timer = setInterval(refresh); fetch('/data').then(() => clearInterval(timer)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "listener capture accessor creates a resource",
    "const options = { get capture() { setInterval(refresh); return false } }; const handler = () => {}; addEventListener('click', handler, options); import.meta.hot.dispose(() => removeEventListener('click', handler, options))",
    true,
  ],
  [
    "derived constructor reaches work before an unmodeled super",
    "const fail = () => { throw Error() }; class Worker extends null { first = fail(); constructor() { setInterval(refresh); return {} } }; new Worker(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "Set iteration skips only harmless added members at its bound",
    `const sentinel = {}; const timer = setInterval(refresh); const values = new Set([timer, ${Array.from({ length: 2047 }, () => "{}").join(", ")}]); import.meta.hot.dispose(() => values.forEach(value => { clearInterval(value); values.add(sentinel) }))`,
    false,
  ],
  [
    "Set iteration visits members added by the callback",
    "const timers = new Set([setInterval(refresh)]); let added = false; import.meta.hot.dispose(() => timers.forEach(timer => { if (!added) { added = true; timers.add(setInterval(refresh)) } clearInterval(timer) }))",
    false,
  ],
  [
    "Set iteration skips members deleted by the callback",
    "const timers = new Set([setInterval(refresh), setInterval(refresh)]); import.meta.hot.dispose(() => timers.forEach(timer => { timers.clear(); clearInterval(timer) }))",
    true,
  ],
  [
    "listener options getter creates a resource",
    "const handler = () => {}; const options = { get once() { setInterval(refresh); return false } }; document.addEventListener('click', handler, options); import.meta.hot.dispose(() => document.removeEventListener('click', handler, options))",
    true,
  ],
  [
    "throwing default parameter prevents disposal cleanup",
    "const timer = setInterval(refresh); const fail = () => { throw Error() }; import.meta.hot.dispose((data, unused = fail()) => clearInterval(timer))",
    true,
  ],
  [
    "unknown Promise.all input may reject",
    "Promise.all([getPromise()]).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "one-shot do while resource is cleaned",
    "let timer; do { timer = setInterval(refresh) } while (false); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "Object.assign getter throws into catch",
    "try { Object.assign({}, { get value() { throw Error() } }) } catch { setInterval(refresh) } import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "six listener orders with no resource creation do not leak",
    `${Array.from({ length: 6 }, (_, index) => `const handler${index} = () => {}; document.addEventListener('event${index}', handler${index});`).join(" ")} import.meta.hot.dispose(() => { ${Array.from({ length: 6 }, (_, index) => `document.removeEventListener('event${index}', handler${index});`).join(" ")} })`,
    false,
  ],
  [
    "truncated listener orders without resource creators do not leak",
    `${Array.from({ length: 7 }, (_, index) => `const handler${index} = () => {}; document.addEventListener('event${index}', handler${index});`).join(" ")} import.meta.hot.dispose(() => { ${Array.from({ length: 7 }, (_, index) => `document.removeEventListener('event${index}', handler${index});`).join(" ")} })`,
    false,
  ],
  [
    "subscription callback creates a resource before disposal",
    "const sub = events.subscribe(() => setInterval(refresh)); import.meta.hot.dispose(() => sub.unsubscribe())",
    true,
  ],
  [
    "repeat subscription notifications overwrite an undisposed timer",
    "let timer; const sub = events.subscribe(() => { timer = setInterval(refresh) }); import.meta.hot.dispose(() => { clearInterval(timer); sub.unsubscribe() })",
    true,
  ],
  [
    "second subscription emission creates an undisposed resource",
    "let emitted = false; const sub = events.subscribe(() => { if (emitted) setInterval(refresh); emitted = true }); import.meta.hot.dispose(() => sub.unsubscribe())",
    true,
  ],
  [
    "sequential subscriptions create an undisposed resource",
    "let emitted = false; const first = events.subscribe(() => { emitted = true }); const second = events.subscribe(() => { if (emitted) setInterval(refresh) }); import.meta.hot.dispose(() => { first.unsubscribe(); second.unsubscribe() })",
    true,
  ],
  [
    "unexplored listener order can create a resource",
    `let order = 0; ${Array.from({ length: 7 }, (_, index) => `const handler${index} = () => { if (order === ${6 - index}) order++; if (order === 7) setInterval(refresh) }; document.addEventListener('event${index}', handler${index}, { once: true });`).join(" ")} import.meta.hot.dispose(() => { ${Array.from({ length: 7 }, (_, index) => `document.removeEventListener('event${index}', handler${index});`).join(" ")} })`,
    true,
  ],
  [
    "simulated listener drains queued microtasks",
    "const handler = () => queueMicrotask(() => setInterval(refresh)); document.addEventListener('click', handler); import.meta.hot.dispose(() => document.removeEventListener('click', handler))",
    true,
  ],
  [
    "Promise.all passes fulfilled values to reactions",
    "Promise.all([Promise.resolve(false)]).then(([start]) => { if (start) setInterval(refresh) }); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "Promise.all passes resolved resource handles to reactions",
    "let timer; Promise.all([Promise.resolve(setInterval(refresh))]).then(([handle]) => { timer = handle }); import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "static setter can create a resource",
    "class State { static set value(handle) { setInterval(refresh) } }; State.value = 1; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "inherited static setter can create a resource",
    "class Base { static set value(handle) { setInterval(refresh) } }; class State extends Base {}; State.value = 1; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "own static getter shadows inherited setter",
    "class Base { static set value(handle) { setInterval(refresh) } }; class State extends Base { static get value() { return 1 } }; State.value = 1; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "own static setter shadows inherited getter",
    "class Base { static get value() { return setInterval(refresh) } }; class State extends Base { static set value(handle) {} }; State.value = 1; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "null guard retains cleanup of a known timer",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { if (timer != null) clearInterval(timer) })",
    false,
  ],
  [
    "static setter can clean a resource",
    "const timer = setInterval(refresh); class State { static set value(handle) { clearInterval(handle) } }; import.meta.hot.dispose(() => { State.value = timer })",
    false,
  ],
  [
    "later one-shot listener can replace a timer before an earlier listener clears it",
    "let timer = setInterval(refresh); const clear = () => clearInterval(timer); const replace = () => { timer = setInterval(refresh) }; document.addEventListener('click', clear, { once: true }); document.addEventListener('click', replace, { once: true }); import.meta.hot.dispose(() => { clearInterval(timer); document.removeEventListener('click', clear); document.removeEventListener('click', replace) })",
    true,
  ],
  [
    "three listener ordering can overwrite a live timer",
    "let timer = setInterval(refresh); let armed = false; const reset = () => { clearInterval(timer); armed = false }; const arm = () => { armed = true }; const replace = () => { if (armed) timer = setInterval(refresh) }; document.addEventListener('reset', reset, { once: true }); document.addEventListener('arm', arm, { once: true }); document.addEventListener('replace', replace, { once: true }); import.meta.hot.dispose(() => { clearInterval(timer); document.removeEventListener('reset', reset); document.removeEventListener('arm', arm); document.removeEventListener('replace', replace) })",
    true,
  ],
  [
    "interval firing creates a timer",
    "const outer = setInterval(() => setInterval(refresh), 1000); import.meta.hot.dispose(() => clearInterval(outer))",
    true,
  ],
  [
    "second interval firing overwrites a live timer",
    "let inner; const outer = setInterval(() => { inner = setInterval(refresh) }, 1000); import.meta.hot.dispose(() => { clearInterval(outer); clearInterval(inner) })",
    true,
  ],
  [
    "second interval firing cleans the previous timer",
    "let inner; const outer = setInterval(() => { clearInterval(inner); inner = setInterval(refresh) }, 1000); import.meta.hot.dispose(() => { clearInterval(outer); clearInterval(inner) })",
    false,
  ],
  [
    "fetch fulfillment can create an interval",
    "fetch('/data').then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "fetch fulfillment can create a timer after disposal",
    "let timer; fetch('/data').then(() => { timer = setInterval(refresh) }); import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "microtask cleanup runs before disposal",
    "const timer = setInterval(refresh); queueMicrotask(() => clearInterval(timer)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "fetch rejection can create an interval",
    "fetch('/data').catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "fetch rejection cannot run a later fulfillment handler",
    "fetch('/data').then(() => Promise.reject(Error()), () => Promise.reject(Error())).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "fetch fulfillment cannot run a later rejection handler",
    "fetch('/data').then(() => Promise.resolve(), () => Promise.resolve()).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "inherited static method creates an interval",
    "class Base { static start() { setInterval(refresh) } }; class Child extends Base {}; Child.start(); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "inherited static getter creates an interval",
    "class Base { static get timer() { return setInterval(refresh) } }; class Child extends Base {}; Child.timer; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "bound timeout callback fires",
    "const start = () => setInterval(refresh); const pending = setTimeout(start, 0); import.meta.hot.dispose(() => clearTimeout(pending))",
    true,
  ],
  [
    "returned declaration retains its parameter",
    "function make(handle) { function cleanup() { clearInterval(handle) } return cleanup }; const timer = setInterval(refresh); import.meta.hot.dispose(make(timer))",
    false,
  ],
  [
    "fulfilled empty Promise.all invokes reaction",
    "Promise.all([]).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "listener receives the actual event type",
    "const handler = event => { if (event.type !== 'click') setInterval(refresh) }; document.addEventListener('click', handler); import.meta.hot.dispose(() => document.removeEventListener('click', handler))",
    false,
  ],
  [
    "event listener object can create a timer",
    "const handler = { handleEvent() { setInterval(refresh) } }; document.addEventListener('click', handler); import.meta.hot.dispose(() => document.removeEventListener('click', handler))",
    true,
  ],
  [
    "listener callback respects registration path",
    "const enabled = flag; const handler = () => { if (!enabled) setInterval(refresh) }; if (enabled) document.addEventListener('click', handler); import.meta.hot.dispose(() => { if (enabled) document.removeEventListener('click', handler) })",
    false,
  ],
  [
    "shorter later timeout can replace handle before earlier cleanup",
    "let timer = setInterval(refresh); const slow = setTimeout(() => clearInterval(timer), 100); const fast = setTimeout(() => { timer = setInterval(refresh) }, 0); import.meta.hot.dispose(() => { clearTimeout(slow); clearTimeout(fast); clearInterval(timer) })",
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
    "getter callback resolves to cleanup",
    "const callbacks = { get cleanup() { return () => clearInterval(timer) } }; import.meta.hot.dispose(callbacks.cleanup)",
    false,
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
    "throwing instance field skips later resource creation",
    "const fail = () => { throw Error() }; class Worker { first = fail(); timer = setInterval(refresh) }; try { new Worker() } catch {} import.meta.hot.dispose(() => {})",
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
    "unreachable catch cannot undo completed cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { try { clearInterval(timer) } catch {} })",
    false,
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

for (const [name, source, leaks] of [
  [
    "exhaustive switch cleanup",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { switch (mode) { default: clearInterval(timer) } })",
    false,
  ],
  [
    "nullable listener capture",
    "window.addEventListener('resize', refresh, null); import.meta.hot.dispose(() => window.removeEventListener('resize', refresh))",
    false,
  ],
  [
    "empty spread callback",
    "[...[]].forEach(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "nonempty spread callback",
    "[...[1]].forEach(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "sparse spread callback",
    "[...[,]].forEach(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "async map returns promises",
    "const timers = [1].map(async () => setInterval(refresh)); import.meta.hot.dispose(() => timers.forEach(clearInterval))",
    true,
  ],
  [
    "labeled loop continuation",
    "const timer = setInterval(refresh); import.meta.hot.dispose(() => { outer: for (;;) { break outer }; clearInterval(timer) })",
    false,
  ],
  ...["||=", "&&=", "??="].map(
    (operator) =>
      [
        `unknown ${operator} cleanup`,
        `let timer = externalTimer; timer ${operator} setInterval(refresh); import.meta.hot.dispose(() => clearInterval(timer))`,
        false,
      ] as const,
  ),
  [
    "branch-local cleanup",
    "if (enabled) { const timer = setInterval(refresh); clearInterval(timer) }; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "class expression shadow",
    "const timer = setInterval(refresh); const C = class timer {}; import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  ...["0", "null", "''"].map(
    (value) =>
      [
        `false-like condition ${value}`,
        `if (${value}) setInterval(refresh); import.meta.hot.dispose(() => {})`,
        false,
      ] as const,
  ),
  [
    "returned callback alternatives",
    "const timer = setInterval(refresh); function make() { if (flag) return () => clearInterval(timer); return () => clearInterval(timer) }; import.meta.hot.dispose(make())",
    false,
  ],
  [
    "returned callback alternative leak",
    "const timer = setInterval(refresh); function make() { if (flag) return () => clearInterval(timer); return () => {} }; import.meta.hot.dispose(make())",
    true,
  ],
  [
    "repeated for test resources",
    "let timer; let i = 0; for (; (timer = setInterval(refresh), i++ < 2);) {}; import.meta.hot.dispose(() => clearInterval(timer))",
    true,
  ],
  [
    "repeated while test resources",
    "let timer; let i = 0; while ((timer = setInterval(refresh), i++ < 2)) {}; import.meta.hot.dispose(() => clearInterval(timer))",
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
    "destructuring invokes a resource-creating getter",
    "const source = { get timer() { return setInterval(refresh) } }; const { timer } = source; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "destructured getter handle can be cleaned",
    "const source = { get timer() { return setInterval(refresh) } }; const { timer } = source; import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "throwing destructured getter stops module evaluation",
    "const source = { get timer() { throw Error() } }; const { timer } = source; setInterval(refresh); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "static class getter creates a timer",
    "class Source { static get timer() { return setInterval(refresh) } }; Source.timer; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "static class getter handle can be cleaned",
    "class Source { static get timer() { return setInterval(refresh) } }; const timer = Source.timer; import.meta.hot.dispose(() => clearInterval(timer))",
    false,
  ],
  [
    "instance class getter creates a timer",
    "class Source { get timer() { return setInterval(refresh) } }; new Source().timer; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "listener can fire before disposal and create a timer",
    "const start = () => setInterval(refresh); addEventListener('click', start); import.meta.hot.dispose(() => removeEventListener('click', start))",
    true,
  ],
  [
    "dispose can clean a timer created by a listener",
    "let timer; const start = () => { timer = setInterval(refresh) }; addEventListener('click', start, { once: true }); import.meta.hot.dispose(() => { removeEventListener('click', start); clearInterval(timer) })",
    false,
  ],
  [
    "truthy once option only fires a listener once",
    "let timer; const start = () => { timer = setInterval(refresh) }; addEventListener('click', start, { once: 1 }); import.meta.hot.dispose(() => { removeEventListener('click', start); clearInterval(timer) })",
    false,
  ],
  [
    "falsey once option leaves a listener repeatable",
    "let timer; const start = () => { timer = setInterval(refresh) }; addEventListener('click', start, { once: 0 }); import.meta.hot.dispose(() => { removeEventListener('click', start); clearInterval(timer) })",
    true,
  ],
  [
    "repeatable listener overwrites an interval before disposal",
    "let timer; const start = () => { timer = setInterval(refresh) }; addEventListener('click', start); import.meta.hot.dispose(() => { removeEventListener('click', start); clearInterval(timer) })",
    true,
  ],
  [
    "repeatable listener cleans its previous interval",
    "let timer; const start = () => { if (timer) clearInterval(timer); timer = setInterval(refresh) }; addEventListener('click', start); import.meta.hot.dispose(() => { removeEventListener('click', start); clearInterval(timer) })",
    false,
  ],
  [
    "throwing object getter reaches catch-created timer",
    "const source = { get value() { throw Error() } }; try { source.value } catch { setInterval(refresh) }; import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "plain assignment does not read an accessor getter",
    "const owner = { get timer() { return setInterval(refresh) }, set timer(value) {} }; owner.timer = 0; import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "reaction adopts a rejected promise",
    "Promise.resolve().then(() => new Promise((resolve, reject) => reject(Error()))).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "first promise settlement wins over later rejection",
    "new Promise((resolve, reject) => { resolve(); reject(Error()) }).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "first promise rejection wins over later fulfillment",
    "new Promise((resolve, reject) => { reject(Error()); resolve() }).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "executor throw after resolution cannot trigger catch",
    "new Promise(resolve => { resolve(); throw Error() }).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "executor throw after both branches resolve cannot trigger catch",
    "new Promise(resolve => { if (flag) resolve(); else resolve(); throw Error() }).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "promise resolver adopts a rejected promise",
    "new Promise(resolve => resolve(Promise.reject(Error()))).catch(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    true,
  ],
  [
    "throwing finally prevents the fulfillment reaction",
    "Promise.resolve().finally(() => { throw Error() }).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "rejected finally promise prevents the fulfillment reaction",
    "Promise.resolve().finally(() => Promise.reject(Error())).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
    false,
  ],
  [
    "fulfilled finally promise preserves the fulfillment reaction",
    "Promise.resolve().finally(() => Promise.resolve()).then(() => setInterval(refresh)); import.meta.hot.dispose(() => {})",
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
  [
    "many listeners have bounded ordering exploration",
    `${Array.from({ length: 11 }, (_, index) => `const handler${index} = () => { ${index === 0 ? "setInterval(refresh)" : ""} }; document.addEventListener('event${index}', handler${index});`).join(" ")} import.meta.hot.dispose(() => { ${Array.from({ length: 11 }, (_, index) => `document.removeEventListener('event${index}', handler${index});`).join(" ")} })`,
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
