"use client";

/**
 * "Why it rang" on the phone reader (mobile redesign PR3, MB1 "Editorial
 * Brief", LOCKED 2026-11-14): for a PUSH or MEETING mail with a recorded
 * reason, a raised box under the sender — the kicker "PUSH · Why it rang" in
 * the lane's ink, then the verified quote in curly quotes, or the judge's own
 * text as "Klorn's call · …" in muted ink. The same rule as the Today card and
 * the notification center (pushWhy → reasonLine). Both may be model or sender
 * output: text nodes only, never HTML. Other lanes say why in the header's
 * lane line, as they do from 600px.
 */

import type { EmailReaderContextResponse, LiveTier } from "@klorn/contract";
import { LANE_INK_CLASS, useLaneName } from "../../../../components/ui/lane-chip";
import { useT } from "../../../../lib/i18n";
import { pushWhy } from "../../../today/brief-model";

// lane-subset: only the lanes that interrupt get the "why it rang" box.
const RINGING_LANES: ReadonlySet<LiveTier> = new Set(["PUSH", "MEETING"]);

/** The box shows: a lane that interrupts, with something to say why. */
export function hasReaderWhy(context: EmailReaderContextResponse | null): boolean {
  return Boolean(context?.tier && RINGING_LANES.has(context.tier) && pushWhy(context));
}

export function ReaderWhy({ context }: { context: EmailReaderContextResponse | null }) {
  const { t } = useT();
  const laneName = useLaneName();
  if (!context?.tier || !hasReaderWhy(context)) return null;
  const why = pushWhy(context);
  if (!why) return null;
  return (
    <section
      data-testid="reader-why"
      aria-labelledby="reader-why-kicker"
      className="flex flex-col gap-1.5 rounded-control bg-surface-raised p-3.5 ring-1 ring-inset ring-line rail:hidden"
    >
      <h2
        id="reader-why-kicker"
        className={`text-role-caption font-semibold uppercase tracking-[0.08em] ${LANE_INK_CLASS[context.tier]}`}
      >
        {laneName(context.tier)} · {t("mailV2.reader.whyRang")}
      </h2>
      <p
        data-testid="reader-why-text"
        className={`text-role-body [word-break:keep-all] ${why.kind === "quote" ? "text-ink" : "text-ink-muted"}`}
      >
        {why.kind === "quote" ? why.text : t("notifCenter.judgment", { text: why.text })}
      </p>
    </section>
  );
}

export default ReaderWhy;
