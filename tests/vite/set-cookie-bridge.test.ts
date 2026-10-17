import { describe, expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../src/core/testkit.ts";
import { noLossySetCookieBridge, viteRulePack } from "../../src/rules.ts";
import { diagnosticsCollectionSource, getDiagnosticDocuments } from "../../docs/rules/source.ts";

function run(source: string) {
  return runProjectFixture({
    framework: "vite",
    rules: [noLossySetCookieBridge],
    files: { "src/vite/dev-endpoint.ts": source },
  });
}

describe("vite/plugin/no-lossy-set-cookie-bridge", () => {
  test.each([
    [
      "for...of over response.headers",
      `import type { ServerResponse } from "node:http"

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
  res.end()
}`,
    ],
    [
      "forEach over response.headers",
      `async function writeWebResponse(res, response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (!response.body) return res.end()
  res.end()
}`,
    ],
    [
      "for...of over headers.entries() with a block body",
      `export function copy(target: ServerResponse, upstream: Response) {
  for (const [key, value] of upstream.headers.entries()) {
    target.setHeader(key, value)
  }
}`,
    ],
  ])("reports %s", async (_label, source) => {
    const result = await run(source);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "VITE0025",
      ruleId: "vite/plugin/no-lossy-set-cookie-bridge",
      severity: "warn",
    });
    expect(result.diagnostics[0]?.message ?? result.diagnostics[0]?.why).toBeTruthy();
  });

  test("reports the setHeader call line", async () => {
    const result = await run(`async function writeResponse(res, response) {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
}`);
    expect(result.diagnostics[0]?.range).toMatchObject({ line: 3, column: 49 });
  });

  test.each([
    [
      "getSetCookie with appendHeader",
      `async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  const setCookieHeaders = response.headers.getSetCookie()
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookieHeaders.length > 0) return
    target.appendHeader(key, value)
  })
  for (const value of setCookieHeaders) target.appendHeader("set-cookie", value)
}`,
    ],
    [
      "a loop that skips set-cookie",
      `export async function writeWebResponse(res, response) {
  res.statusCode = response.status
  const cookies = response.headers.getSetCookie()
  if (cookies.length) res.setHeader("set-cookie", cookies)
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value)
  })
}`,
    ],
    [
      "Set-Cookie restored after the loop",
      `function copy(res, response) {
  for (const [name, value] of response.headers) res.setHeader(name, value)
  res.setHeader("Set-Cookie", response.headers.getSetCookie())
}`,
    ],
    [
      "appendHeader in the loop",
      `function copy(res, response) {
  for (const [name, value] of response.headers) res.appendHeader(name, value)
}`,
    ],
    [
      "plain header objects",
      `function setConsoleResponseHeaders(event) {
  const headers = { "cache-control": "no-store" }
  for (const [name, value] of Object.entries(headers)) event.node?.res?.setHeader(name, value)
}`,
    ],
    [
      "fixed header names in the loop",
      `function copy(res, response) {
  for (const [name] of response.headers) res.setHeader("x-seen", name)
}`,
    ],
    [
      "copying onto Fetch Headers",
      `function copy(request, response) {
  response.headers.forEach((value, key) => request.headers.set(key, value))
}`,
    ],
  ])("accepts %s", async (_label, source) => {
    const result = await run(source);
    expect(result.diagnostics).toEqual([]);
  });

  test("is Recommended and documents VITE0025", async () => {
    expect(viteRulePack.presets?.recommended).toContain(noLossySetCookieBridge.meta.id);
    expect(getDiagnosticDocuments()).toContainEqual(
      expect.objectContaining({
        code: "VITE0025",
        ruleId: noLossySetCookieBridge.meta.id,
        path: "/diagnostics/VITE0025",
      }),
    );
    const page = await diagnosticsCollectionSource.getItem("diagnostics/VITE0025.md");
    expect(page).toContain("getSetCookie");
  });
});
