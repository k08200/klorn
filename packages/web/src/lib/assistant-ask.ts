/**
 * Hand a question to the global assistant dock (productization plan P6).
 * Today's ask box does not own a chat: it opens the dock that is already
 * mounted on every app surface, with the text in its composer. Nothing is sent
 * until the user sends it there, so asking costs no model call by itself.
 */

export const ASSISTANT_ASK_EVENT = "klorn:assistant-ask";

export interface AssistantAskDetail {
  text: string;
}

export function askAssistant(text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AssistantAskDetail>(ASSISTANT_ASK_EVENT, { detail: { text } }),
  );
}

/** Open the dock without a question (the phone reader's top-bar button). */
export const ASSISTANT_OPEN_EVENT = "klorn:assistant-open";

export function openAssistant(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT));
}
