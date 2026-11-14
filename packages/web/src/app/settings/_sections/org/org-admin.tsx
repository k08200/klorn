"use client";

import type { OrgCheckoutResponse, OrgWire, TeamIntervalWire } from "@klorn/contract";
import { useState } from "react";
import Button from "../../../../components/ui/button";
import { Input, Select } from "../../../../components/ui/input";
import Switch from "../../../../components/ui/switch";
import { apiFetch } from "../../../../lib/api";
import { isSafeBillingRedirect } from "../../../../lib/billing-redirect";
import { useT } from "../../../../lib/i18n";
import {
  CAP_OPTIONS,
  capFromOption,
  clampSeats,
  defaultSeats,
  formatUsd,
  MAX_SEATS,
  MIN_SEATS,
  parseSeats,
  seatStatusKey,
} from "./model";
import { useOrgAction } from "./use-org";

/** Owner only: the admin ceilings, enforced by the server for everyone in the org. */
export function OrgCeilings({ org, onChanged }: { org: OrgWire; onChanged: () => Promise<void> }) {
  const { t } = useT();
  const { busy, errorKey, run } = useOrgAction();
  const save = async (change: Record<string, unknown>) => {
    const ok = await run(() =>
      apiFetch("/api/orgs/current", { method: "PATCH", body: JSON.stringify(change) }),
    );
    if (ok) await onChanged();
  };
  return (
    <section aria-labelledby="org-admin-title" className="space-y-3">
      <h3 id="org-admin-title" className="text-role-label font-semibold text-ink">
        {t("settings.org.admin.title")}
      </h3>
      <Switch
        checked={org.autoReplyDisabled}
        disabled={busy}
        label={t("settings.org.admin.autoReplyOff")}
        onChange={(next) => void save({ autoReplyDisabled: next })}
      />
      <Select
        id="org-agent-cap"
        label={t("settings.org.admin.agentCap")}
        value={org.agentModeCap ?? ""}
        disabled={busy}
        onChange={(event) =>
          void save({ agentModeCap: capFromOption((event.target as HTMLSelectElement).value) })
        }
      >
        {CAP_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.key)}
          </option>
        ))}
      </Select>
      <p className="text-role-caption text-ink-dim">{t("settings.org.admin.appliesToAll")}</p>
      {errorKey && (
        <p role="alert" className="text-role-caption text-ink-mid">
          {t(errorKey)}
        </p>
      )}
    </section>
  );
}

interface SeatPrice {
  monthlyCents: number;
  annualPerMonthCents: number;
}

/** Seats: everyone sees the state; the owner can open the team checkout once billing is on. */
export function OrgSeats({
  org,
  owner,
  price,
}: {
  org: OrgWire;
  owner: boolean;
  price: SeatPrice | null;
}) {
  const { t, locale } = useT();
  const [seatsText, setSeatsText] = useState(() => String(defaultSeats(org.seats.used)));
  // Set once the browser is handed to Paddle: the buttons stay off, so a
  // second click cannot open a second transaction.
  const [leaving, setLeaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const { busy, errorKey, run } = useOrgAction();
  const available = org.seats.checkoutIntervals;
  const live = org.seats.status !== null && org.seats.status !== "canceled";
  const seats = parseSeats(seatsText);

  const checkout = (interval: TeamIntervalWire) =>
    run(async () => {
      if (seats === null) return;
      setRefused(false);
      const { url } = await apiFetch<OrgCheckoutResponse>("/api/orgs/current/checkout", {
        method: "POST",
        body: JSON.stringify({ interval, seats }),
      });
      // Only Paddle's hosted checkout (or this origin) is followed.
      if (!isSafeBillingRedirect(url, window.location.origin)) {
        setRefused(true);
        return;
      }
      setLeaving(true);
      window.location.assign(url);
    });

  const priceLabel = (interval: TeamIntervalWire) =>
    price
      ? t(interval === "month" ? "settings.org.checkout.monthly" : "settings.org.checkout.annual", {
          price: formatUsd(
            interval === "month" ? price.monthlyCents : price.annualPerMonthCents,
            locale,
          ),
        })
      : t(
          interval === "month"
            ? "settings.org.checkout.monthlyPlain"
            : "settings.org.checkout.annualPlain",
        );

  return (
    <section aria-labelledby="org-seats-title" className="space-y-3">
      <h3 id="org-seats-title" className="text-role-label font-semibold text-ink">
        {t("settings.org.seats.title")}
      </h3>
      <p className="text-role-body text-ink-mid">
        {t("settings.org.seats.summary", {
          used: String(org.seats.used),
          purchased: String(org.seats.purchased),
        })}{" "}
        · {t(seatStatusKey(org.seats.status))}
      </p>
      {owner && !live && available.length === 0 && (
        <p className="text-role-caption text-ink-dim">{t("settings.org.checkout.unavailable")}</p>
      )}
      {owner && !live && available.length > 0 && (
        <div className="space-y-3">
          <Input
            id="org-seat-count"
            type="number"
            inputMode="numeric"
            min={MIN_SEATS}
            max={MAX_SEATS}
            label={t("settings.org.checkout.seats")}
            value={seatsText}
            error={seats === null ? t("settings.org.error.INVALID_SEATS") : undefined}
            onChange={(event) => setSeatsText(event.target.value)}
            onBlur={() => setSeatsText(String(clampSeats(Number(seatsText))))}
          />
          <div className="flex flex-wrap gap-3">
            {available.map((interval) => (
              <Button
                key={interval}
                disabled={busy || leaving || seats === null}
                onClick={() => void checkout(interval)}
              >
                {priceLabel(interval)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {(errorKey || refused) && (
        <p role="alert" className="text-role-caption text-ink-mid">
          {t(errorKey ?? "settings.org.error.generic")}
        </p>
      )}
    </section>
  );
}
