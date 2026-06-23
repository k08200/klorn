/**
 * Preload — the shell's bridge into the renderer. Runs sandboxed.
 *
 * Exposes a minimal, read-only `window.klorn`. The notable member is
 * `getOntology()`: the desktop is the first non-API consumer of the shared
 * deterministic core's read surface (api → /api/admin/ontology, backed by
 * ontology.ts:describePolicy). This is the concrete seam through which the
 * command center reads the same brain the firewall classifies on.
 *
 * Because the preload is sandboxed, process.env is unavailable — the API base
 * arrives from the main process via additionalArguments (see main.ts).
 */

import { contextBridge } from "electron";

const API_ARG_PREFIX = "--klorn-api-url=";
const apiBase =
  process.argv.find((arg) => arg.startsWith(API_ARG_PREFIX))?.slice(API_ARG_PREFIX.length) ??
  "http://localhost:3001";

const klorn = {
  /**
   * Fetch the shared ontology snapshot — the tier rule, sender priors, keyword
   * patterns, and model dial the classifier currently runs on. Read-only.
   *
   * @throws if the request is non-2xx or the body is not valid JSON. Callers
   * MUST handle the rejection (try/await/catch); an unhandled rejection in the
   * renderer will surface as an uncaught error.
   */
  getOntology: async (): Promise<unknown> => {
    const res = await fetch(`${apiBase}/api/admin/ontology`, {
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`ontology fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },
} as const;

export type KlornBridge = typeof klorn;

contextBridge.exposeInMainWorld("klorn", klorn);
