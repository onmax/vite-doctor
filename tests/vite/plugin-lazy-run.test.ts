import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, resolveConfig } from "vite";
import { expect, test, vi } from "vite-plus/test";
import { doctor } from "../../src/plugin.ts";

const loaded = vi.hoisted(() => ({ doctorRunPath: 0 }));

vi.mock("../../src/doctor.ts", async (importOriginal) => {
  loaded.doctorRunPath++;
  return importOriginal();
});

test("the Plugin Surface loads the Doctor Run path only when Doctor runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-plugin-lazy-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "entry.ts"), 'export const greeting = "hello";\n');
    const plugin = doctor({ rules: "vite/env/no-client-secret-pattern", cache: false });
    expect(loaded.doctorRunPath).toBe(0);

    const serve = await resolveConfig({ root, configFile: false, logLevel: "silent" }, "serve");
    (plugin.configResolved as (config: typeof serve) => void)(serve);
    await (plugin.buildStart as () => Promise<void>).call({});
    expect(loaded.doctorRunPath).toBe(0);

    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      build: { write: false, lib: { entry: join(root, "entry.ts"), formats: ["es"] } },
    });
    expect(loaded.doctorRunPath).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
