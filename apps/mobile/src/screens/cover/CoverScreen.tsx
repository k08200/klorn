/**
 * Galaxy Z Flip cover screen (FlipCover artboard, < 420 × 450): one job only —
 * the top PUSH item and two big buttons. "Review" selects the mail in the
 * route, so unfolding continues straight into it. "Later" snoozes the item
 * for an hour (POST /api/inbox/firewall/:id/snooze — it comes back as a PUSH
 * then) and shows the next one. Nothing is ever sent from the cover screen:
 * a ready reply draft is only mentioned, and is reviewed after unfolding.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { qk, useEvents, useFirewall, useInboxes, useLaneCounts } from "../../api/queries";
import { getServices } from "../../app/services";
import { formatClock } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import { useRouter } from "../../router/Router";
import { dayRangeInZone, nextEvent } from "../today/model";
import "./cover.css";

function senderName(from: string | null | undefined): string {
  if (!from) return "";
  return from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "");
}

export function CoverScreen() {
  const { t, intlTag } = useI18n();
  const { navigate } = useRouter();
  const queryClient = useQueryClient();
  const inboxes = useInboxes().data?.inboxes ?? [];
  const [snoozed, setSnoozed] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const range = dayRangeInZone(now, zone);
  const firewall = useFirewall();
  const counts = useLaneCounts();
  const events = useEvents(range.start, range.end);

  const push = [...(firewall.data?.tiers.PUSH ?? [])]
    .filter((i) => !snoozed.has(i.id))
    .sort((a, b) => b.priority - a.priority);
  const item = push[0];
  const pushCount = Math.max(0, (counts.data?.counts.PUSH.total ?? push.length) - snoozed.size);
  const next = events.data ? nextEvent(events.data, now) : null;

  // "박서연 · 회사": the sender, and which account it came to.
  const accountId = item?.email?.source?.accountId ?? null;
  const purpose = inboxes.find((i) => i.id === accountId)?.purpose;
  const where =
    purpose === "work"
      ? t("files.purpose.work")
      : purpose === "personal"
        ? t("files.purpose.personal")
        : null;
  const from = [senderName(item?.email?.from), where].filter(Boolean).join(" · ");
  const why = [item?.tierReason, item?.email?.draftReady ? t("push.cover.draftReady") : null]
    .filter(Boolean)
    .join(" — ");

  const later = () => {
    if (!item) return;
    setSnoozed((prev) => new Set([...prev, item.id]));
    setNote(t("push.snoozed"));
    setTimeout(() => setNote(null), 3000);
    void getServices()
      .ep.triage.snooze(item.id, new Date(Date.now() + 3_600_000))
      .then(() => queryClient.invalidateQueries({ queryKey: qk.firewall() }))
      .catch(() => {
        // Not snoozed after all: show it again.
        setSnoozed((prev) => new Set([...prev].filter((id) => id !== item.id)));
        setNote(t("push.cover.snoozeFailed"));
      });
  };

  return (
    <main className="cover">
      <div className="cover__top">
        <span className="cover__lane">PUSH {pushCount}</span>
        {next ? (
          <span className="cover__next">
            {formatClock(new Date(next.startTime), intlTag)} {next.title}
          </span>
        ) : null}
      </div>
      {item ? (
        <>
          <div className="cover__body">
            <span className="cover__from">{from}</span>
            <span className="cover__title">{item.title}</span>
            {why ? <span className="cover__why">{why}</span> : null}
          </div>
          <div className="cover__spacer" />
          <div className="cover__actions">
            <button type="button" className="cover__button" onClick={later}>
              {t("cover.later")}
            </button>
            <button
              type="button"
              className="cover__button cover__button--primary"
              onClick={() =>
                item.email?.emailDbId
                  ? navigate({ name: "mail", id: item.email.emailDbId })
                  : navigate({ name: "mail", lane: "PUSH" })
              }
            >
              {t("cover.review")}
            </button>
          </div>
          <span className="cover__hint" role="status">
            {note ?? t("cover.hint")}
          </span>
        </>
      ) : (
        <>
          <div className="cover__body">
            <span className="cover__title">{t("today.brief.emptyTitle")}</span>
            <span className="cover__why">{t("today.brief.emptyBody")}</span>
          </div>
          {note ? (
            <span className="cover__hint" role="status">
              {note}
            </span>
          ) : null}
        </>
      )}
    </main>
  );
}
