// The one-time "Keep Klorn running in the background?" prompt in the Windows
// desktop shell (apps/desktop-win, tauri-plugin-autostart) — decision N5:
// "Not now" / "Open at login", the latter the primary, initially focused
// button; Esc means "Not now".
//
// Start-at-sign-in is opt-in, like the Mac's login item: OFF until the user
// says yes, and never enabled silently. The prompt asks once — only inside
// the shell, only while the shell reports it off — and the answer is kept in
// localStorage so it is never asked again. Settings keeps the toggle for a
// change of mind (settings/_sections/launch-at-login-row.tsx).
//
// Pure reducer, unit-tested without a browser
// (packages/api/src/__tests__/web-autostart-prompt.test.ts); the side effects
// live in ./tauri-autostart.ts and components/autostart-prompt.tsx.

export type AutostartAnswer = "accepted" | "declined" | "failed";

const ANSWERS: readonly AutostartAnswer[] = ["accepted", "declined", "failed"];

export type AutostartPromptState =
  | { phase: "idle" }
  | { phase: "offered" }
  | { phase: "enabling" }
  | { phase: "done"; answer: AutostartAnswer };

export type AutostartPromptEvent =
  /** What the edge found on launch. `enabled` is null when the shell could
   *  not say (IPC failed). */
  | {
      type: "probed";
      inShell: boolean;
      stored: AutostartAnswer | null;
      enabled: boolean | null;
    }
  | { type: "accept" }
  | { type: "decline" }
  | { type: "enabled" }
  | { type: "enableFailed" };

export const IDLE: AutostartPromptState = { phase: "idle" };

function onProbe(event: Extract<AutostartPromptEvent, { type: "probed" }>): AutostartPromptState {
  if (!event.inShell) return IDLE;
  if (event.stored) return { phase: "done", answer: event.stored };
  // Already on — the user turned it on in Settings first. Never ask.
  if (event.enabled === true) return { phase: "done", answer: "accepted" };
  if (event.enabled === false) return { phase: "offered" };
  return IDLE; // unknown: ask on a later launch rather than guess
}

export function autostartPromptReducer(
  state: AutostartPromptState,
  event: AutostartPromptEvent,
): AutostartPromptState {
  switch (state.phase) {
    case "idle":
      return event.type === "probed" ? onProbe(event) : state;
    case "offered":
      if (event.type === "accept") return { phase: "enabling" };
      if (event.type === "decline") return { phase: "done", answer: "declined" };
      return state;
    case "enabling":
      if (event.type === "enabled") return { phase: "done", answer: "accepted" };
      if (event.type === "enableFailed") return { phase: "done", answer: "failed" };
      return state;
    case "done":
      return state;
  }
}

/** Esc answers "Not now" while the question is open. While enabling, the
 *  answer is already given: Esc does nothing. */
export function escapeEvent(state: AutostartPromptState): AutostartPromptEvent | null {
  return state.phase === "offered" ? { type: "decline" } : null;
}

export function promptVisible(state: AutostartPromptState): boolean {
  return state.phase === "offered" || state.phase === "enabling";
}

/** The answer to store when `next` closes the prompt, else null. */
export function answerToPersist(
  prev: AutostartPromptState,
  next: AutostartPromptState,
): AutostartAnswer | null {
  return next.phase === "done" && prev.phase !== "done" ? next.answer : null;
}

export function parseAutostartAnswer(raw: string | null): AutostartAnswer | null {
  return ANSWERS.find((a) => a === raw) ?? null;
}
