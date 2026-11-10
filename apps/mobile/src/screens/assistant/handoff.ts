/**
 * "Ask the assistant about this": another screen hands the chat a starting
 * message (and the mail on screen), then opens it. The text is put in the
 * composer, never sent on its own — the user still taps send.
 */
export interface AssistantRequest {
  text: string;
  /** The mail the user is looking at, so "this email" resolves (context.emailId). */
  emailId?: string | null;
}

let pending: AssistantRequest | null = null;
const listeners = new Set<() => void>();

export function handOffToAssistant(request: AssistantRequest): void {
  pending = request;
  for (const listener of listeners) listener();
}

/** Take the waiting request once (the composer that shows it consumes it). */
export function takeAssistantRequest(): AssistantRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function onAssistantRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
