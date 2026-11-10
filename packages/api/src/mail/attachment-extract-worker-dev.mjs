// Runs attachment-extract-worker.ts from source (the tsx dev server, vitest).
// A worker thread does not inherit its parent's TypeScript loader, so it
// registers tsx itself. Production never loads this file: it runs the compiled
// attachment-extract-worker.js next to attachment-extract-isolated.js.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
await import(workerData.entry);
