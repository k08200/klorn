/**
 * Mail's sheets: the lane sheet (LaneSheet artboard), the account filter, the
 * row actions (the non-gesture path to every swipe), Later (snooze) and the
 * Mail menu. All are ui/Sheet: a bottom sheet on phones, a dialog on wider
 * windows, with focus trap, Escape / back to close and drag-to-dismiss.
 */
import type { InboxOption, LiveTier } from "@klorn/contract";
import { useEffect, useId, useState } from "react";
import type { InboxScope } from "../../api/endpoints";
import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { MailGlyph, type MailGlyphName } from "../../ui/MailGlyph";
import { Sheet } from "../../ui/Sheet";
import { SourceBadge } from "../../ui/SourceBadge";
import { Switch } from "../../ui/Switch";
import type { MailTarget } from "./controller";
import { loadLaneMoves, senderKey } from "./lane-history";
import {
  canSubmit,
  initialLane,
  type LaneMove,
  type LaneSheetOrigin,
  SHEET_LANES,
  senderLabel,
  suggestsPin,
} from "./lane-sheet-model";
import { splitSender } from "./model";
import { type SnoozePreset, snoozeOptions } from "./snooze";

const LANE_DESC: Record<LiveTier, MessageKey> = {
  PUSH: "lane.desc.push",
  MEETING: "lane.desc.meeting",
  QUEUE: "lane.desc.queue",
  INFO: "lane.desc.info",
  SILENT: "lane.desc.silent",
};

const MOVE_TO: Record<LiveTier, MessageKey> = {
  PUSH: "lane.moveTo.push",
  MEETING: "lane.moveTo.meeting",
  QUEUE: "lane.moveTo.queue",
  INFO: "lane.moveTo.info",
  SILENT: "lane.moveTo.silent",
};

// ── Lane sheet ──────────────────────────────────────────────────────────────

export interface LaneSheetRequest {
  targets: MailTarget[];
  origin: LaneSheetOrigin;
}

export function LaneSheet({
  request,
  onClose,
  onSubmit,
}: {
  request: LaneSheetRequest | null;
  onClose: () => void;
  onSubmit: (tier: LiveTier, pin: boolean) => Promise<boolean>;
}) {
  const { t, tn } = useI18n();
  const groupId = useId();
  const pinId = useId();
  const targets = request?.targets ?? [];
  const single = targets.length === 1 ? targets[0] : undefined;
  // The current lane when every target shares one.
  const lanes = new Set(targets.map((m) => m.tier));
  const current = lanes.size === 1 ? (targets[0]?.tier ?? null) : null;
  const [selected, setSelected] = useState<LiveTier>("SILENT");
  const [pin, setPin] = useState(false);
  // Once the user flips the toggle, the second-move suggestion stops steering it.
  const [pinTouched, setPinTouched] = useState(false);
  const [moves, setMoves] = useState<{ sender: string | null; history: LaneMove[] }>({
    sender: null,
    history: [],
  });
  const [busy, setBusy] = useState(false);
  const key = request ? `${request.origin}:${targets.map((m) => m.id).join(",")}` : "";

  useEffect(() => {
    if (!request) return;
    setSelected(initialLane(request.origin, current));
    setPin(false);
    setPinTouched(false);
    setMoves({ sender: null, history: [] });
    setBusy(false);
    // The suggestion is for ONE sender; a mixed selection never pre-pins.
    const addresses = new Set(targets.map((m) => m.from.trim().toLowerCase()));
    const only = addresses.size === 1 ? targets[0] : undefined;
    let alive = true;
    if (only) {
      void Promise.all([senderKey(only.from), loadLaneMoves()]).then(([sender, history]) => {
        if (alive) setMoves({ sender, history });
      });
    }
    return () => {
      alive = false;
    };
    // A new request (a different row, a different origin) starts fresh.
  }, [key]);

  useEffect(() => {
    if (!request || pinTouched) return;
    setPin(suggestsPin(moves.history, moves.sender, selected, Date.now()));
  }, [moves, selected, pinTouched, request]);

  const senders = new Set(targets.map((m) => senderLabel(m.from)));
  const senderName = senders.size === 1 ? splitSender([...senders][0] ?? "").name : null;
  const subtitle = single
    ? `${senderLabel(single.from)} · ${single.subject || t("mail.noSubject")}`
    : tn("mail.select.count", targets.length);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onSubmit(selected, pin);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={request !== null}
      onClose={onClose}
      initialFocus={() =>
        document.querySelector<HTMLInputElement>(`input[name="${CSS.escape(groupId)}"]:checked`)
      }
      title={t("lane.sheet.title")}
      subtitle={subtitle}
      footer={
        <>
          <button
            type="button"
            className="sheet-cta"
            disabled={busy || !canSubmit({ selected, pin }, current)}
            onClick={() => void submit()}
          >
            {selected === current && pin ? t("lane.pinOnly") : t(MOVE_TO[selected])}
          </button>
          <p className="lane-sheet__learn">{t("lane.learns")}</p>
        </>
      }
    >
      <fieldset className="lane-options">
        <legend className="sr-only">{t("lane.sheet.legend")}</legend>
        {SHEET_LANES.map((lane) => {
          const on = selected === lane;
          return (
            <label
              key={lane}
              className="lane-option"
              data-on={on || undefined}
              htmlFor={`${groupId}-${lane}`}
            >
              <span
                className={`lane-option__swatch lane-dot--${lane.toLowerCase()}`}
                aria-hidden="true"
              />
              <span className="lane-option__text">
                <span className="lane-option__name-row">
                  <span className={`lane-option__name lane-ink--${lane.toLowerCase()}`}>
                    {lane}
                  </span>
                  {request?.origin === "swipe" && lane === "SILENT" && current !== "SILENT" ? (
                    <span className="lane-option__tag">{t("lane.swipeDefault")}</span>
                  ) : null}
                  {lane === current ? (
                    <span className="lane-option__tag lane-option__tag--current">
                      {t("lane.current")}
                    </span>
                  ) : null}
                </span>
                <span className="lane-option__desc">{t(LANE_DESC[lane])}</span>
              </span>
              <input
                id={`${groupId}-${lane}`}
                type="radio"
                name={groupId}
                className="lane-option__radio"
                checked={on}
                onChange={() => setSelected(lane)}
              />
            </label>
          );
        })}
      </fieldset>
      <label className="pin-toggle" htmlFor={pinId}>
        <span className="pin-toggle__text">
          <span className="pin-toggle__title">
            {senderName ? t("lane.pin.title", { sender: senderName }) : t("lane.pin.titleMany")}
          </span>
          <span className="pin-toggle__hint">{t("lane.pin.hint")}</span>
        </span>
        <Switch
          id={pinId}
          checked={pin}
          onChange={(next) => {
            setPinTouched(true);
            setPin(next);
          }}
        />
      </label>
    </Sheet>
  );
}

// ── Account filter ──────────────────────────────────────────────────────────

const PURPOSE: Record<string, MessageKey> = {
  work: "mail.account.purpose.work",
  personal: "mail.account.purpose.personal",
  mixed: "mail.account.purpose.mixed",
};

export function AccountSheet({
  open,
  inbox,
  inboxes,
  onClose,
  onChoose,
}: {
  open: boolean;
  inbox: InboxScope;
  inboxes: readonly InboxOption[];
  onClose: () => void;
  onChoose: (inbox: InboxScope) => void;
}) {
  const { t, tn } = useI18n();
  const choose = (scope: InboxScope) => {
    onChoose(scope);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("mail.account.title")}
      subtitle={t("mail.account.subtitle")}
    >
      <ul className="choice-list" aria-label={t("mail.account.title")}>
        <li>
          <button
            type="button"
            className="choice"
            aria-pressed={inbox === "all"}
            onClick={() => choose("all")}
          >
            <span className="choice__stack" aria-hidden="true">
              {inboxes.slice(0, 3).map((i) => (
                <span key={i.id ?? "primary"} className="account-button__badge">
                  <SourceBadge inbox={i} size={22} />
                </span>
              ))}
            </span>
            <span className="choice__text">
              <span className="choice__title">{t("mail.account.all")}</span>
              <span className="choice__sub">{tn("mail.account.count", inboxes.length)}</span>
            </span>
            {inbox === "all" ? <MailGlyph name="done" size={20} className="choice__check" /> : null}
          </button>
        </li>
        {inboxes.map((i) => {
          const scope = i.id ?? "primary";
          const on = inbox === scope;
          const purpose = i.purpose ? PURPOSE[i.purpose] : undefined;
          return (
            <li key={scope}>
              <button
                type="button"
                className="choice"
                aria-pressed={on}
                onClick={() => choose(scope)}
              >
                <SourceBadge inbox={i} size={28} />
                <span className="choice__text">
                  <span className="choice__title">{i.email ?? t("mail.account.primary")}</span>
                  <span className="choice__sub">
                    {[
                      i.kind === "primary" ? t("mail.account.primary") : null,
                      purpose ? t(purpose) : null,
                      i.needsReconnect ? t("accounts.needsReconnect") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {on ? <MailGlyph name="done" size={20} className="choice__check" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

// ── Row actions (the non-gesture path) ──────────────────────────────────────

export interface ActionItem {
  key: string;
  icon: MailGlyphName;
  label: string;
  hint?: string;
  run: () => void;
}

export function ActionSheet({
  open,
  title,
  subtitle,
  items,
  onClose,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  items: ActionItem[];
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} subtitle={subtitle}>
      <ul className="choice-list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className="choice"
              onClick={() => {
                onClose();
                item.run();
              }}
            >
              <span className="choice__icon" aria-hidden="true">
                <MailGlyph name={item.icon} size={22} />
              </span>
              <span className="choice__text">
                <span className="choice__title">{item.label}</span>
                {item.hint ? <span className="choice__sub">{item.hint}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

// ── Later (snooze) ──────────────────────────────────────────────────────────

const SNOOZE_LABEL: Record<SnoozePreset, MessageKey> = {
  laterToday: "mail.later.laterToday",
  thisEvening: "mail.later.thisEvening",
  tomorrowMorning: "mail.later.tomorrowMorning",
  weekend: "mail.later.weekend",
  nextWeek: "mail.later.nextWeek",
};

export function SnoozeSheet({
  target,
  now,
  onClose,
  onChoose,
}: {
  target: MailTarget | null;
  now: Date;
  onClose: () => void;
  onChoose: (until: Date) => void;
}) {
  const { t, intlTag } = useI18n();
  const options = snoozeOptions(now);
  const when = (d: Date) =>
    new Intl.DateTimeFormat(intlTag, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={t("mail.later.title")}
      subtitle={target ? `${senderLabel(target.from)} · ${target.subject}` : undefined}
      footer={<p className="lane-sheet__learn">{t("mail.later.note")}</p>}
    >
      <ul className="choice-list">
        {options.map((o) => (
          <li key={o.preset}>
            <button
              type="button"
              className="choice"
              onClick={() => {
                onChoose(o.until);
                onClose();
              }}
            >
              <span className="choice__icon" aria-hidden="true">
                <MailGlyph name="later" size={22} />
              </span>
              <span className="choice__text">
                <span className="choice__title">{t(SNOOZE_LABEL[o.preset])}</span>
              </span>
              <span className="choice__trail">{when(o.until)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
