"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { useToast } from "../../../components/toast";
import { TrustDot, type TrustScoreData } from "../../../components/trust-badge";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type Tier = "SILENT" | "QUEUE" | "PUSH" | "CALL" | "AUTO";

interface EmailContext {
  emailDbId: string;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  trust: TrustScoreData | null;
}

interface FirewallItem {
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

interface FirewallResponse {
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

const TIER_META: Record<Tier, { label: string; tone: string; description: string }> = {
  PUSH: {
    label: "PUSH",
    tone: "border-rose-400/40 bg-rose-500/5",
    description: "Worth interrupting you for. Push notifications fire here.",
  },
  CALL: {
    label: "CALL",
    tone: "border-rose-400/40 bg-rose-500/5",
    description: "Highest-urgency interrupt — rendered with PUSH for now.",
  },
  QUEUE: {
    label: "QUEUE",
    tone: "border-amber-300/30 bg-amber-300/5",
    description: "Visible when you choose to look. No push.",
  },
  SILENT: {
    label: "SILENT",
    tone: "border-stone-700 bg-stone-900/40",
    description: "Recorded only. Klorn decided this wasn't worth surfacing.",
  },
  AUTO: {
    label: "AUTO",
    tone: "border-emerald-400/30 bg-emerald-500/5",
    description: "Handled without asking. Eligible for auto-execution.",
  },
};

const OVERRIDE_TARGETS: Tier[] = ["SILENT", "QUEUE", "PUSH"];

export default function FirewallPage() {
  return (
    <AuthGuard>
      <FirewallView />
    </AuthGuard>
  );
}

function FirewallView() {
  const { toast } = useToast();
  const [data, setData] = useState<FirewallResponse | null>(null);
  const [receipt, setReceipt] = useState<DailyReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [overriding, setOverriding] = useState<string | null>(null);

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
    } catch (err) {
      // Roll back
      setData((prev) => moveItemBetweenTiers(prev, { ...item, tier: newTier }, item.tier));
      captureClientError(err, { scope: "firewall.override" });
      toast("Could not save tier override.", "error");
    } finally {
      setOverriding(null);
    }
  };

  // Visible columns: PUSH, QUEUE, SILENT. CALL collapses into PUSH for the
  // POC view; AUTO sits below as a one-line summary because the user already
  // chose not to be interrupted by it.
  const visibleColumns = useMemo(() => {
    if (!data) return null;
    return {
      PUSH: [...data.tiers.PUSH, ...data.tiers.CALL],
      QUEUE: data.tiers.QUEUE,
      SILENT: data.tiers.SILENT,
    } as Record<"PUSH" | "QUEUE" | "SILENT", FirewallItem[]>;
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
        <header className="mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-300">
            POC firewall view
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-50 sm:text-3xl">
            Today's attention firewall
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-stone-500">
            Klorn evaluated every signal that hit your inbox today and sorted it into a tier. Move
            anything we got wrong — that override teaches the classifier.
          </p>
        </header>

        <DailyReceiptStrip data={data} receipt={receipt} />

        <div className="mt-6 grid gap-4 md:grid-cols-3">
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
  for (const t of TIER_ORDER.concat(["AUTO", "CALL"])) {
    next.tiers[t] = [...prev.tiers[t]];
  }
  next.tiers[item.tier] = next.tiers[item.tier].filter((row) => row.id !== item.id);
  next.tiers[newTier] = [{ ...item, tier: newTier }, ...next.tiers[newTier]];
  next.summary = {
    SILENT: next.tiers.SILENT.length,
    QUEUE: next.tiers.QUEUE.length,
    PUSH: next.tiers.PUSH.length,
    CALL: next.tiers.CALL.length,
    AUTO: next.tiers.AUTO.length,
    total: prev.summary.total,
  };
  return next;
}

function DailyReceiptStrip({
  data,
  receipt,
}: {
  data: FirewallResponse;
  receipt: DailyReceipt | null;
}) {
  const counts: Array<{ label: string; value: number; tone: string }> = [
    { label: "SILENT", value: data.summary.SILENT, tone: "text-stone-400" },
    { label: "QUEUE", value: data.summary.QUEUE, tone: "text-amber-300" },
    {
      label: "PUSH",
      value: data.summary.PUSH + data.summary.CALL,
      tone: "text-rose-300",
    },
    { label: "AUTO", value: data.summary.AUTO, tone: "text-emerald-300" },
  ];
  return (
    <section className="rounded-xl border border-stone-800 bg-stone-950/40 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {counts.map((c) => (
          <div key={c.label} className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-500">
              {c.label}
            </span>
            <span className={`text-xl font-semibold tabular-nums ${c.tone}`}>{c.value}</span>
          </div>
        ))}
      </div>
      {receipt?.summary?.narrative && (
        <p className="mt-3 border-t border-stone-800 pt-3 text-xs text-stone-500">
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
  tier: "PUSH" | "QUEUE" | "SILENT";
  items: FirewallItem[];
  overrideId: string | null;
  onOverride: (item: FirewallItem, newTier: Tier) => void;
}) {
  const meta = TIER_META[tier];
  return (
    <section className={`rounded-xl border ${meta.tone} p-3`}>
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-200">
          {meta.label}
        </h2>
        <span className="text-xs text-stone-500">{items.length}</span>
      </header>
      <p className="mb-3 text-[11px] leading-5 text-stone-500">{meta.description}</p>

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-stone-800 px-3 py-6 text-center text-xs text-stone-600">
          Nothing here yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <FirewallCard
              key={item.id}
              item={item}
              tier={tier}
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
  overrideId,
  onOverride,
}: {
  item: FirewallItem;
  tier: "PUSH" | "QUEUE" | "SILENT";
  overrideId: string | null;
  onOverride: (item: FirewallItem, newTier: Tier) => void;
}) {
  // Best-effort meaningful heading: actual email subject beats the
  // tool-arg subject beats the agent's auto-title fallback.
  const subject = item.email?.subject || toolSubject(item) || item.title;
  const sender = item.email?.from || toolRecipient(item);
  const snippet = item.email?.snippet || toolBodyPreview(item);

  return (
    <li className="rounded-md border border-stone-800 bg-stone-950/60 p-3 text-sm">
      <p className="line-clamp-2 break-words text-stone-100">{subject}</p>
      {sender && (
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-stone-500">
          {item.email?.trust && <TrustDot trust={item.email.trust} />}
          <span className="truncate">
            {item.email?.from ? "From" : "To"}: {sender}
          </span>
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-stone-600">
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
        <details className="mt-2 rounded border border-stone-800 bg-black/30">
          <summary className="cursor-pointer list-none px-2 py-1.5 text-[11px] text-stone-400 transition hover:text-stone-200">
            Preview
          </summary>
          <p className="line-clamp-6 whitespace-pre-wrap border-t border-stone-800 px-2 py-2 text-[11px] leading-4 text-stone-300">
            {snippet}
          </p>
        </details>
      )}

      {item.tierReason && (
        <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-stone-500">{item.tierReason}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {OVERRIDE_TARGETS.filter((t) => t !== tier).map((target) => (
          <button
            key={target}
            type="button"
            disabled={overrideId === item.id}
            onClick={() => onOverride(item, target)}
            className="inline-flex min-h-7 items-center rounded border border-stone-700 px-2 text-[10px] font-medium uppercase tracking-wider text-stone-400 transition hover:border-amber-300/50 hover:text-amber-200 disabled:opacity-40"
          >
            Move → {target}
          </button>
        ))}
        {item.href && (
          <Link
            href={item.href}
            className="ml-auto text-[11px] text-amber-300/80 transition hover:text-amber-200"
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
  if (count === 0) {
    return (
      <section className="mt-4 rounded-xl border border-stone-800 bg-stone-950/40 p-3 text-xs text-stone-500">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-emerald-300">
          AUTO
        </span>{" "}
        — nothing handled automatically yet.
      </section>
    );
  }
  return (
    <section className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-500/5 p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-200">
          AUTO
        </h2>
        <span className="text-xs text-stone-500">{count}</span>
      </header>
      <p className="mt-1 text-[11px] leading-5 text-stone-500">
        Low-risk, pre-approved. Klorn ran these without interrupting you.
      </p>
      <ul className="mt-2 space-y-1 text-xs text-stone-400">
        {items.slice(0, 5).map((item) => (
          <li key={item.id} className="line-clamp-1">
            · {item.title}
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
