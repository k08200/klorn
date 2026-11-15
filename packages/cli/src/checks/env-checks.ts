import { type Check, check } from "./types.js";

/**
 * Env checks for the API's configuration. Values are NEVER printed — only
 * "set"/"missing", a length, a decoded byte count or a well-known prefix.
 * The rules mirror what the API itself enforces at boot:
 *   - JWT_SECRET required outside dev/test (packages/api/src/auth.ts)
 *   - TOKEN_ENCRYPTION_KEY must base64-decode to exactly 32 bytes, or a
 *     TOKEN_ENCRYPTION_KEYS keyring with its active id (packages/api/src/crypto-tokens.ts)
 *   - CORS fails closed in production without the web origin (packages/api/src/index.ts)
 * and what docker-compose.selfhost.yml marks `:?` (required).
 */

type Env = Readonly<Record<string, string | undefined>>;
export type EnvMode = "compose" | "url";

/** The untouched values from .env.selfhost.example. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  POSTGRES_PASSWORD: "change-me-strong-password",
  JWT_SECRET: "change-me-long-random-string",
  TOKEN_ENCRYPTION_KEY: "change-me-base64-32-bytes",
  GOOGLE_CLIENT_ID: "your-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "your-client-secret",
};

const MIN_JWT_SECRET_CHARS = 32;
const MIN_POSTGRES_PASSWORD_CHARS = 12;
const ENCRYPTION_KEY_BYTES = 32;
/** packages/api/src/crypto-tokens.ts KEY_ID_PATTERN. */
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GOOGLE_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";
const GOOGLE_SECRET_PREFIX = "GOCSPX-";
/** docker-compose.selfhost.yml defaults for WEB_URL and CORS_ORIGINS. */
const COMPOSE_DEFAULT_WEB_URL = "http://localhost:3000";

const isPlaceholder = (key: string, value: string) => PLACEHOLDERS[key] === value;

function secretCheck(env: Env, key: string, minChars: number, missingWhy: string): Check {
  const id = `env.${key}`;
  const value = env[key];
  if (!value) return check(id, "fail", `missing — ${missingWhy}`);
  if (isPlaceholder(key, value)) {
    return check(id, "fail", "still the .env.selfhost.example placeholder");
  }
  if (value.length < minChars) {
    return check(id, "warn", `set (${value.length} chars) — use at least ${minChars}`);
  }
  if (value.includes("$")) {
    return check(
      id,
      "warn",
      `set (${value.length} chars), but contains $ — docker compose expands it unless the value is single-quoted`,
    );
  }
  return check(id, "pass", `set (${value.length} chars)`);
}

const decodedBytes = (value: string) => Buffer.from(value, "base64").length;

function keyringCheck(env: Env, raw: string): Check {
  const id = "env.TOKEN_ENCRYPTION_KEY";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return check(id, "fail", "TOKEN_ENCRYPTION_KEYS is set but is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return check(id, "fail", "TOKEN_ENCRYPTION_KEYS must be a JSON object of { keyId: base64Key }");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([k]) => !KEY_ID.test(k))) {
    return check(id, "fail", "TOKEN_ENCRYPTION_KEYS has a key id outside A-Z a-z 0-9 _ - (max 64)");
  }
  const legacy = env.TOKEN_ENCRYPTION_KEY;
  if (legacy && decodedBytes(legacy) !== ENCRYPTION_KEY_BYTES) {
    return check(id, "fail", "TOKEN_ENCRYPTION_KEY is set next to the keyring but is not 32 bytes");
  }
  const bad = entries.filter(
    ([, v]) => typeof v !== "string" || decodedBytes(v) !== ENCRYPTION_KEY_BYTES,
  );
  if (bad.length > 0) {
    return check(
      id,
      "fail",
      `TOKEN_ENCRYPTION_KEYS has ${bad.length} key(s) that are not 32 bytes`,
    );
  }
  const active = env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
  if (!active || !entries.some(([k]) => k === active)) {
    return check(id, "fail", "TOKEN_ENCRYPTION_ACTIVE_KEY_ID is not one of the keyring's ids");
  }
  const noun = entries.length === 1 ? "key" : "keys";
  return check(id, "pass", `keyring set (${entries.length} ${noun}, active ${active})`);
}

// docker-compose.selfhost.yml passes only TOKEN_ENCRYPTION_KEY to the api (and
// requires it), so a keyring counts on the URL path only.
function encryptionKeyCheck(env: Env, mode: EnvMode): Check {
  const id = "env.TOKEN_ENCRYPTION_KEY";
  if (mode === "url" && env.TOKEN_ENCRYPTION_KEYS) {
    return keyringCheck(env, env.TOKEN_ENCRYPTION_KEYS);
  }
  const value = env.TOKEN_ENCRYPTION_KEY;
  if (!value) return check(id, "fail", "missing — the API refuses to boot in production");
  if (isPlaceholder("TOKEN_ENCRYPTION_KEY", value)) {
    return check(id, "fail", "still the .env.selfhost.example placeholder");
  }
  const bytes = decodedBytes(value);
  if (bytes !== ENCRYPTION_KEY_BYTES) {
    return check(id, "fail", `set, but decodes to ${bytes} bytes — must be exactly 32 (base64)`);
  }
  return check(id, "pass", "set (decodes to 32 bytes)");
}

function googleClientIdCheck(env: Env): Check {
  const id = "env.GOOGLE_CLIENT_ID";
  const value = env.GOOGLE_CLIENT_ID;
  if (!value) return check(id, "fail", "missing — Google sign-in and Gmail cannot work");
  if (isPlaceholder("GOOGLE_CLIENT_ID", value)) {
    return check(id, "fail", "still the .env.selfhost.example placeholder");
  }
  if (!value.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    return check(id, "warn", `set, but does not end in ${GOOGLE_CLIENT_ID_SUFFIX}`);
  }
  return check(id, "pass", `set (*${GOOGLE_CLIENT_ID_SUFFIX})`);
}

function googleSecretCheck(env: Env): Check {
  const id = "env.GOOGLE_CLIENT_SECRET";
  const value = env.GOOGLE_CLIENT_SECRET;
  if (!value) return check(id, "fail", "missing — Google sign-in and Gmail cannot work");
  if (isPlaceholder("GOOGLE_CLIENT_SECRET", value)) {
    return check(id, "fail", "still the .env.selfhost.example placeholder");
  }
  const prefix = value.startsWith(GOOGLE_SECRET_PREFIX) ? `, ${GOOGLE_SECRET_PREFIX} prefix` : "";
  return check(id, "pass", `set (${value.length} chars${prefix})`);
}

function llmProviderCheck(env: Env): Check {
  const providers = [
    env.ANTHROPIC_API_KEY ? "anthropic" : null,
    env.GEMINI_API_KEY ? "gemini" : null,
    env.OPENAI_COMPAT_BASE_URL ? "openai-compatible" : null,
  ].filter((p): p is string => p !== null);
  if (providers.length === 0) {
    return check(
      "env.llm_provider",
      "fail",
      "none set — mail cannot be judged (set ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENAI_COMPAT_BASE_URL)",
    );
  }
  return check("env.llm_provider", "pass", providers.join(", "));
}

const originOf = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

function corsCheck(env: Env): Check {
  const id = "env.CORS_ORIGINS";
  const webOrigin = originOf(env.WEB_URL || COMPOSE_DEFAULT_WEB_URL);
  if (!webOrigin) return check(id, "fail", "WEB_URL is not a valid URL");
  const allowed = (env.CORS_ORIGINS || COMPOSE_DEFAULT_WEB_URL)
    .split(",")
    .map((entry) => originOf(entry.trim()))
    .filter((origin): origin is string => origin !== null);
  if (!allowed.includes(webOrigin)) {
    return check(
      id,
      "fail",
      `does not include WEB_URL's origin ${webOrigin} — the web app cannot call the API`,
    );
  }
  return check(id, "pass", `includes ${webOrigin}`);
}

export function checkEnv(env: Env, mode: EnvMode): Check[] {
  return [
    ...(mode === "compose"
      ? [
          secretCheck(
            env,
            "POSTGRES_PASSWORD",
            MIN_POSTGRES_PASSWORD_CHARS,
            "docker compose refuses to start",
          ),
        ]
      : []),
    secretCheck(env, "JWT_SECRET", MIN_JWT_SECRET_CHARS, "the API refuses to boot in production"),
    encryptionKeyCheck(env, mode),
    googleClientIdCheck(env),
    googleSecretCheck(env),
    llmProviderCheck(env),
    corsCheck(env),
  ];
}
