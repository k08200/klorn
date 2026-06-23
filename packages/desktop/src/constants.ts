/**
 * Side-effect-free shared constants. Kept separate from config.ts (which reads
 * process.env at import) so the sandboxed preload — where process.env is
 * unavailable — can import these without running env logic.
 */

/**
 * localStorage key the Klorn web app stores its JWT under (see
 * web/src/lib/api.ts: AUTH_TOKEN_KEY). The API authenticates with an
 * `Authorization: Bearer` header — there is no cookie session — so the shell
 * reads this token and forwards it as Bearer to reach requireAuth/Admin routes
 * like /api/admin/ontology.
 */
export const KLORN_AUTH_TOKEN_KEY = "klorn-token";
