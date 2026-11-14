"use client";

import type { OrgCheckoutResponse, OrgWire, TeamIntervalWire } from "@klorn/contract";
import { useState } from "react";
import Button from "../../../../components/ui/button";
import { Input, Select } from "../../../../components/ui/input";
import Switch from "../../../../components/ui/switch";
import { apiFetch } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import {
  CAP_OPTIONS,
  capFromOption,
  clampSeats,
  defaultSeats,
  formatUsd,
  MAX_SEATS,
  MIN_SEATS,
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
  const [seats, setSeats] = useState(() => defaultSeats(org.seats.used));
  const { busy, errorKey, run } = useOrgAction();
  const available = org.seats.checkoutIntervals;
  const live = org.seats.status !== null && org.seats.status !== "canceled";

  const checkout = (interval: TeamIntervalWire) =>
    run(async () => {
      const { url } = await apiFetch<OrgCheckoutResponse>("/api/orgs/current/checkout", {
        method: "POST",
        body: JSON.stringify({ interval, seats }),
      });
      // The server hands back Paddle's hosted checkout; only an https page is followed.
      if (url.startsWith("https://")) window.location.assign(url);
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
            value={seats}
            onChange={(event) => setSeats(clampSeats(Number(event.target.value)))}
          />
          <div className="flex flex-wrap gap-3">
            {available.map((interval) => (
              <Button
                key={interval}
                loading={busy}
                disabled={busy}
                onClick={() => void checkout(interval)}
              >
                {priceLabel(interval)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {errorKey && (
        <p role="alert" className="text-role-caption text-ink-mid">
          {t(errorKey)}
        </p>
      )}
    </section>
  );
}
