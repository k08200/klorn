/**
 * Windows desktop shell (apps/desktop-win, Tauri) start-at-sign-in — the
 * one-time first-run prompt's state machine in
 * packages/web/src/lib/native/autostart-prompt.ts.
 *
 * Start-at-sign-in is opt-in, like the Mac's login item: OFF until the user
 * says yes. The prompt asks once, only inside the Windows shell, only while
 * the shell reports it OFF, and nothing but an explicit "accept" ever turns
 * it on.
 */

import { describe, expect, it } from "vitest";
import de from "../../../web/src/lib/locales/de";
import en from "../../../web/src/lib/locales/en";
import es from "../../../web/src/lib/locales/es";
import fr from "../../../web/src/lib/locales/fr";
import ja from "../../../web/src/lib/locales/ja";
import ko from "../../../web/src/lib/locales/ko";
import zh from "../../../web/src/lib/locales/zh";
import {
  type AutostartPromptEvent,
  type AutostartPromptState,
  answerToPersist,
  autostartPromptReducer,
  IDLE,
  parseAutostartAnswer,
  promptVisible,
} from "../../../web/src/lib/native/autostart-prompt";

const probed = (
  over: Partial<Extract<AutostartPromptEvent, { type: "probed" }>> = {},
): AutostartPromptEvent => ({
  type: "probed",
  inShell: true,
  stored: null,
  enabled: false,
  ...over,
});

function run(events: AutostartPromptEvent[], start: AutostartPromptState = IDLE) {
  return events.reduce(autostartPromptReducer, start);
}

describe("autostartPromptReducer — when the prompt is offered", () => {
  it("offers once inside the Windows shell while start-at-sign-in is off and unanswered", () => {
    const state = run([probed()]);
    expect(state).toEqual({ phase: "offered" });
    expect(promptVisible(state)).toBe(true);
  });

  it("never offers outside the shell (browser, Capacitor)", () => {
    expect(run([probed({ inShell: false })])).toEqual(IDLE);
  });

  it("never offers again once answered, whatever the answer was", () => {
    for (const stored of ["accepted", "declined", "failed"] as const) {
      const state = run([probed({ stored })]);
      expect(state).toEqual({ phase: "done", answer: stored });
      expect(promptVisible(state)).toBe(false);
    }
  });

  it("does not offer when it is already on (turned on in Settings first) — records it", () => {
    expect(run([probed({ enabled: true })])).toEqual({ phase: "done", answer: "accepted" });
  });

  it("stays idle when the shell cannot say whether it is on — asks on a later launch", () => {
    expect(run([probed({ enabled: null })])).toEqual(IDLE);
  });
});

describe("autostartPromptReducer — nothing but an explicit yes turns it on", () => {
  it("accept → enabling → accepted", () => {
    const enabling = run([probed(), { type: "accept" }]);
    expect(enabling).toEqual({ phase: "enabling" });
    expect(promptVisible(enabling)).toBe(true);
    expect(run([{ type: "enabled" }], enabling)).toEqual({ phase: "done", answer: "accepted" });
  });

  it("decline closes it for good without enabling", () => {
    expect(run([probed(), { type: "decline" }])).toEqual({ phase: "done", answer: "declined" });
  });

  it("a failed enable closes it as failed — Settings is the retry path, not a nag", () => {
    expect(run([probed(), { type: "accept" }, { type: "enableFailed" }])).toEqual({
      phase: "done",
      answer: "failed",
    });
  });

  it("no probe outcome can reach enabling on its own", () => {
    const probes = [
      probed(),
      probed({ enabled: true }),
      probed({ enabled: null }),
      probed({ inShell: false }),
      probed({ stored: "declined" }),
    ];
    for (const event of probes) {
      expect(run([event, event]).phase).not.toBe("enabling");
    }
  });

  it("ignores events that do not apply to the current phase", () => {
    expect(run([{ type: "accept" }])).toEqual(IDLE);
    expect(run([{ type: "enabled" }])).toEqual(IDLE);
    expect(run([probed(), { type: "enabled" }])).toEqual({ phase: "offered" });
    expect(run([probed(), { type: "accept" }, { type: "decline" }])).toEqual({
      phase: "enabling",
    });
    const done = run([probed(), { type: "decline" }]);
    expect(run([probed(), { type: "accept" }], done)).toEqual(done);
  });
});

describe("answerToPersist — what the edge writes to storage", () => {
  it("persists only on the transition into done", () => {
    const offered = run([probed()]);
    const done = autostartPromptReducer(offered, { type: "decline" });
    expect(answerToPersist(offered, done)).toBe("declined");
    expect(answerToPersist(IDLE, offered)).toBeNull();
    expect(answerToPersist(done, done)).toBeNull();
  });
});

describe("parseAutostartAnswer — storage is untrusted", () => {
  it("reads the three answers and nothing else", () => {
    expect(parseAutostartAnswer("accepted")).toBe("accepted");
    expect(parseAutostartAnswer("declined")).toBe("declined");
    expect(parseAutostartAnswer("failed")).toBe("failed");
    for (const raw of [null, "", "yes", "ACCEPTED", "{}"]) {
      expect(parseAutostartAnswer(raw)).toBeNull();
    }
  });
});

describe("prompt and setting copy", () => {
  const KEYS = [
    "desktop.autostart.prompt.title",
    "desktop.autostart.prompt.body",
    "desktop.autostart.prompt.accept",
    "desktop.autostart.prompt.decline",
    "desktop.autostart.prompt.enabling",
    "desktop.autostart.failed",
    "settings.launchAtLogin.title",
    "settings.launchAtLogin.desc",
  ];

  it("is the agreed English explanation", () => {
    expect(en["desktop.autostart.prompt.body"]).toBe(
      "Klorn can start when you sign in so you keep getting urgent-mail notifications.",
    );
  });

  it("exists in every shipped locale, non-empty, and is translated in Korean", () => {
    for (const table of [en, ko, ja, zh, es, fr, de]) {
      for (const key of KEYS) {
        expect(table[key], key).toBeTruthy();
      }
    }
    for (const key of KEYS) {
      expect(ko[key], key).not.toBe(en[key]);
    }
  });
});
