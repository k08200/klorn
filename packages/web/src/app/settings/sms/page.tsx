"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";

interface SmsPhoneResponse {
  phone: string | null;
  usage: { used: number; cap: number; resetAt: string };
}

interface TestSendResult {
  sent: boolean;
  reason?: string;
}

const E164_HINT = "E.164 format, e.g. +821012345678";

function SmsContent() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  // Admin-only page. Redirect non-admins (the server also enforces this; the
  // redirect just keeps the URL out of the regular settings nav for users
  // who would only see a 403).
  useEffect(() => {
    if (authLoading) return;
    if (user && user.role !== "ADMIN") {
      router.replace("/settings");
    }
  }, [authLoading, user, router]);

  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const phoneQuery = useQuery({
    queryKey: queryKeys.sms.phone(),
    queryFn: async () => {
      try {
        return await apiFetch<SmsPhoneResponse>("/api/sms/phone");
      } catch (err) {
        captureClientError(err, { scope: "sms.phone.load" });
        throw err;
      }
    },
    enabled: !authLoading && user?.role === "ADMIN",
  });

  useEffect(() => {
    if (phoneQuery.data?.phone && !draft) {
      setDraft(phoneQuery.data.phone);
    }
  }, [phoneQuery.data?.phone, draft]);

  const saveMutation = useMutation({
    mutationFn: (phone: string) =>
      apiFetch<SmsPhoneResponse>("/api/sms/phone", {
        method: "POST",
        body: JSON.stringify({ phone }),
      }),
    onSuccess: (data) => {
      setFormError(null);
      queryClient.setQueryData(queryKeys.sms.phone(), data);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to save phone number";
      // Server returns API 400 with helpful message; surface it directly.
      setFormError(
        msg.includes("400") ? "Invalid phone number. Use E.164 (e.g. +821012345678)." : msg,
      );
      captureClientError(err, { scope: "sms.phone.save" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => apiFetch<SmsPhoneResponse>("/api/sms/phone", { method: "DELETE" }),
    onSuccess: () => {
      setDraft("");
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.sms.all });
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      apiFetch<TestSendResult>("/api/sms/test", { method: "POST" }).catch(async (err) => {
        // Server returns 400 with { sent:false, reason } on gate failures.
        if (err instanceof Error && err.message.startsWith("API 400")) {
          return { sent: false, reason: "gate_failed" } satisfies TestSendResult;
        }
        throw err;
      }),
    onSuccess: (data) => {
      if (data.sent) setTestResult("Test SMS sent. Check your phone.");
      else setTestResult(`Test SMS not sent: ${data.reason ?? "unknown"}`);
      // Usage may have moved.
      queryClient.invalidateQueries({ queryKey: queryKeys.sms.all });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Test SMS failed";
      setTestResult(msg);
      captureClientError(err, { scope: "sms.test" });
    },
  });

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setTestResult(null);
    const trimmed = draft.trim();
    if (!trimmed) {
      setFormError("Enter a phone number first.");
      return;
    }
    saveMutation.mutate(trimmed);
  };

  if (authLoading || (user && user.role !== "ADMIN")) {
    return (
      <div className="min-h-dvh bg-[#0f1115]">
        <div className="mx-auto max-w-xl px-6 py-8 text-sm text-stone-500">Loading…</div>
      </div>
    );
  }

  const saved = phoneQuery.data?.phone ?? null;
  const usage = phoneQuery.data?.usage;

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-stone-100">SMS alerts (admin)</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            Klorn will text you for URGENT email + meeting alerts on top of the existing web push.
            Admin-only while we dogfood. Hard cap of {usage?.cap ?? 10} messages per day.
          </p>
        </div>

        <form
          onSubmit={handleSave}
          className="space-y-3 rounded-xl border border-stone-800 bg-stone-900/40 p-4"
        >
          <label htmlFor="sms-phone" className="block text-[12px] font-medium text-stone-300">
            Phone number
          </label>
          <input
            id="sms-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="+821012345678"
            className="w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-400 focus:border-amber-400/50 focus:outline-none"
          />
          <p className="text-[11px] text-stone-500">{E164_HINT}</p>

          {formError && <p className="text-[12px] text-rose-400">{formError}</p>}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-[12px] font-medium text-amber-200 transition hover:bg-amber-300/15 disabled:opacity-50"
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </button>

            <button
              type="button"
              disabled={!saved || removeMutation.isPending}
              onClick={() => removeMutation.mutate()}
              className="rounded-lg border border-stone-700 px-3 py-1.5 text-[12px] font-medium text-stone-400 transition hover:bg-stone-800 disabled:opacity-40"
            >
              {removeMutation.isPending ? "Removing…" : "Remove"}
            </button>

            <button
              type="button"
              disabled={!saved || testMutation.isPending}
              onClick={() => {
                setTestResult(null);
                testMutation.mutate();
              }}
              className="rounded-lg border border-sky-400/25 bg-sky-400/10 px-3 py-1.5 text-[12px] font-medium text-sky-200 transition hover:bg-sky-400/15 disabled:opacity-40"
            >
              {testMutation.isPending ? "Sending…" : "Send test SMS"}
            </button>
          </div>

          {testResult && <p className="text-[12px] text-stone-400">{testResult}</p>}
        </form>

        {saved && usage && (
          <div className="mt-4 rounded-xl border border-stone-800 bg-stone-900/30 p-4 text-[12px] text-stone-500">
            <div>
              <span className="font-medium text-stone-300">Current:</span> {saved}
            </div>
            <div className="mt-1">
              Today: {usage.used} / {usage.cap} (resets at UTC midnight)
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SmsSettingsPage() {
  return (
    <AuthGuard>
      <SmsContent />
    </AuthGuard>
  );
}
