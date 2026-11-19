import module from "node:module";
import { afterEach, expect, test, vi } from "vite-plus/test";

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

// npm symlinks, cmd shims, and Windows drive-letter case can all hide which file Node started.
test("the vite-doctor bin runs Doctor when argv[1] does not resolve to the bin", async () => {
  const cache = vi.spyOn(module, "enableCompileCache").mockReturnValue({ status: 1 });
  cli.loaded.mockImplementation(() => expect(cache).toHaveBeenCalledOnce());
  cli.main.mockResolvedValue(1);
  process.argv = [process.execPath, "c:\\missing\\node_modules\\.bin\\vite-doctor", "--invalid"];
  await import("../../src/bin.ts");
  expect(cli.main).toHaveBeenCalledWith(["--invalid"], process.cwd(), {});
  expect(process.exitCode).toBe(1);
});
