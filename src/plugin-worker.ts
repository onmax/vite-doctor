import { parentPort, workerData } from "node:worker_threads";
import {
  runSurfaceDoctor,
  type SurfaceRunInput,
  type SurfaceWorkerMessage,
  type SurfaceWorkerResolution,
} from "./plugin-run.js";

const port = parentPort!;
const pending = new Map<number, ReturnType<typeof Promise.withResolvers<string | undefined>>>();
let nextRequest = 0;
const send = (message: SurfaceWorkerMessage) => port.postMessage(message);
port.on("message", (reply: SurfaceWorkerResolution) => {
  const waiting = pending.get(reply.request);
  pending.delete(reply.request);
  if ("error" in reply) waiting?.reject(new Error(reply.error));
  else waiting?.resolve(reply.id);
});

try {
  const outcome = await runSurfaceDoctor(workerData as SurfaceRunInput, [], (source, importer) => {
    const request = nextRequest++;
    const waiting = Promise.withResolvers<string | undefined>();
    pending.set(request, waiting);
    send({ request, source, importer });
    return waiting.promise;
  });
  send({ outcome });
} catch (error) {
  send({ error: error instanceof Error ? error.message : String(error) });
} finally {
  port.close();
}
