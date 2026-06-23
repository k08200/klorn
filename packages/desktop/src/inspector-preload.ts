/**
 * Brain Inspector preload (runs sandboxed in the inspector window).
 *
 * The inspector is a local page with no access to the web app's localStorage,
 * so it cannot read the JWT itself. Instead it asks the main process, which
 * holds the token (read from the main app window) and performs the authenticated
 * /api/admin/ontology fetch. The token never enters this renderer — only the
 * non-sensitive ontology snapshot crosses back.
 */

import { contextBridge, ipcRenderer } from "electron";

const klornInspector = {
  /**
   * Request the ontology snapshot. Resolves to a discriminated result instead
   * of throwing so the renderer can show a 401/offline message inline.
   */
  getOntology: (): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke("klorn:ontology"),
} as const;

export type KlornInspectorBridge = typeof klornInspector;

contextBridge.exposeInMainWorld("klornInspector", klornInspector);
