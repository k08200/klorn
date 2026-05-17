"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { apiFetch } from "../../lib/api";
import { captureClientError } from "../../lib/sentry";

type TrustBadge = "reliable" | "mostly_reliable" | "unreliable" | "unknown";

interface TrustScore {
  badge: TrustBadge;
  label: string;
  totalCount: number;
  onTimeCount: number;
  onTimeRate: number;
  avgDelayDays: number;
}

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  notes: string | null;
  tags: string | null;
  trust: TrustScore | null;
}

const BADGE_META: Record<TrustBadge, { label: string; color: string; dot: string }> = {
  reliable: {
    label: "Reliable",
    color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
    dot: "bg-emerald-400",
  },
  mostly_reliable: {
    label: "Mostly reliable",
    color: "text-amber-400 bg-amber-400/10 border-amber-400/20",
    dot: "bg-amber-400",
  },
  unreliable: {
    label: "Unreliable",
    color: "text-red-400 bg-red-400/10 border-red-400/20",
    dot: "bg-red-400",
  },
  unknown: {
    label: "Unknown",
    color: "text-stone-500 bg-stone-800/40 border-stone-700",
    dot: "bg-stone-600",
  },
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function TrustBadgeChip({ badge }: { badge: TrustBadge }) {
  const meta = BADGE_META[badge];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.color}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function OnTimeBar({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  const color = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-stone-400">{pct}%</span>
    </div>
  );
}

function ContactCard({ contact }: { contact: Contact }) {
  const badge = contact.trust?.badge ?? "unknown";
  const ini = initials(contact.name);

  return (
    <div className="group flex items-start gap-3 rounded-xl border border-stone-800 bg-stone-900/40 px-4 py-3 transition hover:border-stone-700 hover:bg-stone-900/70">
      {/* Avatar */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-stone-600 to-stone-800 text-xs font-bold text-stone-200">
        {ini}
      </div>

      {/* Main info */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-stone-100">{contact.name}</span>
          <TrustBadgeChip badge={badge} />
        </div>
        {(contact.company || contact.role) && (
          <p className="mt-0.5 text-[12px] text-stone-500">
            {[contact.role, contact.company].filter(Boolean).join(" · ")}
          </p>
        )}
        {contact.email && (
          <p className="mt-0.5 text-[11px] text-stone-600">{contact.email}</p>
        )}
      </div>

      {/* Trust stats */}
      <div className="shrink-0 text-right">
        {contact.trust && contact.trust.totalCount > 0 ? (
          <div className="space-y-1">
            <OnTimeBar rate={contact.trust.onTimeRate} />
            <p className="text-[10px] text-stone-600">
              {contact.trust.totalCount} commitment{contact.trust.totalCount !== 1 ? "s" : ""}
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-stone-700">No data</p>
        )}
      </div>
    </div>
  );
}

function ContactsContent() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback((q: string) => {
    setLoading(true);
    const qs = q ? `?search=${encodeURIComponent(q)}` : "";
    apiFetch<{ contacts: Contact[] }>(`/api/contacts/with-trust${qs}`)
      .then((data) => setContacts(data.contacts))
      .catch((err) => captureClientError(err, { scope: "contacts.load" }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => load(search), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search, load]);

  const reliable = contacts.filter((c) => c.trust?.badge === "reliable");
  const mostly = contacts.filter((c) => c.trust?.badge === "mostly_reliable");
  const unreliable = contacts.filter((c) => c.trust?.badge === "unreliable");
  const unknown = contacts.filter((c) => !c.trust || c.trust.badge === "unknown");

  const groups: { label: string; items: Contact[] }[] = [
    { label: "Reliable", items: reliable },
    { label: "Mostly reliable", items: mostly },
    { label: "Unreliable", items: unreliable },
    { label: "No data yet", items: unknown },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="flex h-dvh flex-col bg-[#0f1115]">
      {/* Header */}
      <div className="border-b border-stone-800 px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-stone-100">Contacts</h1>
            <p className="mt-0.5 text-[12px] text-stone-500">
              Sorted by commitment reliability — tracked automatically from your inbox.
            </p>
          </div>
          <div className="relative">
            <svg
              aria-hidden="true"
              className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="w-52 rounded-lg border border-stone-700 bg-stone-900 py-1.5 pl-8 pr-3 text-sm text-stone-300 placeholder-stone-600 focus:border-stone-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30"
              />
            ))}
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <svg
              aria-hidden="true"
              className="mb-4 h-10 w-10 text-stone-700"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <p className="text-sm text-stone-500">
              {search ? "No contacts match your search." : "No contacts yet."}
            </p>
            <p className="mt-1 text-[12px] text-stone-700">
              Contacts are added automatically when EVE tracks commitments from your inbox.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-stone-600">
                  {group.label}
                  <span className="ml-2 font-normal normal-case tracking-normal text-stone-700">
                    {group.items.length}
                  </span>
                </p>
                <div className="space-y-2">
                  {group.items.map((c) => (
                    <ContactCard key={c.id} contact={c} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ContactsPage() {
  return (
    <AuthGuard>
      <ContactsContent />
    </AuthGuard>
  );
}
