import { enableCompileCache } from "node:module";

// Every isolated test file re-imports the TypeScript and ESLint stack; reuse V8 bytecode across workers.
enableCompileCache();
