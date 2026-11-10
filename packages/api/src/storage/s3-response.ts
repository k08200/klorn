/**
 * Reading what the storage vendor answers (step D1 of
 * docs/providers/unified-platform-plan.md). A body is never read without a
 * byte cap, and a network failure is described in words that carry no URL and
 * no header.
 */

export interface CappedText {
  text: string;
  /** True when the body was longer than the cap. `text` then holds what fit. */
  truncated: boolean;
}

/**
 * Read a response body as UTF-8 text, at most `maxBytes` of it. Past the cap
 * the rest is not read and the connection is released. A read that fails (the
 * request's timeout fires while the body stalls) rejects with that error.
 */
export async function readTextCapped(response: Response, maxBytes: number): Promise<CappedText> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** What went wrong on the socket: the error's name and, when there is one, its code. */
export function describeNetworkError(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? `${name} ${cause.code}` : name;
}
