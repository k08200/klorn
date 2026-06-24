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

import { contextBridge, ipcRenderer } from "electron";
import { KLORN_AUTH_TOKEN_KEY } from "./constants.js";

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
    // /api/admin/ontology is requireAdmin and reads only the Authorization
    // header — there is no cookie session, so forward the web app's JWT as
    // Bearer. Read at call time (the token appears only after login). A missing
    // token sends an unauthenticated request, which surfaces a clear 401.
    const headers: Record<string, string> = {};
    let token: string | null = null;
    try {
      token = window.localStorage.getItem(KLORN_AUTH_TOKEN_KEY);
    } catch {
      // localStorage unavailable in this context — fall through to a 401.
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${apiBase}/api/admin/ontology`, { headers });
    if (!res.ok) {
      throw new Error(`ontology fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  /**
   * Start native Google sign-in. Opens the system browser for consent; on
   * completion the main process signs this window in and reloads it. One consent
   * also grants Gmail/Calendar, so the account lands already connected.
   *
   * Fire-and-forget: resolves once the flow has been kicked off — the window
   * reload, not this promise, signals success.
   */
  signInWithGoogle: (): Promise<void> => ipcRenderer.invoke("klorn:google-login"),
} as const;

export type KlornBridge = typeof klorn;

contextBridge.exposeInMainWorld("klorn", klorn);
