/**
 * The keyboard map, in one place (productization plan §3, P4).
 *
 * `HOTKEYS` is the single table that drives three things: key handling
 * (components/keyboard-shortcuts.tsx), the `?` shortcut sheet, and the
 * command-palette action entries. A key that is not in this table does not
 * exist; a surface that wants to answer one registers a handler for its id
 * (lib/use-hotkeys.ts) and never listens for keys itself.
 *
 * Everything here is pure (no DOM at import) so the api vitest suite can pin
 * it, like lib/modal-stack.
 *
 * Two kinds of entry:
 *  - `legacy`: the three shortcuts that predate the KEYBOARD_TRIAGE flag
 *    (Cmd/Ctrl+K, +B, +/). They work with the flag off and match exactly as
 *    they always did: a Cmd/Ctrl chord fires even while typing.
 *  - everything else needs the flag, and never fires while the user is typing,
 *    composing with an IME, holding an unexpected modifier, or looking at a
 *    modal.
 */

import { CORE_TIERS } from "./tiers";

/**
 * `mail-reader` is the Mail v2 reader (MAIL_V2), mounted next to `mail-detail`:
 * it has a previous mail to go to, which the legacy reader does not.
 */
export type HotkeyScope = "global" | "mail-list" | "mail-detail" | "mail-reader";

export type HotkeyGroup = "general" | "navigate" | "triage" | "lane" | "select" | "go";

/** What decides whether an entry is live right now. */
export interface HotkeyContext {
  /** The KEYBOARD_TRIAGE flag, as the server reported it. */
  triage: boolean;
  /** Scopes with a mounted surface. "global" is always present. */
  scopes: ReadonlySet<HotkeyScope>;
  /**
   * The UNIFIED_HOME flag, as the server reported it (absent = off). It
   * decides which destinations the `g` keys have: `g t` exists only with
   * Today, and `g a` means Assistant instead of the decision queue.
   */
  unifiedHome?: boolean;
}

export interface HotkeyDef {
  id: string;
  /**
   * Alternatives, each a chord or a two-chord sequence: "j", "shift+j",
   * "mod+k", "g m", "Enter". `mod` is Cmd on macOS and Ctrl elsewhere.
   */
  keys: readonly string[];
  scopes: readonly HotkeyScope[];
  /** i18n key of the action name shown in the sheet and the palette. */
  labelKey: string;
  group: HotkeyGroup;
  enabled: (ctx: HotkeyContext) => boolean;
  /** Predates the flag: works with it off and while typing. */
  legacy?: true;
  /** Offered as a command-palette action when a handler is mounted. */
  palette?: true;
  /** May fire on key auto-repeat (held key). Only movement does. */
  repeatable?: true;
}

const always = () => true;

const inScope =
  (scopes: readonly HotkeyScope[]) =>
  (ctx: HotkeyContext): boolean =>
    ctx.triage && scopes.some((scope) => ctx.scopes.has(scope));

type DefInput = Omit<HotkeyDef, "enabled" | "keys"> & { keys: string | readonly string[] };

const triage = (def: DefInput): HotkeyDef => ({
  ...def,
  keys: typeof def.keys === "string" ? [def.keys] : def.keys,
  enabled: inScope(def.scopes),
});

/** A `g` destination that exists on only one side of UNIFIED_HOME. */
const destination = (def: DefInput, unifiedHome: boolean): HotkeyDef => {
  const base = triage(def);
  return {
    ...base,
    enabled: (ctx) => base.enabled(ctx) && (ctx.unifiedHome === true) === unifiedHome,
  };
};

const legacy = (id: string, keys: string, labelKey: string): HotkeyDef => ({
  id,
  keys: [keys],
  scopes: ["global"],
  labelKey,
  group: "general",
  enabled: always,
  legacy: true,
});

const MAIL: readonly HotkeyScope[] = ["mail-list", "mail-detail"];
const LIST: readonly HotkeyScope[] = ["mail-list"];
const LIST_AND_READER: readonly HotkeyScope[] = ["mail-list", "mail-reader"];
const GLOBAL: readonly HotkeyScope[] = ["global"];

/** Lane keys 1–5: the five live lanes in their display order (lib/tiers). */
export const LANE_HOTKEY_ORDER = CORE_TIERS;

export const laneHotkeyId = (lane: (typeof LANE_HOTKEY_ORDER)[number]) => `lane.${lane}`;

const laneDefs: HotkeyDef[] = LANE_HOTKEY_ORDER.map((lane, index) =>
  triage({
    id: laneHotkeyId(lane),
    keys: String(index + 1),
    scopes: MAIL,
    labelKey: `keys.lane.${lane}`,
    group: "lane",
    palette: true,
  }),
);

export const HOTKEYS: readonly HotkeyDef[] = [
  legacy("palette.toggle", "mod+k", "keys.palette"),
  legacy("nav.briefing", "mod+b", "keys.briefing"),
  legacy("help.toggle", "mod+/", "keys.help"),
  triage({ id: "help.open", keys: "?", scopes: GLOBAL, labelKey: "keys.help", group: "general" }),

  triage({
    id: "mail.next",
    keys: "j",
    scopes: MAIL,
    labelKey: "keys.next",
    group: "navigate",
    repeatable: true,
  }),
  triage({
    id: "mail.prev",
    keys: "k",
    scopes: LIST_AND_READER,
    labelKey: "keys.prev",
    group: "navigate",
    repeatable: true,
  }),
  triage({
    id: "mail.open",
    keys: ["o", "Enter"],
    scopes: LIST,
    labelKey: "keys.open",
    group: "navigate",
  }),
  triage({
    id: "mail.back",
    keys: "Escape",
    scopes: MAIL,
    labelKey: "keys.back",
    group: "navigate",
  }),
  triage({
    id: "mail.search",
    keys: "/",
    scopes: LIST,
    labelKey: "keys.search",
    group: "navigate",
  }),

  triage({
    id: "mail.done",
    keys: "e",
    scopes: MAIL,
    labelKey: "keys.done",
    group: "triage",
    palette: true,
  }),
  triage({
    id: "mail.reply",
    keys: "r",
    scopes: MAIL,
    labelKey: "keys.reply",
    group: "triage",
    palette: true,
  }),
  triage({
    id: "mail.compose",
    keys: "c",
    scopes: LIST,
    labelKey: "keys.compose",
    group: "triage",
    palette: true,
  }),
  triage({
    id: "mail.undo",
    keys: ["z", "mod+z"],
    scopes: MAIL,
    labelKey: "keys.undo",
    group: "triage",
    palette: true,
  }),

  ...laneDefs,

  triage({
    id: "select.toggle",
    keys: "x",
    scopes: LIST,
    labelKey: "keys.select",
    group: "select",
    palette: true,
  }),
  triage({
    id: "select.extendDown",
    keys: "shift+j",
    scopes: LIST,
    labelKey: "keys.extendDown",
    group: "select",
    repeatable: true,
  }),
  triage({
    id: "select.extendUp",
    keys: "shift+k",
    scopes: LIST,
    labelKey: "keys.extendUp",
    group: "select",
    repeatable: true,
  }),

  // Destinations that exist today only. `g f` (Files) joins when that route
  // ships (P12). `g t` (Today) and `g a` as Assistant are live under
  // UNIFIED_HOME; without it `g a` is the decision queue, as before.
  destination(
    { id: "go.today", keys: "g t", scopes: GLOBAL, labelKey: "keys.go.today", group: "go" },
    true,
  ),
  triage({ id: "go.mail", keys: "g m", scopes: GLOBAL, labelKey: "keys.go.mail", group: "go" }),
  triage({
    id: "go.calendar",
    keys: "g c",
    scopes: GLOBAL,
    labelKey: "keys.go.calendar",
    group: "go",
  }),
  destination(
    { id: "go.queue", keys: "g a", scopes: GLOBAL, labelKey: "keys.go.queue", group: "go" },
    false,
  ),
  destination(
    {
      id: "go.assistant",
      keys: "g a",
      scopes: GLOBAL,
      labelKey: "keys.go.assistant",
      group: "go",
    },
    true,
  ),
  triage({
    id: "go.briefing",
    keys: "g b",
    scopes: GLOBAL,
    labelKey: "keys.go.briefing",
    group: "go",
  }),
  triage({
    id: "go.settings",
    keys: "g s",
    scopes: GLOBAL,
    labelKey: "keys.go.settings",
    group: "go",
  }),
];

/** The fields of a KeyboardEvent the matcher reads. */
export interface KeyEventLike {
  key: string;
  /** Physical key ("KeyJ", "Digit1", "Slash"); the fallback for non-Latin layouts. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
}

/** The fields of an event target the guards read. */
export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  role?: string | null;
}

/** <input> types that take no text, so a letter key is not "typing" there. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
]);

/** Focus is somewhere a keystroke is text: input, textarea, select, contenteditable. */
export function isTypingTarget(target: KeyTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
  return target.role === "textbox" || target.role === "combobox" || target.role === "searchbox";
}

const ACTIVATABLE_TAGS: ReadonlySet<string> = new Set(["A", "BUTTON", "SUMMARY", "INPUT"]);
const ACTIVATABLE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "option",
  "menuitem",
  "tab",
  "checkbox",
  "switch",
]);

/** Focus is on a control that Enter activates natively; Enter belongs to it. */
export function isActivatableTarget(target: KeyTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (ACTIVATABLE_TAGS.has((target.tagName ?? "").toUpperCase())) return true;
  return typeof target.role === "string" && ACTIVATABLE_ROLES.has(target.role);
}

/** An IME is composing (Korean, Japanese, Chinese input): the key is text. */
export function isComposingEvent(event: KeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.key === "Process";
}

const CODE_SYMBOLS: Readonly<Record<string, readonly [plain: string, shifted: string]>> = {
  Slash: ["/", "?"],
};

/**
 * The character a flag-gated chord is matched against.
 *
 * A Latin layout is matched by the CHARACTER it produces, so Dvorak, AZERTY
 * and Colemak users press the letter printed on their key, and an accented or
 * dotless Latin letter is never mistaken for another key. A non-Latin layout
 * (Korean 2-set typing `ㅓ` on the J key, Russian, Greek) produces a character
 * no hotkey names, so it falls back to the key's POSITION via `event.code`,
 * which is how the Mac app resolves the same shortcuts. Named keys (Escape,
 * Enter) and anything ASCII are left alone. Composition never reaches here:
 * hotkeyBlockReason refuses it first.
 */
const LATIN_SCRIPT = /\p{Script=Latin}/u;

export function effectiveKey(event: KeyEventLike): string {
  const { key, code } = event;
  const isSingleChar = [...key].length === 1;
  if (!isSingleChar || key.charCodeAt(0) < 0x80 || !code) return key;
  // A Latin-script character beyond ASCII is still a Latin layout typing what
  // it means to type: AZERTY's digit row gives é è ç à, Turkish has ı on the I
  // key. Position would turn those into 2 / 7 / 9 / 0 and i.
  if (LATIN_SCRIPT.test(key)) return key;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return event.shiftKey ? letter[1] : letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const symbol = CODE_SYMBOLS[code];
  if (symbol) return event.shiftKey ? symbol[1] : symbol[0];
  return key;
}

interface Chord {
  key: string;
  mod: boolean;
  shift: boolean;
}

function parseChord(chord: string): Chord {
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  return { key, mod: mods.includes("mod"), shift: mods.includes("shift") };
}

const isLetter = (key: string) => key.length === 1 && key.toLowerCase() !== key.toUpperCase();

/**
 * Strict match for flag-gated chords: Alt never, Cmd/Ctrl only when the chord
 * names `mod`, and Shift must agree for letters (so `j` and `shift+j` are
 * different keys). For symbols and named keys Shift is part of how the
 * character is typed (`?` is Shift+/ on a US layout), so it is not compared.
 */
function matchesChord(chord: Chord, event: KeyEventLike): boolean {
  if (event.altKey) return false;
  if ((event.metaKey || event.ctrlKey) !== chord.mod) return false;
  const key = effectiveKey(event);
  if (isLetter(chord.key)) {
    return key.toLowerCase() === chord.key && event.shiftKey === chord.shift;
  }
  if (/^[0-9]$/.test(chord.key)) return key === chord.key && !event.shiftKey;
  return key === chord.key;
}

/** The pre-flag rule, kept byte for byte: Cmd or Ctrl, and the exact key. */
function matchesLegacy(def: HotkeyDef, event: KeyEventLike): boolean {
  const chord = parseChord(def.keys[0]);
  return (event.metaKey || event.ctrlKey) && event.key === chord.key;
}

/** The legacy entry this event triggers, if any. Checked before every guard. */
export function matchLegacyHotkey(
  event: KeyEventLike,
  defs: readonly HotkeyDef[] = HOTKEYS,
): HotkeyDef | null {
  return defs.find((def) => def.legacy && matchesLegacy(def, event)) ?? null;
}

/**
 * Why a flag-gated key must not fire, or null when it may. `modalOpen` covers
 * every overlay (lib/modal-stack and any aria-modal dialog): an open modal owns
 * the keyboard, including Escape.
 */
export function hotkeyBlockReason(
  event: KeyEventLike,
  target: KeyTargetLike | null | undefined,
  modalOpen: boolean,
): "composing" | "typing" | "modal" | null {
  if (isComposingEvent(event)) return "composing";
  if (isTypingTarget(target)) return "typing";
  if (modalOpen) return "modal";
  return null;
}

/** How long the first chord of a sequence (`g`) waits for the second. */
export const SEQUENCE_TIMEOUT_MS = 1000;

export type HotkeyMatch =
  | { kind: "match"; def: HotkeyDef }
  /** First chord of a sequence was consumed; waiting for the second. */
  | { kind: "pending" }
  | { kind: "none" };

export interface HotkeyMatcher {
  /** Feed one keydown. `enabled` filters the table to the live entries. */
  feed(
    event: KeyEventLike,
    target: KeyTargetLike | null | undefined,
    enabled: (def: HotkeyDef) => boolean,
    now: number,
  ): HotkeyMatch;
  reset(): void;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** Stateful only for two-chord sequences; everything else is a table lookup. */
export function createHotkeyMatcher(defs: readonly HotkeyDef[] = HOTKEYS): HotkeyMatcher {
  let prefix: { key: string; at: number } | null = null;

  const candidates = (enabled: (def: HotkeyDef) => boolean) =>
    defs.filter((def) => !def.legacy && enabled(def));

  const usable = (def: HotkeyDef, event: KeyEventLike, target: KeyTargetLike | null | undefined) =>
    (!event.repeat || def.repeatable === true) &&
    // Enter on a focused button or link activates that control, not a hotkey.
    !(event.key === "Enter" && isActivatableTarget(target));

  return {
    feed(event, target, enabled, now) {
      // A bare modifier press is not a key of its own; it must not break `g m`.
      if (MODIFIER_KEYS.has(event.key)) return { kind: "none" };
      const live = candidates(enabled);
      const held = prefix && now - prefix.at <= SEQUENCE_TIMEOUT_MS ? prefix.key : null;
      prefix = null;

      if (held) {
        const second = live.find((def) =>
          def.keys.some((keys) => {
            const [first, next] = keys.split(" ");
            return next !== undefined && first === held && matchesChord(parseChord(next), event);
          }),
        );
        if (second && !event.repeat) return { kind: "match", def: second };
      }

      const single = live.find((def) =>
        def.keys.some((keys) => !keys.includes(" ") && matchesChord(parseChord(keys), event)),
      );
      if (single)
        return usable(single, event, target) ? { kind: "match", def: single } : { kind: "none" };

      const opensSequence = live.some((def) =>
        def.keys.some((keys) => {
          const [first, next] = keys.split(" ");
          return next !== undefined && matchesChord(parseChord(first), event);
        }),
      );
      if (opensSequence && !event.repeat) {
        prefix = { key: effectiveKey(event).toLowerCase(), at: now };
        return { kind: "pending" };
      }
      return { kind: "none" };
    },
    reset() {
      prefix = null;
    },
  };
}

/** Key caps for display: "mod+k" → ["⌘", "K"] on a Mac, ["Ctrl", "K"] elsewhere. */
export function hotkeyCaps(keys: string, isMac: boolean): string[] {
  const NAMED: Record<string, string> = { Escape: "Esc", Enter: "Enter" };
  return keys.split(" ").flatMap((chord) =>
    chord.split("+").map((part) => {
      if (part === "mod") return isMac ? "⌘" : "Ctrl";
      if (part === "shift") return "Shift";
      return NAMED[part] ?? (part.length === 1 ? part.toUpperCase() : part);
    }),
  );
}

export interface HotkeyHandler {
  run: () => void;
  /** A reason the action is unavailable right now; shown instead of running. */
  disabledReason?: () => string | null;
}

export interface HotkeyRegistry {
  /** Mount a surface's handlers; the returned function unmounts them. */
  register(scope: HotkeyScope, handlers: Readonly<Record<string, HotkeyHandler>>): () => void;
  /** The handler for an id; the most recently mounted surface wins. */
  resolve(id: string): HotkeyHandler | undefined;
  activeScopes(): ReadonlySet<HotkeyScope>;
}

export function createHotkeyRegistry(): HotkeyRegistry {
  type Entry = { scope: HotkeyScope; handlers: Readonly<Record<string, HotkeyHandler>> };
  let entries: readonly Entry[] = [];
  return {
    register(scope, handlers) {
      const entry: Entry = { scope, handlers };
      entries = [...entries, entry];
      return () => {
        entries = entries.filter((e) => e !== entry);
      };
    },
    resolve(id) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const handler = entries[i].handlers[id];
        if (handler) return handler;
      }
      return undefined;
    },
    activeScopes() {
      return new Set<HotkeyScope>(["global", ...entries.map((e) => e.scope)]);
    },
  };
}

/** The app-wide registry. Surfaces mount handlers through lib/use-hotkeys. */
export const hotkeyRegistry = createHotkeyRegistry();

export interface LiveHotkey {
  def: HotkeyDef;
  handler: HotkeyHandler;
}

/** Entries that are enabled and have a mounted handler: what the sheet and palette list. */
export function liveHotkeys(
  ctx: HotkeyContext,
  registry: HotkeyRegistry = hotkeyRegistry,
  defs: readonly HotkeyDef[] = HOTKEYS,
): LiveHotkey[] {
  return defs.flatMap((def) => {
    if (!def.enabled(ctx)) return [];
    const handler = registry.resolve(def.id);
    return handler ? [{ def, handler }] : [];
  });
}
