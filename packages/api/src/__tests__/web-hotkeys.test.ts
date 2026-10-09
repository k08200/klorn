// Pins packages/web/src/lib/hotkeys.ts — the single keyboard table behind key
// handling, the `?` sheet and the command-palette actions (productization plan
// P4). Pure logic, run from the api suite because the web package has no
// unit-test runner (see web-modal-stack.test.ts).
import { describe, expect, it } from "vitest";
import {
  createHotkeyMatcher,
  createHotkeyRegistry,
  effectiveKey,
  HOTKEYS,
  type HotkeyContext,
  type HotkeyDef,
  type HotkeyScope,
  hotkeyBlockReason,
  hotkeyCaps,
  isActivatableTarget,
  isTypingTarget,
  type KeyEventLike,
  LANE_HOTKEY_ORDER,
  liveHotkeys,
  matchLegacyHotkey,
  SEQUENCE_TIMEOUT_MS,
} from "../../../web/src/lib/hotkeys";
import { CORE_TIERS } from "../../../web/src/lib/tiers";

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const ctx = (triage: boolean, ...scopes: HotkeyScope[]): HotkeyContext => ({
  triage,
  scopes: new Set<HotkeyScope>(["global", ...scopes]),
});

const ALL_SCOPES: HotkeyScope[] = ["global", "mail-list", "mail-detail"];

const enabledIn = (c: HotkeyContext) => (def: HotkeyDef) => def.enabled(c);

const feed = (
  event: KeyEventLike,
  c: HotkeyContext = ctx(true, "mail-list"),
  matcher = createHotkeyMatcher(),
  now = 0,
) => matcher.feed(event, { tagName: "BODY" }, enabledIn(c), now);

const idOf = (match: ReturnType<typeof feed>) =>
  match.kind === "match" ? match.def.id : match.kind;

describe("the table", () => {
  it("has unique ids and every entry names a label key under keys.*", () => {
    const ids = HOTKEYS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of HOTKEYS) expect(def.labelKey.startsWith("keys.")).toBe(true);
  });

  it("no two entries live in one scope claim the same key", () => {
    // UNIFIED_HOME gives `g a` a different destination, so the table holds one
    // entry per side of the flag: unique within each side, never both at once.
    for (const unifiedHome of [false, true]) {
      const live = { triage: true, scopes: new Set<HotkeyScope>(ALL_SCOPES), unifiedHome };
      const seen = new Map<string, string>();
      for (const def of HOTKEYS.filter((d) => !d.legacy && d.enabled(live))) {
        for (const scope of def.scopes) {
          for (const keys of def.keys) {
            const slot = `${scope}:${keys}`;
            expect(
              seen.get(slot),
              `${slot} claimed by ${seen.get(slot)} and ${def.id}`,
            ).toBeUndefined();
            seen.set(slot, def.id);
          }
        }
      }
    }
  });

  it("lane keys 1–5 are the five live lanes in display order, never AUTO", () => {
    expect([...LANE_HOTKEY_ORDER]).toEqual([...CORE_TIERS]);
    LANE_HOTKEY_ORDER.forEach((lane, i) => {
      expect(idOf(feed(key(String(i + 1))))).toBe(`lane.${lane}`);
    });
    expect(idOf(feed(key("6")))).toBe("none");
    expect(HOTKEYS.some((d) => d.id.includes("AUTO") || d.id.includes("CALL"))).toBe(false);
  });

  it("only the three pre-flag shortcuts are legacy", () => {
    expect(HOTKEYS.filter((d) => d.legacy).map((d) => d.keys[0])).toEqual([
      "mod+k",
      "mod+b",
      "mod+/",
    ]);
  });
});

describe("flag off", () => {
  it("no flag-gated entry is enabled, in any scope", () => {
    const off = ctx(false, "mail-list", "mail-detail");
    expect(HOTKEYS.filter((d) => d.enabled(off)).every((d) => d.legacy)).toBe(true);
    for (const k of ["j", "k", "o", "e", "r", "c", "1", "5", "x", "/", "?", "z", "g", "Escape"]) {
      expect(feed(key(k), off).kind).toBe("none");
    }
  });

  it("the legacy shortcuts still match, exactly as before", () => {
    expect(matchLegacyHotkey(key("k", { metaKey: true }))?.id).toBe("palette.toggle");
    expect(matchLegacyHotkey(key("b", { ctrlKey: true }))?.id).toBe("nav.briefing");
    expect(matchLegacyHotkey(key("/", { metaKey: true }))?.id).toBe("help.toggle");
    expect(matchLegacyHotkey(key("b"))).toBeNull();
    expect(matchLegacyHotkey(key("j", { metaKey: true }))).toBeNull();
  });
});

describe("matching", () => {
  it("plain keys match in their scope only", () => {
    expect(idOf(feed(key("j")))).toBe("mail.next");
    expect(idOf(feed(key("k")))).toBe("mail.prev");
    expect(idOf(feed(key("o")))).toBe("mail.open");
    expect(idOf(feed(key("Enter")))).toBe("mail.open");
    expect(idOf(feed(key("c")))).toBe("mail.compose");
    // The reader has no list to move back through, and no compose.
    expect(idOf(feed(key("k"), ctx(true, "mail-detail")))).toBe("none");
    // The Mail v2 reader does have a previous mail: it mounts its own scope.
    expect(idOf(feed(key("k"), ctx(true, "mail-detail", "mail-reader")))).toBe("mail.prev");
    expect(idOf(feed(key("k"), ctx(false, "mail-detail", "mail-reader")))).toBe("none");
    expect(idOf(feed(key("c"), ctx(true, "mail-detail")))).toBe("none");
    // Outside mail, the triage keys do nothing.
    expect(idOf(feed(key("e"), ctx(true)))).toBe("none");
    expect(idOf(feed(key("?"), ctx(true)))).toBe("help.open");
  });

  it("Shift is a different key for letters, and part of typing ? for symbols", () => {
    expect(idOf(feed(key("J", { shiftKey: true })))).toBe("select.extendDown");
    expect(idOf(feed(key("K", { shiftKey: true })))).toBe("select.extendUp");
    expect(idOf(feed(key("E", { shiftKey: true })))).toBe("none");
    expect(idOf(feed(key("?", { shiftKey: true })))).toBe("help.open");
  });

  it("an unexpected modifier never fires a plain key", () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(idOf(feed(key("e", mods)))).toBe("none");
      expect(idOf(feed(key("1", mods)))).toBe("none");
      expect(idOf(feed(key("j", mods)))).toBe("none");
    }
    expect(idOf(feed(key("1", { shiftKey: true })))).toBe("none");
    // Cmd+Z is the one flag-gated chord that names mod.
    expect(idOf(feed(key("z", { metaKey: true })))).toBe("mail.undo");
    expect(idOf(feed(key("z", { metaKey: true, altKey: true })))).toBe("none");
  });

  it("a held key repeats only for movement", () => {
    expect(idOf(feed(key("j", { repeat: true })))).toBe("mail.next");
    expect(idOf(feed(key("e", { repeat: true })))).toBe("none");
    expect(idOf(feed(key("3", { repeat: true })))).toBe("none");
  });

  it("Enter on a focused button or link is left to that control", () => {
    const matcher = createHotkeyMatcher();
    const on = enabledIn(ctx(true, "mail-list"));
    expect(matcher.feed(key("Enter"), { tagName: "BUTTON" }, on, 0).kind).toBe("none");
    expect(matcher.feed(key("Enter"), { tagName: "A" }, on, 0).kind).toBe("none");
    expect(matcher.feed(key("Enter"), { tagName: "DIV" }, on, 0).kind).toBe("match");
    // Other keys still work with a button focused.
    expect(matcher.feed(key("j"), { tagName: "BUTTON" }, on, 0).kind).toBe("match");
  });
});

describe("sequences", () => {
  it("g then m goes to mail; g alone waits", () => {
    const matcher = createHotkeyMatcher();
    expect(feed(key("g"), ctx(true), matcher, 0).kind).toBe("pending");
    expect(idOf(feed(key("m"), ctx(true), matcher, 300))).toBe("go.mail");
  });

  it("covers the destinations that exist and not the ones that do not", () => {
    const go = (second: string) => {
      const matcher = createHotkeyMatcher();
      feed(key("g"), ctx(true), matcher, 0);
      return idOf(feed(key(second), ctx(true), matcher, 10));
    };
    expect(go("c")).toBe("go.calendar");
    expect(go("s")).toBe("go.settings");
    expect(go("a")).toBe("go.queue");
    expect(go("b")).toBe("go.briefing");
    // Today exists only under UNIFIED_HOME; Files has no route yet.
    expect(go("t")).toBe("none");
    expect(go("f")).toBe("none");
  });

  it("UNIFIED_HOME: g t goes to Today and g a means Assistant", () => {
    const unified = { ...ctx(true), unifiedHome: true };
    const go = (second: string) => {
      const matcher = createHotkeyMatcher();
      feed(key("g"), unified, matcher, 0);
      return idOf(feed(key(second), unified, matcher, 10));
    };
    expect(go("t")).toBe("go.today");
    expect(go("a")).toBe("go.assistant");
    // The rest of the destinations are the same on both sides of the flag.
    expect(go("m")).toBe("go.mail");
    expect(go("c")).toBe("go.calendar");
    expect(go("b")).toBe("go.briefing");
    expect(go("s")).toBe("go.settings");
  });

  it("UNIFIED_HOME destinations need keyboard triage too", () => {
    const off = { ...ctx(false), unifiedHome: true };
    expect(feed(key("g"), off).kind).toBe("none");
    const today = HOTKEYS.find((def) => def.id === "go.today");
    expect(today?.enabled(off)).toBe(false);
    expect(today?.enabled({ ...ctx(true), unifiedHome: true })).toBe(true);
    expect(today?.enabled(ctx(true))).toBe(false);
  });

  it("the prefix expires, and then the second key is just itself", () => {
    const matcher = createHotkeyMatcher();
    const c = ctx(true, "mail-list");
    feed(key("g"), c, matcher, 0);
    expect(idOf(feed(key("c"), c, matcher, SEQUENCE_TIMEOUT_MS + 1))).toBe("mail.compose");
  });

  it("a prefix is used up by the next key, whatever it is", () => {
    const matcher = createHotkeyMatcher();
    const c = ctx(true, "mail-list");
    feed(key("g"), c, matcher, 0);
    expect(idOf(feed(key("j"), c, matcher, 10))).toBe("mail.next");
    expect(idOf(feed(key("m"), c, matcher, 20))).toBe("none");
  });

  it("pressing Shift between the chords does not break the sequence", () => {
    const matcher = createHotkeyMatcher();
    feed(key("g"), ctx(true), matcher, 0);
    expect(feed(key("Shift", { shiftKey: true }), ctx(true), matcher, 5).kind).toBe("none");
    expect(idOf(feed(key("m"), ctx(true), matcher, 10))).toBe("go.mail");
  });

  it("reset drops a pending prefix", () => {
    const matcher = createHotkeyMatcher();
    feed(key("g"), ctx(true), matcher, 0);
    matcher.reset();
    expect(idOf(feed(key("m"), ctx(true), matcher, 10))).toBe("none");
  });
});

describe("guards", () => {
  it("typing targets: text inputs, textarea, select, contenteditable, ARIA text roles", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", role: "combobox" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("activatable targets", () => {
    expect(isActivatableTarget({ tagName: "BUTTON" })).toBe(true);
    expect(isActivatableTarget({ tagName: "DIV", role: "option" })).toBe(true);
    expect(isActivatableTarget({ tagName: "LI" })).toBe(false);
  });

  it("blocks while typing, while an IME composes, and under a modal", () => {
    const body = { tagName: "BODY" };
    expect(hotkeyBlockReason(key("j"), { tagName: "INPUT" }, false)).toBe("typing");
    expect(hotkeyBlockReason(key("j"), body, true)).toBe("modal");
    expect(hotkeyBlockReason(key("j"), body, false)).toBeNull();
  });

  it("Korean IME: composing keydowns are text, in every shape browsers report them", () => {
    const body = { tagName: "BODY" };
    // Chrome/Safari mid-composition, the legacy keyCode 229, and Firefox's "Process".
    expect(hotkeyBlockReason(key("ㅓ", { isComposing: true }), body, false)).toBe("composing");
    expect(hotkeyBlockReason(key("j", { keyCode: 229 }), body, false)).toBe("composing");
    expect(hotkeyBlockReason(key("Process"), body, false)).toBe("composing");
    // Escape that ends a composition must not navigate back.
    expect(hotkeyBlockReason(key("Escape", { isComposing: true }), body, false)).toBe("composing");
  });

  it("a non-Latin character with no key position to fall back on is not a hotkey", () => {
    expect(idOf(feed(key("ㅓ")))).toBe("none");
    expect(idOf(feed(key("ㅏ")))).toBe("none");
  });
});

describe("non-Latin layouts resolve by key position (event.code), like the Mac app", () => {
  it("Korean 2-set: ㅓ on the J key moves down, ㅏ on K moves up, ㄷ on E is done", () => {
    expect(idOf(feed(key("ㅓ", { code: "KeyJ" })))).toBe("mail.next");
    expect(idOf(feed(key("ㅏ", { code: "KeyK" })))).toBe("mail.prev");
    expect(idOf(feed(key("ㄷ", { code: "KeyE" })))).toBe("mail.done");
    expect(idOf(feed(key("ㅋ", { code: "KeyZ" })))).toBe("mail.undo");
    // Shift is still a different key: ㅕ is Shift+U, ㅓ with Shift is Shift+J.
    expect(idOf(feed(key("ㅓ", { code: "KeyJ", shiftKey: true })))).toBe("select.extendDown");
  });

  it("sequences work too: ㅎ (G) then ㅡ (M) goes to mail", () => {
    const matcher = createHotkeyMatcher();
    expect(feed(key("ㅎ", { code: "KeyG" }), ctx(true), matcher, 0).kind).toBe("pending");
    expect(idOf(feed(key("ㅡ", { code: "KeyM" }), ctx(true), matcher, 10))).toBe("go.mail");
  });

  it("Cyrillic: о on the J key is j", () => {
    expect(idOf(feed(key("о", { code: "KeyJ" })))).toBe("mail.next");
  });

  it("digits and / fall back by position as well", () => {
    expect(effectiveKey(key("١", { code: "Digit1" }))).toBe("1");
    expect(effectiveKey(key("。", { code: "Slash" }))).toBe("/");
    expect(effectiveKey(key("？", { code: "Slash", shiftKey: true }))).toBe("?");
  });

  it("a composing event never fires, even with a code that would match", () => {
    const body = { tagName: "BODY" };
    const composing = key("ㅓ", { code: "KeyJ", isComposing: true });
    expect(hotkeyBlockReason(composing, body, false)).toBe("composing");
    expect(hotkeyBlockReason(key("ㅓ", { code: "KeyJ", keyCode: 229 }), body, false)).toBe(
      "composing",
    );
    // And never in a text field, composing or not.
    expect(hotkeyBlockReason(key("ㅓ", { code: "KeyJ" }), { tagName: "INPUT" }, false)).toBe(
      "typing",
    );
  });

  it("Latin layouts resolve by character, not position (Dvorak)", () => {
    // Dvorak: the physical J key types "h", and "j" is on the physical C key.
    expect(idOf(feed(key("h", { code: "KeyJ" })))).toBe("none");
    expect(idOf(feed(key("j", { code: "KeyC" })))).toBe("mail.next");
    // The physical E key types "." on Dvorak: not "done".
    expect(idOf(feed(key(".", { code: "KeyE" })))).toBe("none");
    // AZERTY digits row without Shift types "&": position must not turn it into 1.
    expect(idOf(feed(key("&", { code: "Digit1" })))).toBe("none");
  });

  it("Latin-script characters beyond ASCII are not remapped by position", () => {
    // AZERTY digit row, unshifted: é è ç à sit on Digit2 / 7 / 9 / 0.
    for (const [char, code] of [
      ["é", "Digit2"],
      ["è", "Digit7"],
      ["ç", "Digit9"],
      ["à", "Digit0"],
    ] as const) {
      expect(effectiveKey(key(char, { code }))).toBe(char);
      expect(idOf(feed(key(char, { code })))).toBe("none");
    }
    // Turkish dotless ı is on the physical I key; ö / ü on other letter keys.
    expect(effectiveKey(key("ı", { code: "KeyI" }))).toBe("ı");
    expect(idOf(feed(key("ı", { code: "KeyI" })))).toBe("none");
    expect(idOf(feed(key("ö", { code: "KeyJ" })))).toBe("none");
    // Non-Latin scripts still fall back: Hangul, Cyrillic, Kana, Greek.
    expect(idOf(feed(key("ㅓ", { code: "KeyJ" })))).toBe("mail.next");
    expect(idOf(feed(key("о", { code: "KeyJ" })))).toBe("mail.next");
    expect(idOf(feed(key("ま", { code: "KeyJ" })))).toBe("mail.next");
    expect(idOf(feed(key("ξ", { code: "KeyJ" })))).toBe("mail.next");
  });

  it("named keys are never remapped", () => {
    expect(effectiveKey(key("Escape", { code: "Escape" }))).toBe("Escape");
    expect(effectiveKey(key("Enter", { code: "KeyJ" }))).toBe("Enter");
  });

  it("the legacy Cmd chords are untouched (flag-off behaviour is by character, as before)", () => {
    expect(matchLegacyHotkey(key("ㅏ", { code: "KeyK", metaKey: true }))).toBeNull();
  });
});

describe("registry", () => {
  it("lists only enabled entries that have a mounted handler", () => {
    const registry = createHotkeyRegistry();
    const run = () => {};
    const unmount = registry.register("mail-list", { "mail.next": { run }, "mail.done": { run } });
    const on = { triage: true, scopes: registry.activeScopes() };
    expect(liveHotkeys(on, registry).map((h) => h.def.id)).toEqual(["mail.next", "mail.done"]);
    // Flag off: nothing flag-gated, even with handlers mounted.
    expect(liveHotkeys({ triage: false, scopes: registry.activeScopes() }, registry)).toEqual([]);
    unmount();
    expect(registry.activeScopes().has("mail-list")).toBe(false);
    expect(liveHotkeys({ triage: true, scopes: registry.activeScopes() }, registry)).toEqual([]);
  });

  it("the most recently mounted surface answers an id; unmounting restores the earlier one", () => {
    const registry = createHotkeyRegistry();
    const first = { run: () => {} };
    const second = { run: () => {} };
    registry.register("mail-list", { "mail.undo": first });
    const unmount = registry.register("mail-detail", { "mail.undo": second });
    expect(registry.resolve("mail.undo")).toBe(second);
    unmount();
    expect(registry.resolve("mail.undo")).toBe(first);
    expect(registry.resolve("nope")).toBeUndefined();
  });
});

describe("hotkeyCaps", () => {
  it("renders chords and sequences per platform", () => {
    expect(hotkeyCaps("mod+k", true)).toEqual(["⌘", "K"]);
    expect(hotkeyCaps("mod+k", false)).toEqual(["Ctrl", "K"]);
    expect(hotkeyCaps("shift+j", true)).toEqual(["Shift", "J"]);
    expect(hotkeyCaps("g m", true)).toEqual(["G", "M"]);
    expect(hotkeyCaps("Escape", true)).toEqual(["Esc"]);
    expect(hotkeyCaps("?", true)).toEqual(["?"]);
  });
});
