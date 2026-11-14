"use client";

import type {
  OrgBillingPortalResponse,
  OrgCancelResponse,
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

/**
 * Owner only, once a team subscription exists: change the seat count, cancel
 * at the period end (or keep the subscription), open the Paddle portal. The
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

  const changeSeats = () =>
    run(async () => {
      if (seats === null) return;
      setNote(null);
      const result = await apiFetch<OrgSeatChangeResponse>("/api/orgs/current/seats", {
        method: "POST",
        body: JSON.stringify({ seats }),
      });
      setNote(
        t(
          result.status === "pending"
            ? "settings.org.seats.pending"
            : "settings.org.seats.unchanged",
          { seats: String(result.seats) },
        ),
      );
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
    const done = await run(() =>
      apiFetch<OrgCancelResponse>("/api/orgs/current/subscription/cancel", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (done) await onChanged();
  };

  const resume = async () => {
    const done = await run(() =>
      apiFetch<{ resumed: true }>("/api/orgs/current/subscription/resume", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (done) await onChanged();
  };

  const openPortal = () =>
    run(async () => {
      setRefused(false);
      const { url } = await apiFetch<OrgBillingPortalResponse>("/api/orgs/current/billing-portal", {
        method: "POST",
        body: JSON.stringify({}),
      });
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
        <p className="text-role-body text-ink-mid">
          {endDate
            ? t("settings.org.subscription.endsOn", { date: endDate })
            : t("settings.org.subscription.endsSoon")}
        </p>
      )}
      {actions.changeSeats && (
        <div className="space-y-2">
          <Input
            id="org-seat-change"
            type="number"
            inputMode="numeric"
            min={floor}
            max={MAX_SEATS}
            label={t("settings.org.seats.change", { min: String(floor), max: String(MAX_SEATS) })}
            value={seatsText}
            error={
              seats === null ? t("settings.org.seats.floor", { min: String(floor) }) : undefined
            }
            onChange={(event) => setSeatsText(event.target.value)}
          />
          {seats !== null && (
            <p className="text-role-caption text-ink-dim">
              {t("settings.org.seats.floor", { min: String(floor) })}
            </p>
          )}
        </div>
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
