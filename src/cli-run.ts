import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CliSurfaceOptions } from "./cli-main.js";
import { viteDoctorVersion } from "./version.js";

export async function main(
  args = process.argv.slice(2),
  cwd = process.cwd(),
  surface: CliSurfaceOptions = {},
): Promise<number> {
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${viteDoctorVersion}\n`);
    return 0;
  }
  const cli = await import("./cli-main.js");
  return cli.main(args, cwd, surface);
}

/** The `vite-doctor` binary: a Doctor Run goes through the long-lived Doctor process when opted in. */
export async function runCli(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  if (args.includes("--server") || process.env.VITE_DOCTOR_SERVER) {
    const client = await import("./doctor-process/client.js");
    if (client.doctorProcessRequested(args)) {
      const entry = new URL("./doctor-process.mjs", import.meta.url);
      const exitCode = await client.runThroughDoctorProcess(args, cwd, {
        entry: existsSync(fileURLToPath(entry)) ? entry : undefined,
      });
      if (exitCode !== undefined) return exitCode;
    }
  }
  return main(args, cwd);
}
