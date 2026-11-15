"use client";

import type {
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
import { MAX_SEATS, parseSeatsFrom, seatFloor, subscriptionActions } from "./model";
import { useOrgAction } from "./use-org";

const POST_EMPTY: RequestInit = { method: "POST", body: JSON.stringify({}) };

/**
 * The seat count field: at least two and one per member, at most 150. Adding
 * seats is the payer's alone (it charges their card at once); the field says
 * so up front, and the server's refusal names who can.
 */
function SeatCountField({
  floor,
  value,
  onChange,
}: {
  floor: number;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useT();
  const valid = parseSeatsFrom(value, floor) !== null;
  const tooMany = Number(value) > MAX_SEATS;
  const hint = t("settings.org.seats.floor", { min: String(floor) });
  return (
    <div className="space-y-2">
      <Input
        id="org-seat-change"
        type="number"
        inputMode="numeric"
        min={floor}
        max={MAX_SEATS}
        label={t("settings.org.seats.change", { min: String(floor), max: String(MAX_SEATS) })}
        value={value}
        error={valid ? undefined : tooMany ? t("settings.org.error.INVALID_SEATS") : hint}
        onChange={(event) => onChange(event.target.value)}
      />
      {valid && <p className="text-role-caption text-ink-dim">{hint}</p>}
      <p className="text-role-caption text-ink-dim">{t("settings.org.seats.payerOnly")}</p>
    </div>
  );
}

/**
 * Owner only, once a team subscription exists: change the seat count, cancel
 * at the period end (or keep the subscription), open the Paddle portal.
 * Adding seats, keeping a canceled subscription and the portal are the
 * payer's alone; the page says so and the server enforces it. The
 * server enforces every rule again (org/seat-management.ts); a seat change
 * shows as pending until Paddle's webhook moves the stored count.
 */
export function OrgSubscription({
  org,
  onChanged,
}: {
  org: OrgWire;
  onChanged: () => Promise<void>;
}) {
  const { t, locale } = useT();
  const { confirm } = useConfirm();
  const floor = seatFloor(org.seats.used);
  const [seatsText, setSeatsText] = useState(() => String(Math.max(floor, org.seats.purchased)));
  const [note, setNote] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const { busy, errorKey, run } = useOrgAction();
  const actions = subscriptionActions(org.seats);
  const seats = parseSeatsFrom(seatsText, floor);
  const endDate = formatBillingDate(org.seats.cancelAt, locale);

  /** One action at a time; each starts from a clean slate of notes. */
  const act = (work: () => Promise<unknown>) => {
    setNote(null);
    setRefused(false);
    return run(work);
  };

  const changeSeats = () =>
    act(async () => {
      if (seats === null) return;
      const result = await apiFetch<OrgSeatChangeResponse>("/api/orgs/current/seats", {
        method: "POST",
        body: JSON.stringify({ seats }),
      });
      const key =
        result.status === "pending" ? "settings.org.seats.pending" : "settings.org.seats.unchanged";
      setNote(t(key, { seats: String(result.seats) }));
    });

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
        <>
          <p className="text-role-body text-ink-mid">
            {endDate
              ? t("settings.org.subscription.endsOn", { date: endDate })
              : t("settings.org.subscription.endsSoon")}
          </p>
          <p className="text-role-caption text-ink-dim">
            {t("settings.org.subscription.keepPayerOnly")}
          </p>
        </>
      )}
      {actions.changeSeats && (
        <SeatCountField floor={floor} value={seatsText} onChange={setSeatsText} />
      )}
      <div className="flex flex-wrap gap-3">
        {actions.changeSeats && (
          <Button disabled={disabled || seats === null} onClick={() => void changeSeats()}>
            {t("settings.org.seats.changeAction")}
          </Button>
        )}
        {actions.resume && (
          <Button disabled={disabled} onClick={() => void resume()}>
            {t("settings.org.subscription.keep")}
          </Button>
        )}
        {actions.portal && (
          <Button variant="secondary" disabled={disabled} onClick={() => void openPortal()}>
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
