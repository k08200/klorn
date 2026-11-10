// Test worker: a well-behaved extraction that takes 200 ms
// (attachment-extract-isolated).
import { parentPort } from "node:worker_threads";

setTimeout(() => parentPort?.postMessage({ text: "done", status: "readable" }), 200);
