/**
 * Build-time configuration. The API base is resolved once:
 *
 *   VITE_KLORN_API_URL (build env) → dev default http://localhost:3001 → prod.
 */
import { DEV_API_BASE, PROD_API_BASE, validateApiBase } from "./config-shared";

export { DEV_API_BASE, NATIVE_OAUTH_SCHEME, PROD_API_BASE, validateApiBase } from "./config-shared";

export function resolveApiBase(raw: string | undefined, isDev: boolean): string {
  return validateApiBase(raw) ?? (isDev ? DEV_API_BASE : PROD_API_BASE);
}

export const API_BASE = resolveApiBase(import.meta.env.VITE_KLORN_API_URL, import.meta.env.DEV);

/** `vite --mode mock`: the API is the in-app fetch shim (src/api/mock). */
export const MOCK_API = import.meta.env.VITE_KLORN_MOCK === "1";

export const APP_VERSION = "1.0.0";
