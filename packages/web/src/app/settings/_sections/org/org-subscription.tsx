"use client";

import type {
  OrgBillingAccessWire,
  OrgBillingPortalResponse,
  OrgCancelResponse,
  OrgResumeResponse,
  OrgSeatChangeResponse,
  OrgWire,
} from "@klorn/contract";
import { useState } from "react";
import { useConfirm } from "../../../../components/confirm-dialog";
import Button from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { apiFetch } from "../../../../lib/api";
import { isSafeBillingRedirect } from "../../../../lib/billing-redirect";
import { useT } from "../../../../lib/i18n";
import { formatBillingDate } from "../../../../lib/subscription";
import {
  canKeepSubscription,
  canOpenPortal,
  MAX_SEATS,
  parseSeatsFrom,
  seatCeiling,
  seatFloor,
  seatNoteKey,
  subscriptionActions,
} from "./model";
import { useOrgAction } from "./use-org";

const POST_EMPTY: RequestInit = { method: "POST", body: JSON.stringify({}) };

/** A typed seat count this owner can ask for: from `floor` to `ceiling`, or null. */
function seatsWithin(raw: string, floor: number, ceiling: number): number | null {
  const seats = parseSeatsFrom(raw, floor);
  return seats !== null && seats <= ceiling ? seats : null;
}

/**
 * The seat count field: at least two and one per member, at most 150, and at
 * most what this owner can add (`ceiling`, from `me.billing`): adding seats
 * charges the card at once, so it is the payer's, and a recorded payer whose
 * email Paddle does not bill is capped. The field says so up front; the
 * server's refusal names who can.
 */
function SeatCountField({
  floor,
  ceiling,
  noteKey,
  value,
  onChange,
}: {
  floor: number;
  ceiling: number;
  noteKey: string | null;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useT();
  const valid = seatsWithin(value, floor, ceiling) !== null;
  const tooMany = Number(value) > MAX_SEATS;
  const overCeiling = Number(value) > ceiling;
  const hint = t("settings.org.seats.floor", { min: String(floor) });
  const note = noteKey ? t(noteKey, { max: String(ceiling) }) : null;
  const error = valid
    ? undefined
    : tooMany
      ? t("settings.org.error.INVALID_SEATS")
      : overCeiling && note
        ? note
        : hint;
  return (
    <div className="space-y-2">
      <Input
        id="org-seat-change"
        type="number"
        inputMode="numeric"
        min={floor}
        max={ceiling}
        label={t("settings.org.seats.change", { min: String(floor), max: String(MAX_SEATS) })}
        value={value}
        error={error}
        onChange={(event) => onChange(event.target.value)}
      />
      {valid && <p className="text-role-caption text-ink-dim">{hint}</p>}
      {note && error !== note && <p className="text-role-caption text-ink-dim">{note}</p>}
    </div>
  );
}

/**
 * When a scheduled cancel ends the subscription, and (unless the server says
 * this owner can) who may keep it: the payer, or the owner who set it to end.
 */
function EndingNotice({
  cancelAt,
  showKeepRule,
}: {
  cancelAt: string | null;
  showKeepRule: boolean;
}) {
  const { t, locale } = useT();
  const endDate = formatBillingDate(cancelAt, locale);
  return (
    <>
      <p className="text-role-body text-ink-mid">
        {endDate
          ? t("settings.org.subscription.endsOn", { date: endDate })
          : t("settings.org.subscription.endsSoon")}
      </p>
      {showKeepRule && (
        <p id="org-keep-note" className="text-role-caption text-ink-dim">
          {t("settings.org.subscription.keepPayerOnly")}
        </p>
      )}
    </>
  );
}

/**
 * Owner only, once a team subscription exists: change the seat count, cancel
 * at the period end (or keep the subscription), open the Paddle portal.
 * Adding seats is the payer's (capped for a recorded payer whose email Paddle
 * does not bill), keeping a canceled subscription is the payer's or the
 * canceling owner's, and the portal is the paying email's. `billing` (the
 * server's word on this owner) explains that before a click; without it the
 * general rule is shown. The server enforces every rule again
 * (org/seat-management.ts); a seat change shows as pending until Paddle's
 * webhook moves the stored count.
 */
export function OrgSubscription({
  org,
  billing,
  onChanged,
}: {
  org: OrgWire;
  billing: OrgBillingAccessWire | undefined;
  onChanged: () => Promise<void>;
}) {
  const { t } = useT();
  const { confirm } = useConfirm();
  const floor = seatFloor(org.seats.used);
  const [seatsText, setSeatsText] = useState(() => String(Math.max(floor, org.seats.purchased)));
  const [note, setNote] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const { busy, errorKey, run } = useOrgAction();
  const actions = subscriptionActions(org.seats);
  const ceiling = seatCeiling(org.seats.purchased, billing);
  const seats = seatsWithin(seatsText, floor, ceiling);
  const keepable = canKeepSubscription(billing);
  const portalOpens = canOpenPortal(billing);

  /** One action at a time; each starts from a clean slate of notes. */
  const act = (work: () => Promise<unknown>) => {
    setNote(null);
    setRefused(false);
    return run(work);
  };

  const changeSeats = async () => {
    const answer: { note?: string } = {};
    const ok = await act(async () => {
      if (seats === null) return;
      const result = await apiFetch<OrgSeatChangeResponse>("/api/orgs/current/seats", {
        method: "POST",
        body: JSON.stringify({ seats }),
      });
      const key =
        result.status === "pending" ? "settings.org.seats.pending" : "settings.org.seats.unchanged";
      answer.note = t(key, { seats: String(result.seats) });
    });
    if (!ok || answer.note === undefined) return;
    // The cap and the counts move with the change: reload them, then say so.
    await onChanged();
    setNote(answer.note);
  };

  const cancel = async () => {
    const ok = await confirm({
      title: t("settings.org.subscription.cancelTitle"),
      message: t("settings.org.subscription.cancelMessageNoDate"),
      confirmLabel: t("settings.org.subscription.cancelConfirm"),
      // Never "Cancel" here: it would read as confirming the cancellation.
      dismissLabel: t("settings.org.subscription.keep"),
      danger: true,
    });
    if (!ok) return;
    const path = "/api/orgs/current/subscription/cancel";
    if (await act(() => apiFetch<OrgCancelResponse>(path, POST_EMPTY))) await onChanged();
  };

  const resume = async () => {
    const path = "/api/orgs/current/subscription/resume";
    if (await act(() => apiFetch<OrgResumeResponse>(path, POST_EMPTY))) await onChanged();
  };

  const openPortal = () =>
    act(async () => {
      const path = "/api/orgs/current/billing-portal";
      const { url } = await apiFetch<OrgBillingPortalResponse>(path, POST_EMPTY);
      // Only Paddle's portal (or this origin) is followed.
      if (!isSafeBillingRedirect(url, window.location.origin)) {
        setRefused(true);
        return;
      }
      setLeaving(true);
      window.location.assign(url);
    });

  const disabled = busy || leaving;

  return (
    <div className="space-y-3">
      {actions.resume && (
        <EndingNotice cancelAt={org.seats.cancelAt} showKeepRule={billing?.canResume !== true} />
      )}
      {actions.changeSeats && (
        <SeatCountField
          floor={floor}
          ceiling={ceiling}
          noteKey={seatNoteKey(billing, org.seats.purchased)}
          value={seatsText}
          onChange={setSeatsText}
        />
      )}
      {actions.portal && !portalOpens && (
        <p id="org-portal-note" className="text-role-caption text-ink-dim">
          {t("settings.org.subscription.portalPayerOnly")}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {actions.changeSeats && (
          <Button disabled={disabled || seats === null} onClick={() => void changeSeats()}>
            {t("settings.org.seats.changeAction")}
          </Button>
        )}
        {actions.resume && (
          <Button
            disabled={disabled || !keepable}
            aria-describedby={keepable ? undefined : "org-keep-note"}
            onClick={() => void resume()}
          >
            {t("settings.org.subscription.keep")}
          </Button>
        )}
        {actions.portal && (
          <Button
            variant="secondary"
            disabled={disabled || !portalOpens}
            aria-describedby={portalOpens ? undefined : "org-portal-note"}
            onClick={() => void openPortal()}
          >
            {t("settings.org.subscription.portal")}
          </Button>
        )}
        {actions.cancel && (
          <Button variant="ghost" disabled={disabled} onClick={() => void cancel()}>
            {t("settings.org.subscription.cancel")}
          </Button>
        )}
      </div>
      {note && (
        <p role="status" className="text-role-caption text-ink-mid">
          {note}
        </p>
      )}
      {(errorKey || refused) && (
        <p role="alert" className="text-role-caption text-ink-mid">
          {t(errorKey ?? "settings.org.error.generic")}
        </p>
      )}
    </div>
  );
}
