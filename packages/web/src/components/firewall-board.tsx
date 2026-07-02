"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { captureClientError } from "../lib/sentry";
import { useToast } from "./toast";
import { TrustDot, type TrustScoreData } from "./trust-badge";

export type Tier = "SILENT" | "QUEUE" | "PUSH" | "AUTO";
type ColumnTier = "PUSH" | "QUEUE" | "SILENT";

// How often the firewall view re-pulls while the tab is focused.
export const FIREWALL_REFRESH_MS = 45_000;

interface EmailContext {
  emailDbId: string;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  trust: TrustScoreData | null;
}

export interface FirewallItem {
  id: string;
  source: string;
  sourceId: string;
  type: string;
  title: string;
  tier: Tier;
  tierReason: string | null;
  priority: number;
  surfacedAt: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  email?: EmailContext;
  href?: string;
}

export interface FirewallResponse {
  tiers: Record<Tier, FirewallItem[]>;
  summary: Record<Tier, number> & { total: number };
}

interface DailyReceiptSummary {
  totalSeen: number;
  totalInterrupted: number;
  savedFromInbox: number;
  autoHandled: number;
  narrative: string;
}

interface DailyReceipt {
  date: string;
  summary: DailyReceiptSummary;
}

const TIER_ORDER: Tier[] = ["PUSH", "QUEUE", "SILENT"];

// Spatial-triage visual language. Depth is meant to be felt before it is
// read: PUSH sits on a glowing, elevated plane; QUEUE is mid; SILENT
// recedes and desaturates. The class strings below encode that ladder.
export const TIER_VISUAL: Record<
  Tier,
  {
    label: string;
    description: string;
    plane: string; // column panel: glow + tint + border
    card: string; // per-card border + hover accent
    accent: string; // count + glyph color
    dot: string; // glyph fill
  }
> = {
  PUSH: {
    label: "PUSH",
    description: "Worth interrupting you for. Push notifications fire here.",
    plane:
      "tier-plane-push border-tier-push/35 bg-gradient-to-b from-tier-push/[0.07] to-transparent",
    card: "border-tier-push/15 bg-stone-950/60 hover:border-tier-push/45",
    accent: "text-tier-push",
    dot: "text-tier-push",
  },
  QUEUE: {
    label: "QUEUE",
    description: "Visible when you choose to look. No push.",
    plane:
      "tier-plane-queue border-tier-queue/25 bg-gradient-to-b from-tier-queue/[0.05] to-transparent",
    card: "border-tier-queue/10 bg-stone-950/55 hover:border-tier-queue/35",
    accent: "text-tier-queue",
    dot: "text-tier-queue",
  },
  SILENT: {
    label: "SILENT",
    description: "Recorded only. Klorn decided this wasn't worth surfacing.",
    plane: "tier-plane-silent border-stone-800/70 bg-stone-950/30 opacity-90 hover:opacity-100",
    card: "border-stone-800/60 bg-stone-950/40 hover:border-stone-700",
    accent: "text-tier-silent",
    dot: "text-tier-silent",
  },
  AUTO: {
    label: "AUTO",
    description: "Handled without asking. Eligible for auto-execution.",
    plane:
      "tier-plane-auto border-tier-auto/30 bg-gradient-to-b from-tier-auto/[0.05] to-transparent",
    card: "border-tier-auto/15 bg-stone-950/55 hover:border-tier-auto/40",
    accent: "text-tier-auto",
    dot: "text-tier-auto",
  },
};

// Per-target tint for the override pills, so "Move → PUSH" hints its tier hue.
const TARGET_BUTTON: Record<Tier, string> = {
  PUSH: "hover:border-tier-push/50 hover:text-tier-push",
  QUEUE: "hover:border-tier-queue/50 hover:text-tier-queue",
  SILENT: "hover:border-stone-600 hover:text-tier-silent",
  AUTO: "hover:border-tier-auto/50 hover:text-tier-auto",
};

const OVERRIDE_TARGETS: Tier[] = ["SILENT", "QUEUE", "PUSH"];

export function FirewallBoard() {
  const { toast } = useToast();
  const [data, setData] = useState<FirewallResponse | null>(null);
  const [receipt, setReceipt] = useState<DailyReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [overriding, setOverriding] = useState<string | null>(null);
  // Screen-reader announcement for tier moves — the board mutates silently
  // otherwise (WCAG 4.1.3). Rendered into a polite live region below.
  const [announcement, setAnnouncement] = useState("");

  const load = useCallback(async () => {
    try {
      const [firewall, today] = await Promise.all([
        apiFetch<FirewallResponse>("/api/inbox/firewall/"),
        apiFetch<DailyReceipt>("/api/inbox/receipt/today").catch(() => null),
      ]);
      setData(firewall);
      setReceipt(today);
    } catch (err) {
      captureClientError(err, { scope: "firewall.load" });
      toast("Could not load firewall queue.", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh so newly-classified mail appears without a manual reload.
  // The mail page already refetches (react-query); this page hand-rolls its
  // fetch, so it stayed stale after a sync. Poll while visible + refetch on
  // focus, but never while an optimistic override is mid-flight (that local
  // state would get clobbered by a server response that predates the move).
  const overridingRef = useRef(overriding);
  overridingRef.current = overriding;
  useEffect(() => {
    const refresh = () => {
      if (overridingRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      load();
    };
    const intervalId = window.setInterval(refresh, FIREWALL_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const override = async (item: FirewallItem, newTier: Tier) => {
    if (overriding) return;
    setOverriding(item.id);
    // Optimistic: pull from current tier, push into new tier in local state
    setData((prev) => moveItemBetweenTiers(prev, item, newTier));
    try {
      await apiFetch(`/api/inbox/firewall/${item.id}`, {
        method: "POST",
        body: JSON.stringify({ tier: newTier }),
      });
      setAnnouncement(`Moved “${item.title}” from ${item.tier} to ${newTier}.`);
    } catch (err) {
      // Roll back
      setData((prev) => moveItemBetweenTiers(prev, { ...item, tier: newTier }, item.tier));
      captureClientError(err, { scope: "firewall.override" });
      toast("Could not save tier override.", "error");
    } finally {
      setOverriding(null);
    }
  };

  // Visible columns: PUSH, QUEUE, SILENT. AUTO sits below as a one-line
  // summary because the user already chose not to be interrupted by it.
  const visibleColumns = useMemo(() => {
    if (!data) return null;
    return {
      PUSH: data.tiers.PUSH,
      QUEUE: data.tiers.QUEUE,
      SILENT: data.tiers.SILENT,
    } as Record<ColumnTier, FirewallItem[]>;
  }, [data]);

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10 text-stone-500">
        Loading firewall…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-10 text-stone-500">
        Nothing to show yet.
      </div>
    );
  }

  return (
    <div className="min-h-full px-4 pb-28 pt-6 md:py-10">
      <div className="mx-auto max-w-6xl">
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <header className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300/80">
            Firewall board
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-50 sm:text-[2rem]">
            Today's attention firewall
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500">
            Klorn evaluated every signal that hit your inbox today and sorted it into a tier. Move
            anything we got wrong — that override teaches the classifier.
          </p>
        </header>

        <DailyReceiptStrip data={data} receipt={receipt} />

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {(["PUSH", "QUEUE", "SILENT"] as const).map((tier) => (
            <TierColumn
              key={tier}
              tier={tier}
              items={visibleColumns?.[tier] ?? []}
              overrideId={overriding}
              onOverride={override}
            />
          ))}
        </div>

        <AutoStrip count={data.summary.AUTO} items={data.tiers.AUTO} />
      </div>
    </div>
  );
}

function moveItemBetweenTiers(
  prev: FirewallResponse | null,
  item: FirewallItem,
  newTier: Tier,
): FirewallResponse | null {
  if (!prev) return prev;
  const next = {
    ...prev,
    tiers: { ...prev.tiers, summary: { ...prev.summary } },
  } as FirewallResponse;
  // Copy each tier array so we mutate a fresh structure
  for (const t of TIER_ORDER.concat(["AUTO"])) {
    next.tiers[t] = [...prev.tiers[t]];
  }
  next.tiers[item.tier] = next.tiers[item.tier].filter((row) => row.id !== item.id);
  next.tiers[newTier] = [{ ...item, tier: newTier }, ...next.tiers[newTier]];
  next.summary = {
    SILENT: next.tiers.SILENT.length,
    QUEUE: next.tiers.QUEUE.length,
    PUSH: next.tiers.PUSH.length,
    AUTO: next.tiers.AUTO.length,
    total: prev.summary.total,
  };
  return next;
}

// Small SVG glyph per tier — a fast pre-literacy read of "where am I looking".
function TierGlyph({ tier, className }: { tier: Tier; className?: string }) {
  if (tier === "PUSH") {
    // Filled alert diamond.
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={className}
        fill="currentColor"
      >
        <path d="M8 1l7 7-7 7-7-7 7-7z" />
      </svg>
    );
  }
  if (tier === "QUEUE") {
    // Stacked layers — a holding queue.
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M2 5l6-3 6 3-6 3-6-3z" />
        <path d="M2 8.5l6 3 6-3" />
        <path d="M2 11.5l6 3 6-3" opacity="0.5" />
      </svg>
    );
  }
  if (tier === "AUTO") {
    // Check — done without asking.
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M3 8.5l3.5 3.5L13 4.5" />
      </svg>
    );
  }
  // SILENT — hollow muted ring.
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}

// Count that pops once when its value changes (e.g. after an override).
function CountChip({ value, className }: { value: number; className?: string }) {
  const prev = useRef(value);
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setPop(true);
      const t = window.setTimeout(() => setPop(false), 340);
      return () => window.clearTimeout(t);
    }
  }, [value]);
  return (
    <span
      className={`inline-block tabular-nums ${pop ? "animate-count-pop" : ""} ${className ?? ""}`}
    >
      {value}
    </span>
  );
}

function DailyReceiptStrip({
  data,
  receipt,
}: {
  data: FirewallResponse;
  receipt: DailyReceipt | null;
}) {
  const counts: Tier[] = ["PUSH", "QUEUE", "SILENT", "AUTO"];
  return (
    <section className="glass rounded-2xl border border-stone-800/80 bg-stone-950/40 p-5">
      <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-4">
        {counts.map((tier) => {
          const v = TIER_VISUAL[tier];
          return (
            <div key={tier} className="flex items-center gap-3">
              <TierGlyph tier={tier} className={v.dot} />
              <div className="flex flex-col">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
                  {v.label}
                </span>
                <CountChip
                  value={data.summary[tier]}
                  className={`text-2xl font-semibold leading-none ${v.accent}`}
                />
              </div>
            </div>
          );
        })}
      </div>
      {receipt?.summary?.narrative && (
        <p className="mt-4 border-t border-stone-800/80 pt-4 text-xs leading-5 text-stone-500">
          {receipt.summary.narrative}
        </p>
      )}
    </section>
  );
}

function TierColumn({
  tier,
  items,
  overrideId,
  onOverride,
}: {
  tier: ColumnTier;
  items: FirewallItem[];
  overrideId: string | null;
  onOverride: (item: FirewallItem, newTier: Tier) => void;
}) {
  const v = TIER_VISUAL[tier];
  return (
    <section className={`glass rounded-2xl border p-4 transition-opacity ${v.plane}`}>
      <header className="mb-1 flex items-center gap-2">
        <TierGlyph tier={tier} className={v.dot} />
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-100">
          {v.label}
        </h2>
        <CountChip value={items.length} className={`ml-auto text-sm font-semibold ${v.accent}`} />
      </header>
      <p className="mb-4 text-[11px] leading-5 text-stone-500">{v.description}</p>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-800/70 px-3 py-8 text-center text-xs text-stone-400">
          Nothing here yet.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item, i) => (
            <FirewallCard
              key={item.id}
              item={item}
              tier={tier}
              index={i}
              overrideId={overrideId}
              onOverride={onOverride}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FirewallCard({
  item,
  tier,
  index,
  overrideId,
  onOverride,
}: {
  item: FirewallItem;
  tier: ColumnTier;
  index: number;
  overrideId: string | null;
  onOverride: (item: FirewallItem, newTier: Tier) => void;
}) {
  const v = TIER_VISUAL[tier];
  // Best-effort meaningful heading: actual email subject beats the
  // tool-arg subject beats the agent's auto-title fallback.
  const subject = item.email?.subject || toolSubject(item) || item.title;
  const sender = item.email?.from || toolRecipient(item);
  const snippet = item.email?.snippet || toolBodyPreview(item);
  // opacity marks the ONE card being moved; the buttons disable while ANY
  // override is in flight, because override() has a single-flight guard
  // (`if (overriding) return`) — without this, other cards' buttons look
  // clickable but silently no-op mid-override.
  const busy = overrideId === item.id;
  const anyOverriding = overrideId !== null;

  return (
    <li
      className={`lift animate-card-in rounded-xl border p-3.5 text-sm ${v.card} ${
        busy ? "opacity-50" : ""
      }`}
      // Stagger only the first screenful so a fresh load cascades in; later
      // cards (and re-renders) appear immediately.
      style={index < 8 ? { animationDelay: `${index * 35}ms` } : undefined}
    >
      <p className="line-clamp-2 break-words font-medium text-stone-100">{subject}</p>
      {sender && (
        <p className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-stone-500">
          {item.email?.trust && <TrustDot trust={item.email.trust} />}
          <span className="truncate">
            {item.email?.from ? "From" : "To"}: {sender}
          </span>
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-stone-400">
        <SourceBadge source={item.source} />
        {item.toolName && (
          <>
            <span>·</span>
            <span>{item.toolName.replace(/_/g, " ")}</span>
          </>
        )}
        <span>·</span>
        <span>{relativeTime(item.surfacedAt)}</span>
      </div>

      {snippet && (
        <details className="group mt-2.5 rounded-lg border border-stone-800/80 bg-black/30">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-stone-400 transition hover:text-stone-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <span aria-hidden="true" className="inline-block transition group-open:rotate-90">
              ›
            </span>
            <span className="group-open:hidden">Show preview</span>
            <span className="hidden group-open:inline">Hide preview</span>
          </summary>
          <p className="line-clamp-6 whitespace-pre-wrap border-t border-stone-800/80 px-2.5 py-2 text-[11px] leading-4 text-stone-300">
            {snippet}
          </p>
        </details>
      )}

      {item.tierReason && (
        <p className="mt-2.5 line-clamp-2 border-l-2 border-stone-800 pl-2 text-[11px] leading-4 text-stone-500">
          {item.tierReason}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {OVERRIDE_TARGETS.filter((t) => t !== tier).map((target) => (
          <button
            key={target}
            type="button"
            disabled={anyOverriding}
            onClick={() => onOverride(item, target)}
            className={`inline-flex min-h-7 items-center rounded-full border border-stone-700/80 px-2.5 text-[10px] font-medium uppercase tracking-wider text-stone-400 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${TARGET_BUTTON[target]}`}
          >
            Move → {target}
          </button>
        ))}
        {item.href && (
          <Link
            href={item.href}
            className={`ml-auto text-[11px] transition ${v.accent} hover:text-stone-100`}
          >
            Open email →
          </Link>
        )}
      </div>
    </li>
  );
}

function pickString(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function toolSubject(item: FirewallItem): string | undefined {
  if (!item.toolArgs || !item.toolName) return undefined;
  if (item.toolName === "send_email" || item.toolName === "reply_to_email") {
    return pickString(item.toolArgs, "subject");
  }
  if (item.toolName === "create_event") {
    return pickString(item.toolArgs, "title", "summary");
  }
  return undefined;
}

function toolRecipient(item: FirewallItem): string | undefined {
  if (!item.toolArgs || !item.toolName) return undefined;
  if (item.toolName === "send_email" || item.toolName === "reply_to_email") {
    return pickString(item.toolArgs, "to", "recipient");
  }
  return undefined;
}

function toolBodyPreview(item: FirewallItem): string | undefined {
  if (!item.toolArgs || !item.toolName) return undefined;
  if (item.toolName === "send_email" || item.toolName === "reply_to_email") {
    return pickString(item.toolArgs, "body");
  }
  if (item.toolName === "create_event") {
    const start = pickString(item.toolArgs, "start_time", "startTime");
    const loc = pickString(item.toolArgs, "location");
    const parts: string[] = [];
    if (start) parts.push(`Starts: ${start}`);
    if (loc) parts.push(`Location: ${loc}`);
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

function AutoStrip({ count, items }: { count: number; items: FirewallItem[] }) {
  const v = TIER_VISUAL.AUTO;
  if (count === 0) {
    return (
      <section className="glass mt-4 flex items-center gap-2 rounded-2xl border border-stone-800/70 bg-stone-950/30 p-4 text-xs text-stone-500">
        <TierGlyph tier="AUTO" className="text-stone-400" />
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-500">
          AUTO
        </span>
        <span>— nothing handled automatically yet.</span>
      </section>
    );
  }
  return (
    <section className={`glass mt-4 rounded-2xl border p-4 ${v.plane}`}>
      <header className="flex items-center gap-2">
        <TierGlyph tier="AUTO" className={v.dot} />
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-tier-auto">
          AUTO
        </h2>
        <CountChip value={count} className={`ml-auto text-sm font-semibold ${v.accent}`} />
      </header>
      <p className="mt-1.5 text-[11px] leading-5 text-stone-500">
        Low-risk, pre-approved. Klorn ran these without interrupting you.
      </p>
      <ul className="mt-3 space-y-1.5 text-xs text-stone-400">
        {items.slice(0, 5).map((item) => (
          <li key={item.id} className="flex items-center gap-2 line-clamp-1">
            <span className="text-tier-auto/60">·</span>
            <span className="truncate">{item.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceBadge({ source }: { source: string }) {
  return <span className="font-mono text-[10px] text-stone-500">{source}</span>;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
