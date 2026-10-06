import module from "node:module";

module.enableCompileCache();
const { parseServerOptions, serveDoctorProcess } = await import("./doctor-process/server.js");
const server = await serveDoctorProcess(parseServerOptions(process.argv[2]));
if (server) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void server.stop());
  }
  await server.closed;
}
process.exit(0);
