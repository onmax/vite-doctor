import { describe, expect, test } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import { detectFramework } from "./detectFramework.js";
import { createBoundedLogBuffer } from "./logBuffer.js";
import { parseGhUrl } from "./parseGhUrl.js";
import { fixtureToTree, mergeRuntimeTree } from "./wcTree.js";

describe("parseGhUrl", () => {
  test("parses shorthand repos and hash refs", () => {
    expect(parseGhUrl("nuxt/starter")).toEqual({ owner: "nuxt", repo: "starter", ref: "HEAD" });
    expect(parseGhUrl("nuxt/starter#feature/demo")).toEqual({
      owner: "nuxt",
      repo: "starter",
      ref: "feature/demo",
    });
  });

  test("parses GitHub tree URLs", () => {
    expect(parseGhUrl("https://github.com/nuxt/starter/tree/v4?tab=readme")).toEqual({
      owner: "nuxt",
      repo: "starter",
      ref: "v4",
    });
  });
});

describe("detectFramework", () => {
  test("detects Nuxt dependencies", () => {
    expect(
      detectFramework(JSON.stringify({ dependencies: { nuxt: "^4.0.0", vue: "^3.5.0" } })),
    ).toBe("nuxt");
  });

  test("falls back to Vue for non-Nuxt and malformed package files", () => {
    expect(detectFramework(JSON.stringify({ dependencies: { vue: "^3.5.0" } }))).toBe("vue");
    expect(detectFramework("{")).toBe("vue");
  });
});

describe("WebContainer scan tree", () => {
  test("preserves target package.json while adding doctor runtime files", () => {
    const target = fixtureToTree({
      "/package.json": { contents: '{"dependencies":{"nuxt":"^4.0.0"}}' },
      "/app/pages/index.vue": { contents: "<template />" },
    });
    const runtime = fixtureToTree({
      "/package.json": { contents: '{"name":"doctor-demo"}' },
      "/node_modules/nuxt-doctor/package.json": { contents: '{"name":"nuxt-doctor"}' },
      "/node_modules/nuxt-doctor/bin.mjs": { contents: "console.log('scan')" },
    });

    const merged = mergeRuntimeTree(target, runtime);
    expect(readText(merged, "package.json")).toBe('{"dependencies":{"nuxt":"^4.0.0"}}');
    expect(readText(merged, "node_modules/nuxt-doctor/package.json")).toBe(
      '{"name":"nuxt-doctor"}',
    );
    expect(readText(merged, "app/pages/index.vue")).toBe("<template />");
  });
});

describe("terminal log buffering", () => {
  test("replays writes received before the terminal is mounted", () => {
    const buffer = createBoundedLogBuffer(12);

    buffer.append("booting\n");
    buffer.append("mounting\n");

    expect(buffer.read()).toBe("ng\nmounting\n");
    buffer.clear();
    expect(buffer.read()).toBe("");
  });
});

function readText(tree: FileSystemTree, path: string) {
  const parts = path.split("/");
  let node = tree;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const child = node[parts[i]!] as { directory?: FileSystemTree } | undefined;
    if (!child || !("directory" in child)) return null;
    node = child.directory;
  }
  const file = node[parts[parts.length - 1]!] as
    | { file?: { contents?: string | Uint8Array } }
    | undefined;
  return file?.file && typeof file.file.contents === "string" ? file.file.contents : null;
}
