import crypto from "node:crypto";

/**
 * Token encryption at rest (AES-256-GCM) with key rotation.
 *
 * Two envelope formats coexist:
 *   v1:<iv>:<ct>:<tag>            — single legacy key (TOKEN_ENCRYPTION_KEY)
 *   v2:<keyId>:<iv>:<ct>:<tag>    — keyring key selected by id
 *
 * Rotation without a keyring was impossible: the key was a single static env
 * var, so a suspected leak meant every stored token became undecryptable at
 * once rather than being re-encryptable under a new key. The keyring keeps
 * old keys available for reads while new writes use the active key; a sweep
 * (scripts/reencrypt-tokens.ts) migrates rows to the active key so an old key
 * can then be retired.
 *
 * Backward compatible by construction: a deploy with only TOKEN_ENCRYPTION_KEY
 * behaves exactly as before (writes v1, reads v1). Adding a keyring flips new
 * writes to v2 while v1 rows keep decrypting via the retained legacy key.
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const V1 = "v1";
const V2 = "v2";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function decodeKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${label} must decode to exactly ${KEY_BYTES} bytes (base64-encoded)`);
  }
  return key;
}

interface Keyring {
  keys: Map<string, Buffer>;
  activeKeyId: string | null; // null => legacy-only mode, encrypt as v1
  legacyKey: Buffer | null; // TOKEN_ENCRYPTION_KEY, for reading v1 rows
}

/**
 * Build the keyring once at module load. Fails fast (throws at import) on a
 * misconfigured deploy — a half-set keyring must never silently fall back to
 * a weaker mode.
 */
function loadKeyring(): Keyring {
  const isProd = process.env.NODE_ENV === "production";
  const legacyRaw = process.env.TOKEN_ENCRYPTION_KEY;
  const keysRaw = process.env.TOKEN_ENCRYPTION_KEYS;
  const activeKeyId = process.env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID ?? null;

  const keys = new Map<string, Buffer>();
  let legacyKey: Buffer | null = null;

  if (legacyRaw) {
    legacyKey = decodeKey(legacyRaw, "TOKEN_ENCRYPTION_KEY");
  }

  if (keysRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(keysRaw);
    } catch {
      throw new Error("TOKEN_ENCRYPTION_KEYS must be a JSON object of { keyId: base64Key }");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("TOKEN_ENCRYPTION_KEYS must be a JSON object of { keyId: base64Key }");
    }
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!KEY_ID_PATTERN.test(id)) {
        throw new Error(
          `TOKEN_ENCRYPTION_KEYS key id "${id}" is invalid (allowed: A-Za-z0-9_-, no ':')`,
        );
      }
      if (typeof value !== "string") {
        throw new Error(`TOKEN_ENCRYPTION_KEYS["${id}"] must be a base64 string`);
      }
      keys.set(id, decodeKey(value, `TOKEN_ENCRYPTION_KEYS["${id}"]`));
    }
    if (!activeKeyId) {
      throw new Error(
        "TOKEN_ENCRYPTION_ACTIVE_KEY_ID must be set when TOKEN_ENCRYPTION_KEYS is configured",
      );
    }
    if (!keys.has(activeKeyId)) {
      throw new Error(
        `TOKEN_ENCRYPTION_ACTIVE_KEY_ID "${activeKeyId}" is not present in TOKEN_ENCRYPTION_KEYS`,
      );
    }
    return { keys, activeKeyId, legacyKey };
  }

  // No keyring configured — legacy single-key mode.
  if (!legacyKey) {
    if (isProd) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY (or a TOKEN_ENCRYPTION_KEYS keyring) is required in production. " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
    // Dev-only deterministic fallback so local runs work without config.
    legacyKey = crypto.createHash("sha256").update("klorn-dev-only-not-for-production").digest();
  }
  return { keys, activeKeyId: null, legacyKey };
}

const keyring = loadKeyring();

function keyForId(keyId: string): Buffer {
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new Error(`Cannot decrypt: unknown key id "${keyId}" (retired or misconfigured keyring)`);
  }
  return key;
}

function seal(plaintext: string, key: Buffer): { iv: string; ct: string; tag: string } {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

function open(ivB64: string, ctB64: string, tagB64: string, key: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

export function encryptToken(plaintext: string): string {
  if (!plaintext) return plaintext;
  // Keyring configured → write v2 under the active key. Otherwise legacy v1.
  if (keyring.activeKeyId) {
    const { iv, ct, tag } = seal(plaintext, keyForId(keyring.activeKeyId));
    return `${V2}:${keyring.activeKeyId}:${iv}:${ct}:${tag}`;
  }
  // legacyKey is always set in this branch (loadKeyring guarantees it).
  const { iv, ct, tag } = seal(plaintext, keyring.legacyKey as Buffer);
  return `${V1}:${iv}:${ct}:${tag}`;
}

export function decryptToken(value: string): string {
  if (!value) return value;

  if (value.startsWith(`${V2}:`)) {
    const parts = value.split(":");
    if (parts.length !== 5) throw new Error("Malformed encrypted token (v2)");
    const [, keyId, iv, ct, tag] = parts;
    return open(iv, ct, tag, keyForId(keyId));
  }

  if (value.startsWith(`${V1}:`)) {
    const parts = value.split(":");
    if (parts.length !== 4) throw new Error("Malformed encrypted token");
    const [, iv, ct, tag] = parts;
    if (!keyring.legacyKey) {
      throw new Error("Cannot decrypt v1 token: TOKEN_ENCRYPTION_KEY not configured");
    }
    return open(iv, ct, tag, keyring.legacyKey);
  }

  // Cutoff: refuse to trust a non-v1/v2 (plaintext or unknown-scheme) value.
  // Silent passthrough once meant a plaintext OAuth token in the DB was used
  // as-is. Callers treat a decrypt throw as "rotate/reconnect", so failing
  // loud is the safe, visible behaviour.
  throw new Error("Refusing to use a non-v1/v2 token (plaintext or unknown scheme)");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return encryptToken(value);
}

/**
 * Returns null for empty/missing input. For a present value it delegates to
 * `decryptToken`, so it THROWS (does not return null) on a non-v1/v2 token —
 * the cutoff applies here too; we never silently trust plaintext.
 */
export function decryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return decryptToken(value);
}

/**
 * True when a stored value is not already v2 under the active key — i.e. a
 * v1 row, or a v2 row under a non-active (rotating-out) key. Used by the
 * re-encryption sweep to find rows to rewrite. Empty/missing → false.
 */
export function needsReencryption(value: string | null | undefined): boolean {
  if (!value) return false;
  if (!keyring.activeKeyId) return false; // legacy-only mode: nothing to migrate
  return !value.startsWith(`${V2}:${keyring.activeKeyId}:`);
}

/**
 * Re-encrypt a stored value under the active key. Returns null for empty
 * input, the value unchanged if it is already current, or a fresh v2 envelope
 * otherwise. Decrypt failures propagate so the sweep can report and skip.
 */
export function reencryptToActiveKey(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!needsReencryption(value)) return value;
  return encryptToken(decryptToken(value));
}

/** The active key id, or null in legacy single-key mode. Diagnostics only. */
export function activeKeyId(): string | null {
  return keyring.activeKeyId;
}
