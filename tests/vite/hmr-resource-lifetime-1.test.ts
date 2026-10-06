import { afterAll, expect, test } from "vite-plus/test";
import { createProjectFixture } from "../../src/core/testkit.ts";
import { requireDisposeForSideEffects } from "../../src/rule-packs/vite/rules/plugin-hmr.ts";

const viteProject = createProjectFixture({ framework: "vite" });
afterAll(() => viteProject.dispose());

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
    const result = await viteProject.run({
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
    });
    expect(
      result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
    ).toBe(leaks);
  });
}

// These cases run the Rule up to its iteration and ordering bounds, so they take ~1s idle and several
// seconds on a loaded machine; the timeout absorbs that load, the assertions check the bound semantics.
for (const [name, source, leaks] of [
  [
    "Set iteration skips only harmless added members at its bound",
    `const sentinel = {}; const timer = setInterval(refresh); const values = new Set([timer, ${Array.from({ length: 2047 }, () => "{}").join(", ")}]); import.meta.hot.dispose(() => values.forEach(value => { clearInterval(value); values.add(sentinel) }))`,
    false,
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
    "unexplored listener order can create a resource",
    `let order = 0; ${Array.from({ length: 7 }, (_, index) => `const handler${index} = () => { if (order === ${6 - index}) order++; if (order === 7) setInterval(refresh) }; document.addEventListener('event${index}', handler${index}, { once: true });`).join(" ")} import.meta.hot.dispose(() => { ${Array.from({ length: 7 }, (_, index) => `document.removeEventListener('event${index}', handler${index});`).join(" ")} })`,
    true,
  ],
] as const) {
  test(
    name,
    async () => {
      const result = await viteProject.run({
        rule: requireDisposeForSideEffects,
        files: { "src/main.ts": `${source}\nimport.meta.hot.accept()` },
      });
      expect(
        result.diagnostics.some((item) => item.ruleId === requireDisposeForSideEffects.meta.id),
      ).toBe(leaks);
    },
    30_000,
  );
}

test("an unrelated dispose callback does not hide a leaked interval", async () => {
  const result = await viteProject.run({
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
  const result = await viteProject.run({
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
  const result = await viteProject.run({
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
        const result = await viteProject.run({
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
    const result = await viteProject.run({
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
  const result = await viteProject.run({
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
    const result = await viteProject.run({
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
      const result = await viteProject.run({
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
    const result = await viteProject.run({
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
    const result = await viteProject.run({
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
      const result = await viteProject.run({
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
    const result = await viteProject.run({
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
    const result = await viteProject.run({
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
    const result = await viteProject.run({
      rule: requireDisposeForSideEffects,
      files: { "src/main.ts": `function refresh() {}; import.meta.hot.accept(); ${source}` },
    });
    expect(result.diagnostics.length > 0).toBe(leaks);
  });
}
