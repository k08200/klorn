"use client";

// The smart actions for one mail — "Draft reply" and "Add to calendar" — on a
// briefing pick and in the mail reader. Rendered only while the server opened
// them to this user (`user.smartActions`, SMART_ACTIONS_ENABLED); otherwise
// nothing at all. Each opens its card inline; nothing happens without a tap.
//
// All card state belongs to ONE mail: the panels are keyed by the mail id, so
// moving to the next mail (the reader stays mounted) or a pick changing under
// the same rank starts from nothing — an edited reply can never be sent under
// another mail's recipient. A card stays mounted once opened, so closing it
// and opening it again keeps the edits instead of drafting anew.

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import Button from "../ui/button";
import { smartActionsVisible } from "./model";
import { SmartEventCard } from "./smart-event-card";
import { SmartReplyCard } from "./smart-reply-card";

type Panel = "reply" | "event";

function SmartActionsPanels({ emailId }: { emailId: string }) {
  const { t } = useT();
  const [open, setOpen] = useState<Panel | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<Panel>>(() => new Set());

  const toggle = (panel: Panel) => {
    setOpened((prev) => (prev.has(panel) ? prev : new Set([...prev, panel])));
    setOpen((prev) => (prev === panel ? null : panel));
  };
  const buttons: ReadonlyArray<{ panel: Panel; labelKey: string }> = [
    { panel: "reply", labelKey: "smartActions.draftReply" },
    { panel: "event", labelKey: "smartActions.addToCalendar" },
  ];
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {buttons.map(({ panel, labelKey }) => (
          <Button
            key={panel}
            variant={open === panel ? "primary" : "secondary"}
            size="sm"
            aria-expanded={open === panel}
            onClick={() => toggle(panel)}
          >
            {t(labelKey)}
          </Button>
        ))}
      </div>
      {opened.has("reply") && (
        <div hidden={open !== "reply"}>
          <SmartReplyCard emailId={emailId} />
        </div>
      )}
      {opened.has("event") && (
        <div hidden={open !== "event"}>
          <SmartEventCard emailId={emailId} />
        </div>
      )}
    </>
  );
}

export function SmartActionsRow({
  emailId,
  className = "",
}: {
  emailId: string;
  className?: string;
}) {
  const { t } = useT();
  const { user } = useAuth();
  if (!smartActionsVisible(user, emailId)) return null;
  return (
    <div role="group" aria-label={t("smartActions.label")} className={className}>
      <SmartActionsPanels key={emailId} emailId={emailId} />
    </div>
  );
}
