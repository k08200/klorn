import crypto from "node:crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

if (process.env.NODE_ENV === "production" && !process.env.TOKEN_ENCRYPTION_KEY) {
  throw new Error(
    "TOKEN_ENCRYPTION_KEY is required in production. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
  );
}

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    return crypto.createHash("sha256").update("klorn-dev-only-not-for-production").digest();
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded)");
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptToken(value: string): string {
  if (!value) return value;
  if (!value.startsWith(`${VERSION}:`)) {
    // Legacy plaintext — pass through so existing tokens keep working until they rotate
    return value;
  }
  const parts = value.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted token");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return encryptToken(value);
}

export function decryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return decryptToken(value);
}
