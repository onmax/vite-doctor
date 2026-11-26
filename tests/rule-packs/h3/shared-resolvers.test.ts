import { expect, test } from "vite-plus/test";
import type { RuleContext } from "../../../src/core/index.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  createRule,
  h3ExportName,
  h3ImportBindings,
  handlerEventParam,
  handlerFunctions,
  isDiscardedExpression,
  isH3AppReceiver,
  isH3Call,
  isH3HandlerFile,
  isHandlerEvent,
  sourceForNode,
  type AnyNode,
} from "../../../src/rule-packs/h3/rules/shared.ts";

interface Probe {
  handlerFile: boolean;
  named: Record<string, string>;
  namespaces: string[];
  calls: Record<string, string | null>;
  queryCalls: string[];
  receivers: Record<string, boolean>;
  handlers: { source: string; event?: string }[];
}

async function probe(
  text: string,
  options: { framework?: "vite" | "nitro"; file?: string } = {},
): Promise<Probe> {
  const file = options.file ?? "src/server.ts";
  let result: Probe | undefined;
  const rule = createRule({
    meta: {
      id: "test/h3-resolvers",
      title: "Probe h3 resolvers",
      category: "correctness",
      severity: "info",
      requires: { script: true },
    },
    create(ctx: RuleContext) {
      if (ctx.file.relativePath !== file) return;
      const bindings = h3ImportBindings(ctx);
      const probed: Probe = {
        handlerFile: isH3HandlerFile(ctx),
        named: Object.fromEntries(bindings.named),
        namespaces: [...bindings.namespaces],
        calls: {},
        queryCalls: [],
        receivers: {},
        handlers: [...handlerFunctions(ctx)]
          .sort(([a], [b]) => a - b)
          .map(([, handler]) => ({
            source: sourceForNode(handler.node, ctx.file.text),
            event: handler.event,
          })),
      };
      result = probed;
      return {
        CallExpression(node: AnyNode) {
          const callee = sourceForNode(node.callee, ctx.file.text);
          probed.calls[callee] = h3ExportName(ctx, node.callee);
          if (isH3Call(ctx, node, ["getQuery"])) probed.queryCalls.push(callee);
          if (node.callee.type === "MemberExpression")
            probed.receivers[sourceForNode(node.callee.object, ctx.file.text)] = isH3AppReceiver(
              ctx,
              node.callee.object,
            );
        },
      };
    },
  });
  const framework = options.framework ?? "vite";
  await runProjectFixture({
    framework,
    dependencies: framework === "vite" ? { h3: "^2.0.8" } : {},
    files: { [file]: text },
    rules: [rule],
  });
  if (!result) throw new Error(`The probe did not visit ${file}`);
  return result;
}

test("h3ImportBindings maps value imports and namespaces, skipping type-only imports", async () => {
  const result = await probe(`import { getHeader as gh, type H3Event, H3 } from "h3"
import type { EventHandler } from "h3"
import * as h3 from "nitro/h3"
import { readBody } from "h3/node"
import { tracingPlugin } from "h3/tracing"
`);
  expect(result.named).toEqual({ gh: "getHeader", H3: "H3", readBody: "readBody" });
  expect(result.namespaces).toEqual(["h3"]);
  expect(result.handlerFile).toBe(true);
});

test("a file with only type imports from h3 is not an h3 handler file", async () => {
  const result = await probe(`import type { H3Event } from "h3"
export const read = (event: H3Event) => getQuery(event)
`);
  expect(result.handlerFile).toBe(false);
  expect(result.calls.getQuery).toBeNull();
});

test("h3ExportName resolves named, aliased and namespace imports outside Nitro", async () => {
  const result = await probe(`import { getQuery, getHeader as gh } from "h3"
import * as h3 from "h3"
getQuery(event)
gh(event, "x")
h3.getQuery(event)
h3["readBody"](event)
getRouterParams(event)
other.getQuery(event)
`);
  expect(result.calls).toEqual({
    getQuery: "getQuery",
    gh: "getHeader",
    "h3.getQuery": "getQuery",
    'h3["readBody"]': "readBody",
    getRouterParams: null,
    "other.getQuery": null,
  });
  expect(result.queryCalls).toEqual(["getQuery", "h3.getQuery"]);
});

test("a locally declared name never resolves to h3", async () => {
  const result = await probe(`import { getQuery } from "h3"
function handle(event) {
  const getQuery = () => ({})
  return getQuery(event)
}
`);
  expect(result.calls.getQuery).toBeNull();
});

test("free identifiers resolve as auto-imports only in Nitro server files", async () => {
  const handler = `export default defineEventHandler((event) => {
  const getHeader = () => ""
  getHeader(event, "x")
  return getQuery(event)
})
`;
  const nitro = await probe(handler, { framework: "nitro", file: "server/api/items.ts" });
  expect(nitro.handlerFile).toBe(true);
  expect(nitro.calls).toMatchObject({
    defineEventHandler: "defineEventHandler",
    getQuery: "getQuery",
    getHeader: null,
  });
  expect(nitro.handlers).toEqual([expect.objectContaining({ event: "event" })]);

  const plain = await probe(`import { H3 } from "h3"\n${handler}`);
  expect(plain.calls).toMatchObject({ defineEventHandler: null, getQuery: null });
  expect(plain.handlers).toEqual([]);
});

test("isH3AppReceiver follows constructors, factories, chains and constant bindings", async () => {
  const result = await probe(`import { H3, createApp, createRouter } from "h3"
import * as h3 from "h3"
const app = new H3()
const router = createRouter()
const legacy = createApp()
let reassigned = new H3()
reassigned = other
const chained = new H3().get("/", () => "ok")
app.get("/a", () => "a")
router.post("/b", () => "b")
legacy.use(() => "c")
chained.use(() => "d")
new h3.H3().all("/e", () => "e")
reassigned.get("/f", () => "f")
express.get("/g", () => "g")
class H3Local {}
`);
  expect(result.receivers).toMatchObject({
    app: true,
    router: true,
    legacy: true,
    chained: true,
    "new H3()": true,
    "new h3.H3()": true,
    reassigned: false,
    express: false,
  });
});

test("handlerFunctions collects definer, app method and route default handlers", async () => {
  const result = await probe(`import { H3, defineHandler, defineEventHandler } from "h3"
function named(ev) { return ev.req.url }
const arrow = (e) => e.path
export const app = new H3()
  .get("/a", (event) => "a")
  .post("/b", named)
  .use(async (event, next) => next(), { match: (e) => true })
  .get("/c", defineHandler({ handler: ({ req }) => req.url }))
export const d = defineEventHandler(arrow)
const notAHandler = [1].map((x) => x)
`);
  expect(result.handlers.map((handler) => [handler.source, handler.event])).toEqual([
    ["function named(ev) { return ev.req.url }", "ev"],
    ["(e) => e.path", "e"],
    ['(event) => "a"', "event"],
    ["async (event, next) => next()", "event"],
    ["({ req }) => req.url", undefined],
  ]);
});

test("isH3AppReceiver follows this.app class fields and parameters typed H3", async () => {
  const result = await probe(`import { H3, createApp } from "h3"
import type { H3 as App } from "h3"
import * as h3 from "h3"
class Server {
  app = new H3()
  #api = new H3()
  legacy
  swapped = new H3()
  constructor(private injected: App) {
    this.legacy = createApp()
    this.swapped = express()
  }
  routes() {
    this.app.get("/a", (event) => "a")
    this.#api.post("/b", (event) => "b")
    this.legacy.use((event) => "c")
    this.injected.get("/d", (event) => "d")
    this.swapped.get("/e", (event) => "e")
    this.missing.get("/f", (event) => "f")
  }
}
export function register(app: H3, ns: h3.H3, other: Router) {
  app.get("/g", (event) => "g")
  ns.get("/h", (event) => "h")
  other.get("/i", (event) => "i")
}
`);
  expect(result.receivers).toMatchObject({
    "this.app": true,
    "this.#api": true,
    "this.legacy": true,
    "this.injected": true,
    "this.swapped": false,
    "this.missing": false,
    app: true,
    ns: true,
    other: false,
  });
  expect(result.handlers.map((handler) => handler.source)).toEqual([
    '(event) => "a"',
    '(event) => "b"',
    '(event) => "c"',
    '(event) => "d"',
    '(event) => "g"',
    '(event) => "h"',
  ]);
});

async function probeExpressions(text: string) {
  const file = "src/server.ts";
  const events: Record<string, boolean[]> = {};
  const params: Record<string, string | null> = {};
  const discarded: Record<string, boolean> = {};
  const rule = createRule({
    meta: {
      id: "test/h3-expressions",
      title: "Probe h3 expression helpers",
      category: "correctness",
      severity: "info",
      requires: { script: true },
    },
    create(ctx: RuleContext) {
      if (ctx.file.relativePath !== file) return;
      const line = (node: AnyNode) => ctx.file.text.slice(0, node.start).split("\n").length;
      return {
        Identifier(node: AnyNode) {
          const parent = node.__doctorParent;
          const declares = parent?.params?.includes(node) || parent?.id === node;
          if (declares || !/^(?:event|e|ev)$/.test(node.name)) return;
          (events[`${node.name}@${line(node)}`] ??= []).push(isHandlerEvent(ctx, node));
        },
        ArrowFunctionExpression(node: AnyNode) {
          params[sourceForNode(node, ctx.file.text).split(" =>")[0]!] =
            handlerEventParam(ctx, node)?.name ?? null;
        },
        CallExpression(node: AnyNode) {
          if (node.callee.type === "Identifier" && node.callee.name.startsWith("send"))
            discarded[`${node.callee.name}@${line(node)}`] = isDiscardedExpression(node);
        },
      };
    },
  });
  await runProjectFixture({
    framework: "vite",
    dependencies: { h3: "^2.0.8" },
    files: { [file]: text },
    rules: [rule],
  });
  return { events, params, discarded };
}

test("isHandlerEvent and handlerEventParam resolve the handler's event binding, not its name", async () => {
  const result = await probeExpressions(`import { H3 } from "h3"
export const app = new H3()
  .get("/a", (event: H3Event) => event.path)
  .get("/b", (e) => {
    const event = other
    return [e, event]
  })
  .get("/c", ({ req }) => req)
  .get("/d", (ev) => list.map((event) => [ev, event]))
const helper = (event) => event
`);
  expect(result.events).toEqual({
    "event@3": [true],
    "e@6": [true],
    "event@6": [false],
    "ev@9": [true],
    "event@9": [false],
    "event@10": [false],
  });
  expect(result.params).toEqual({
    "(event: H3Event)": "event",
    "(event)": null,
    "(e)": "e",
    "({ req })": null,
    "(ev)": "ev",
  });
});

test("isDiscardedExpression finds values that are dropped", async () => {
  const result = await probeExpressions(`async function run(ok) {
  sendA()
  await sendB()
  void sendC()
  ok && sendD()
  ok ? sendE() : sendF()
  sendG(), other()
  const value = sendH()
  if (sendI()) {}
  use(sendJ())
  return sendK()
}
const arrow = () => sendL()
`);
  expect(result.discarded).toEqual({
    "sendA@2": true,
    "sendB@3": true,
    "sendC@4": true,
    "sendD@5": true,
    "sendE@6": true,
    "sendF@6": true,
    "sendG@7": true,
    "sendH@8": false,
    "sendI@9": false,
    "sendJ@10": false,
    "sendK@11": false,
    "sendL@13": false,
  });
});
