// Start-at-sign-in in the Windows desktop shell: the side-effecting edge for
// ./autostart-prompt.ts — the autostart plugin's IPC commands and the stored
// prompt answer.
//
// The shell grants exactly the plugin's enable / disable / is_enabled to
// app.klorn.ai (apps/desktop-win/src-tauri/capabilities/default.json); none
// takes an argument, so the page cannot change what Windows runs at sign-in.

import { type AutostartAnswer, parseAutostartAnswer } from "./autostart-prompt";
import { tauriInvoke } from "./shell";

const ANSWER_KEY = "klorn.desktopAutostart.promptAnswer";

/** Whether the shell will start Klorn at sign-in. Rejects outside Tauri or
 *  when the shell cannot tell. */
export async function isAutostartEnabled(): Promise<boolean> {
  const enabled = await tauriInvoke("plugin:autostart|is_enabled");
  if (typeof enabled !== "boolean") throw new Error("autostart: unexpected is_enabled reply");
  return enabled;
}

/** Turn start-at-sign-in on or off. Only ever called from a user gesture. */
export async function setAutostart(enabled: boolean): Promise<void> {
  await tauriInvoke(enabled ? "plugin:autostart|enable" : "plugin:autostart|disable");
}

export function readAutostartAnswer(): AutostartAnswer | null {
  try {
    return parseAutostartAnswer(window.localStorage.getItem(ANSWER_KEY));
  } catch {
    return null;
  }
}

export function writeAutostartAnswer(answer: AutostartAnswer): void {
  try {
    window.localStorage.setItem(ANSWER_KEY, answer);
  } catch (err) {
    console.warn("[AUTOSTART] could not persist the prompt answer:", err);
  }
}
