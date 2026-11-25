import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { checkMcpToolList } from "../../src/mcp/index.ts";

const fixtures = { nuxt: "nuxt", deepwiki: "deepwiki", context7: "context7" };

for (const [fixture, serverName] of Object.entries(fixtures)) {
  test(`findings on the ${fixture} tools/list`, () => {
    const list: unknown = JSON.parse(
      readFileSync(new URL(`../fixtures/mcp/${fixture}.json`, import.meta.url), "utf8"),
    );
    const findings = checkMcpToolList(list, { serverName }).map(
      ({ client, rule, severity, confidence, tool, pointer, message, measured }) => ({
        client,
        rule,
        severity,
        confidence,
        tool,
        pointer,
        message,
        measured,
      }),
    );
    expect(findings).toMatchSnapshot();
  });
}
