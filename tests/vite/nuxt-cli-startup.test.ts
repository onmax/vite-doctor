import module from "node:module";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { viteDoctorVersion } from "../../src/version.ts";

const cli = vi.hoisted(() => ({ main: vi.fn(), loaded: vi.fn() }));
vi.mock("../../src/cli-main.js", () => {
  cli.loaded();
  return { main: cli.main };
});

const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});

test.each(["--version", "-v"])(
  "Nuxt shim handles %s without loading CLI execution",
  async (flag) => {
    const cache = vi.spyOn(module, "enableCompileCache").mockReturnValue({ status: 1 });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = [process.execPath, "nuxt-doctor", flag];
    await import("../../src/nuxt-cli.ts");
    expect(output).toHaveBeenCalledWith(`${viteDoctorVersion}\n`);
    expect(process.exitCode).toBe(0);
    expect(cli.loaded).not.toHaveBeenCalled();
    expect(cache).toHaveBeenCalledOnce();
  },
);

test("Nuxt shim enables the cache before loading CLI execution and preserves host options and exit codes", async () => {
  const cache = vi.spyOn(module, "enableCompileCache").mockReturnValue({ status: 1 });
  cli.loaded.mockImplementation(() => expect(cache).toHaveBeenCalledOnce());
  cli.main.mockResolvedValue(2);
  process.argv = [process.execPath, "nuxt-doctor", "--invalid"];
  await import("../../src/nuxt-cli.ts");
  expect(cli.loaded).toHaveBeenCalledOnce();
  expect(cli.main).toHaveBeenCalledWith(["--invalid"], process.cwd(), { hostExtensions: true });
  expect(process.exitCode).toBe(2);
});
