/**
 * Binds a web sign-in to the browser that starts it (login CSRF).
 *
 * Without it, an attacker who completes their own Google, Apple or Naver
 * sign-in could hand a victim the callback link (or the exchange code) and sign
 * the victim's browser into the attacker's account; mail the victim then
 * connects would be the attacker's to read. Here the browser keeps a random
 * nonce to itself and sends only its SHA-256 (the binding) through the sign-in;
 * the API redeems the exchange code only with the nonce (api
 * auth/exchange-codes.ts).
 *
 * localStorage, not sessionStorage: a provider's account chooser can end in a
 * fresh tab. Read once, then gone.
 */

const STORAGE_KEY = "klorn-login-binding";
const MAX_AGE_MS = 15 * 60_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Start a sign-in: keep a fresh nonce, return its binding for the login URL. */
export async function beginLoginBinding(): Promise<string> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nonce, at: Date.now() }));
  } catch {
    // Storage blocked: the exchange will refuse this sign-in, as it should.
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return toBase64Url(new Uint8Array(digest));
}

/** The nonce of the sign-in this browser started, once; null when none or too old. */
export function takeLoginBinding(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
    if (!raw) return null;
    const { nonce, at } = JSON.parse(raw) as { nonce?: unknown; at?: unknown };
    if (typeof nonce !== "string" || typeof at !== "number") return null;
    return Date.now() - at > MAX_AGE_MS ? null : nonce;
  } catch {
    return null;
  }
}

/** `url` with the binding appended as the `lb` query parameter. */
export function withLoginBinding(url: string, binding: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}lb=${encodeURIComponent(binding)}`;
}

/**
 * Follow a sign-in link bound to this browser. Call from the link's onClick:
 * a click something else already handled (the native shell's own flow) is
 * left alone.
 */
export function followBoundLoginLink(
  event: { defaultPrevented: boolean; preventDefault(): void },
  href: string,
): void {
  if (event.defaultPrevented) return;
  event.preventDefault();
  void beginLoginBinding().then((binding) => {
    window.location.assign(withLoginBinding(href, binding));
  });
}
