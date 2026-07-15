/**
 * @klorn/contract — the API wire contract, shared by the server
 * (packages/api) and its clients (packages/web, and eventually the native
 * apps' codegen). Types only: this package ships no runtime code and has no
 * build step (`exports` points straight at the .ts source), so consumers
 * MUST use `import type` — a value import would fail at runtime.
 *
 * Why it exists: clients used to hand-mirror server response types with
 * "keep in sync" comments. A drifting mirror compiles fine and breaks at
 * runtime; a shared type makes the compiler catch server/client contract
 * drift in the same commit that introduces it.
 */

export type * from "./firewall.js";
export type * from "./inbox-summary.js";
export type * from "./receipt.js";
