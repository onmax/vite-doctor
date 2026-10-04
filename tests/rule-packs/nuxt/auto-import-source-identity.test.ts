import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { expect, test } from "vite-plus/test";
import { defineDoctorExtension, defineRulePack, runDoctor } from "../../../src/core/index.ts";
import { noExplicitAutoImport } from "../../../src/rule-packs/nuxt/rules/nuxt/no-explicit-auto-import.ts";

const cases = [
  {
    name: "distinct file and directory index",
    source: "~/lib/value.ts",
    automatic: "app/lib/value/index.ts",
    files: ["app/lib/value.ts", "app/lib/value/index.ts"],
    expected: false,
  },
  {
    name: "distinct JavaScript and TypeScript files",
    source: "~/lib/value.js",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.js", "app/lib/value.ts"],
    expected: false,
  },
  {
    name: "ambiguous extensionless file and directory",
    source: "~/lib/value",
    automatic: "app/lib/value/index.ts",
    files: ["app/lib/value.ts", "app/lib/value/index.ts"],
    expected: false,
  },
  {
    name: "ambiguous extensionless JavaScript and TypeScript",
    source: "~/lib/value",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.js", "app/lib/value.ts"],
    expected: false,
  },
  {
    name: "unresolved extensionless source",
    source: "~/lib/value",
    automatic: "app/lib/value.ts",
    files: [],
    expected: false,
  },
  {
    name: "explicit missing JavaScript source",
    source: "~/lib/value.js",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.ts"],
    expected: false,
  },
  {
    name: "package entry overrides directory index",
    source: "~/lib/value",
    automatic: "app/lib/value/index.ts",
    files: ["app/lib/value/index.ts", "app/lib/value/entry.ts"],
    packageEntry: true,
    expected: false,
  },
  {
    name: "custom alias retains file identity",
    source: "#lib/value.ts",
    automatic: "app/lib/value/index.ts",
    files: ["app/lib/value.ts", "app/lib/value/index.ts"],
    expected: false,
  },
  {
    name: "exact extension source",
    source: "~/lib/value.ts",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.ts"],
    expected: true,
  },
  {
    name: "unique extensionless file",
    source: "~/lib/value",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.ts"],
    expected: true,
  },
  {
    name: "unique directory index",
    source: "~/lib/value",
    automatic: "app/lib/value/index.ts",
    files: ["app/lib/value/index.ts"],
    expected: true,
  },
  {
    name: "explicit index module",
    source: "~/lib/value/index",
    automatic: "app/lib/value/index.ts",
    files: ["app/lib/value.ts", "app/lib/value/index.ts"],
    expected: true,
  },
  {
    name: "relative source",
    source: "../lib/value",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.ts"],
    expected: true,
  },
  {
    name: "root alias",
    source: "~~/app/lib/value",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.ts"],
    expected: true,
  },
  {
    name: "custom alias",
    source: "#lib/value",
    automatic: "app/lib/value.ts",
    files: ["app/lib/value.ts"],
    expected: true,
  },
  {
    name: "identical package specifier",
    source: "fixture-package",
    automatic: "fixture-package",
    files: [],
    expected: true,
  },
];

test.each(cases)(
  "auto-import source identity: $name",
  async ({ source, automatic, files, packageEntry, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "doctor-auto-import-identity-"));
    try {
      const fixture: Record<string, string> = {
        "package.json": JSON.stringify({ type: "module", dependencies: { nuxt: "4.5.1" } }),
        "app/pages/index.vue": `<script setup lang="ts">import { getValue } from '${source}'\nconst value = getValue()</script><template>{{ value }}</template>`,
        ...Object.fromEntries(
          files.map((file) => [file, "export function getValue() { return 'value' }"]),
        ),
        ...(packageEntry
          ? { "app/lib/value/package.json": JSON.stringify({ main: "./entry.ts" }) }
          : {}),
        ".nuxt/doctor.manifest.json": JSON.stringify({
          nuxtVersion: "4.5.1",
          vueVersion: "3.5",
          rootDir: root,
          srcDir: join(root, "app"),
          appDir: join(root, "app"),
          buildDir: join(root, ".nuxt"),
          generatedAt: new Date().toISOString(),
          autoImportEnabled: true,
          autoImports: [
            {
              name: "getValue",
              as: "getValue",
              from: automatic.startsWith("app/") ? join(root, automatic) : automatic,
            },
          ],
          components: [],
          layers: [{ root, priority: 0 }],
          aliases: { "#lib": join(root, "app/lib") },
          routeRules: {},
          serverHandlers: [],
          modules: [],
          moduleSources: [],
        }),
      };
      for (const [name, content] of Object.entries(fixture)) {
        const path = join(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
      const result = await runDoctor({
        root,
        framework: "nuxt",
        runtimeTarget: { nuxt: "4.5.1" },
        extensions: [
          defineDoctorExtension({
            name: "fixture",
            rulePacks: [
              defineRulePack({
                name: "fixture",
                version: "0.0.0",
                rules: [noExplicitAutoImport],
                presets: { recommended: [noExplicitAutoImport.meta.id] },
              }),
            ],
          }),
        ],
      });
      const diagnostics = result.diagnostics.filter(
        (item) => item.ruleId === noExplicitAutoImport.meta.id,
      );
      expect(diagnostics).toHaveLength(expected ? 1 : 0);
      if (expected)
        expect(diagnostics[0]?.fix).toMatchObject({ kind: "safe", edits: [{ text: "" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
