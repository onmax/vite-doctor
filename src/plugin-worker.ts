import { parentPort, workerData } from "node:worker_threads";
import { runSurfaceDoctor, type SurfaceRunInput } from "./plugin-run.js";

try {
  const outcome = await runSurfaceDoctor(workerData as SurfaceRunInput, []);
  parentPort!.postMessage({ outcome });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
