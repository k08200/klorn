/**
 * Wire contract for `/api/keys` — machine credentials for the MCP endpoint.
 * The raw key appears exactly once, in the creation response; the list
 * carries display metadata only, never hashes.
 */

/** What a key may do over MCP. New keys and every pre-existing key are `read`. */
export type ApiKeyPermissionWire = "read" | "read_write";

export interface ApiKeyWire {
  id: string;
  name: string;
  /** Display stub of the raw key: "klorn_sk_ab12cd". */
  prefix: string;
  permission: ApiKeyPermissionWire;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

/** `GET /api/keys` */
export interface ApiKeysListResponse {
  keys: ApiKeyWire[];
  /**
   * Present, and `true`, only while the server's MCP write flag is on: clients
   * show the read-write choice and each key's agent activity only then. While
   * the flag is off the field is absent and the body is exactly `{ keys }`.
   */
  writeToolsAvailable?: true;
}

/** How one audited write call ended. `attempted` means the outcome is unknown. */
export type ApiKeyActivityOutcomeWire = "attempted" | "ok" | "refused" | "error";

/**
 * One audited write-tool call made through a key. Deliberately narrow: no
 * argument hash and no row identifiers ever cross the wire.
 */
export interface ApiKeyActivityWire {
  /** The MCP tool the agent called, e.g. "mark_read". */
  tool: string;
  outcome: ApiKeyActivityOutcomeWire;
  /**
   * Short code, null on success. Known codes: permission_denied, rate_limited,
   * tool_error, exception. A client must tolerate a code it does not know.
   */
  reason: string | null;
  /** Opaque message id the call named; null when it named none. */
  targetId: string | null;
  createdAt: string;
}

/**
 * `GET /api/keys/:id/activity` — newest first, at most 50 rows. Answers 404
 * `{ error }` for an unknown or foreign key id, and exactly like an unregistered
 * route while the server's MCP write flag is off.
 */
export interface ApiKeyActivityResponse {
  activity: ApiKeyActivityWire[];
}

/** `POST /api/keys` */
export interface CreateApiKeyRequest {
  name: string;
  /**
   * Omitted means `read`. Honoured only while the server's MCP write flag is
   * on, and then any value other than `read` / `read_write` is a 400 with code
   * `INVALID_API_KEY_PERMISSION`. While the flag is off the field is ignored and
   * the key is `read`; the response says which permission was granted.
   */
  permission?: ApiKeyPermissionWire;
}
export interface CreateApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  /** The permission granted — `read` unless a read-write key was requested and allowed. */
  permission: ApiKeyPermissionWire;
  /** The raw key — shown once, never retrievable again. */
  key: string;
}
