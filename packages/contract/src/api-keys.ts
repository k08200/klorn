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
}

/** `POST /api/keys` */
export interface CreateApiKeyRequest {
  name: string;
  /**
   * Omitted means `read`. `read_write` is refused (403, code
   * `API_KEY_WRITE_DISABLED`) while the server's write flag is off; any other
   * value is a 400 (code `INVALID_API_KEY_PERMISSION`).
   */
  permission?: ApiKeyPermissionWire;
}
export interface CreateApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  /** The raw key — shown once, never retrievable again. */
  key: string;
}
