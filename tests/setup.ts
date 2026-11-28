import { enableCompileCache } from "node:module";
import { agentMarkers } from "./report-reader-env.ts";

// Every isolated test file re-imports the TypeScript and ESLint stack; reuse V8 bytecode across workers.
enableCompileCache();

// Doctor picks the agent report when an agent runs it, so a suite started by one would see a
// different report than CI. Tests that need an agent set its marker themselves.
for (const name of agentMarkers) delete process.env[name];
