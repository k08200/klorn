"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import {
  type DailyReceipt,
  FirewallBoard,
  type FirewallItem,
  type FirewallResponse,
  moveItemBetweenTiers,
  type Tier,
} from "../../../components/firewall-board";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

// How often the firewall view re-pulls while the tab is focused.
const FIREWALL_REFRESH_MS = 45_000;

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
    } catch (err) {
      // Roll back
      setData((prev) => moveItemBetweenTiers(prev, { ...item, tier: newTier }, item.tier));
      captureClientError(err, { scope: "firewall.override" });
      toast("Could not save tier override.", "error");
    } finally {
      setOverriding(null);
    }
  };

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
    <FirewallBoard data={data} receipt={receipt} overriding={overriding} onOverride={override} />
  );
}
