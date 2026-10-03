"use client";

import type { LiveTier } from "@klorn/contract";
import { useRef, useState } from "react";
import Button from "../../../components/ui/button";
import EmptyState from "../../../components/ui/empty-state";
import { LaneChip } from "../../../components/ui/lane-chip";
import { MailRow } from "../../../components/ui/mail-row";
import { Sheet } from "../../../components/ui/sheet";
import { MailRowSkeleton, Skeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { SourceBadge } from "../../../components/ui/source-badge";
import { CORE_TIERS } from "../../../lib/tiers";

const PROVIDERS = ["GOOGLE", "OUTLOOK", "NAVER", "ICLOUD", "IMAP", "KLORN", "SOMETHING_NEW"];

const ROWS: {
  sender: string;
  subject: string;
  snippet: string;
  time: string;
  tier: LiveTier;
  provider: string;
  nickname?: string;
  unread?: boolean;
  hasAttachment?: boolean;
}[] = [
  {
    sender: "Dana Park",
    subject: "Contract redlines due today",
    snippet: "Can you look at clause 7 before 3pm? Legal flagged the indemnity cap.",
    time: "09:41",
    tier: "PUSH",
    provider: "GOOGLE",
    nickname: "work@",
    unread: true,
    hasAttachment: true,
  },
  {
    sender: "Calendar",
    subject: "Design review moved to Thursday",
    snippet: "Thursday 14:00–15:00, Room 3B",
    time: "08:12",
    tier: "MEETING",
    provider: "OUTLOOK",
    unread: true,
  },
  {
    sender: "김민지",
    subject: "분기 보고서 초안 공유드립니다",
    snippet: "검토 부탁드립니다. 다음 주 월요일까지 의견 주시면 반영하겠습니다.",
    time: "Mon",
    tier: "QUEUE",
    provider: "NAVER",
  },
  {
    sender: "GitHub",
    subject: "[klorn] CI passed on main",
    snippet: "All checks have passed for 67120545.",
    time: "Sun",
    tier: "INFO",
    provider: "ICLOUD",
    nickname: "me@icloud",
  },
  {
    sender: "Promo Weekly",
    subject: "Last chance: 40% off everything",
    snippet: "Sale ends tonight at midnight.",
    time: "Sep 28",
    tier: "SILENT",
    provider: "IMAP",
  },
];

function TrashGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" />
    </svg>
  );
}

function InboxGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 13l3-8h12l3 8v6H3v-6zm0 0h5l1 2h6l1-2h5" />
    </svg>
  );
}

export default function PrimitivesPreview() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);

  const setTheme = (dark: boolean) => document.documentElement.classList.toggle("dark", dark);

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-4 py-8 text-ink">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-display">UI primitives</h1>
        <Button variant="secondary" size="sm" onClick={() => setTheme(false)}>
          Light
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setTheme(true)}>
          Dark
        </Button>
      </header>

      <section aria-labelledby="sec-lane" className="space-y-3">
        <h2 id="sec-lane" className="text-title">
          LaneChip
        </h2>
        <div className="flex flex-wrap gap-2" data-testid="lane-chips">
          {CORE_TIERS.map((tier) => (
            <LaneChip key={tier} tier={tier} />
          ))}
          <LaneChip tier="AUTO" />
        </div>
      </section>

      <section aria-labelledby="sec-source" className="space-y-3">
        <h2 id="sec-source" className="text-title">
          SourceBadge
        </h2>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <SourceBadge key={p} provider={p} />
          ))}
          <SourceBadge provider="GOOGLE" nickname="work@" />
        </div>
      </section>

      <section aria-labelledby="sec-rows" className="space-y-3">
        <h2 id="sec-rows" className="text-title">
          MailRow
        </h2>
        <div className="rounded-card border border-line bg-surface-panel p-1">
          {ROWS.map((row, i) => (
            <MailRow
              key={row.subject}
              sender={row.sender}
              subject={row.subject}
              snippet={row.snippet}
              time={row.time}
              tier={row.tier}
              source={{ provider: row.provider, nickname: row.nickname }}
              unread={row.unread}
              hasAttachment={row.hasAttachment}
              selected={selected === i}
              onOpen={() => setSelected(i)}
              actions={
                <Button variant="ghost" size="icon" aria-label={`Archive ${row.subject}`}>
                  <TrashGlyph />
                </Button>
              }
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="sec-skeleton" className="space-y-3">
        <h2 id="sec-skeleton" className="text-title">
          Skeleton
        </h2>
        <SkeletonGroup label="Loading mail" className="space-y-2">
          <Skeleton width="w-1/2" />
          <Skeleton variant="block" height="h-16" />
          <MailRowSkeleton />
          <MailRowSkeleton />
        </SkeletonGroup>
      </section>

      <section aria-labelledby="sec-empty" className="space-y-3">
        <h2 id="sec-empty" className="text-title">
          EmptyState
        </h2>
        <div className="rounded-card border border-line bg-surface-panel">
          <EmptyState
            icon={<InboxGlyph />}
            title="Your first briefing is on its way"
            description="Connect an account and today's mail will be sorted into lanes here."
            primaryAction={{ label: "Connect an account", onClick: () => setSheetOpen(true) }}
          />
        </div>
      </section>

      <section aria-labelledby="sec-sheet" className="space-y-3">
        <h2 id="sec-sheet" className="text-title">
          Sheet and Button
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setSheetOpen(true)} data-testid="open-sheet">
            Open sheet
          </Button>
          <Button variant="secondary" size="icon" aria-label="Delete">
            <TrashGlyph />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Delete (loading)" loading>
            <TrashGlyph />
          </Button>
        </div>
        <Sheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="Add an account"
          description="Pick a provider. You can add more later."
          initialFocusRef={nameRef}
          footer={
            <>
              <Button variant="secondary" onClick={() => setSheetOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setSheetOpen(false)}>Continue</Button>
            </>
          }
        >
          <label className="block space-y-1">
            <span className="text-label text-ink-soft">Account nickname</span>
            <input
              ref={nameRef}
              className="focus-ring block min-h-11 w-full rounded-control border border-line bg-surface-panel px-3 text-body"
            />
          </label>
        </Sheet>
      </section>
    </main>
  );
}
