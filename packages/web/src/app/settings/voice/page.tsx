"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGuard from "../../../components/auth-guard";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";

type Tone = "formal" | "casual" | "warm" | "direct" | "mixed";

interface VoiceProfile {
  tone: Tone;
  avgLengthWords: number;
  closingPhrases: string[];
  keyTraits: string[];
  exampleOpeners: string[];
  confidence: number;
  sampledAt: string;
}

const TONE_META: Record<Tone, { label: string; description: string; className: string }> = {
  formal: {
    label: "Formal",
    description: "Polished and structured.",
    className: "border-stone-700 bg-stone-800/40 text-stone-300",
  },
  casual: {
    label: "Casual",
    description: "Relaxed and approachable.",
    className: "border-amber-400/20 bg-amber-400/10 text-amber-300",
  },
  warm: {
    label: "Warm",
    description: "Friendly and personable.",
    className: "border-rose-400/20 bg-rose-400/10 text-rose-300",
  },
  direct: {
    label: "Direct",
    description: "Concise and to-the-point.",
    className: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  },
  mixed: {
    label: "Mixed",
    description: "Adapts to the recipient.",
    className: "border-stone-700 bg-stone-800/40 text-stone-300",
  },
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-stone-600";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-stone-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-stone-400">{pct}%</span>
    </div>
  );
}

function VoiceContent() {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<{ profile: VoiceProfile | null }>("/api/voice-profile")
      .then((res) => setProfile(res.profile))
      .catch((err) => captureClientError(err, { scope: "voice-profile.load" }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await apiFetch<{ profile: VoiceProfile | null }>("/api/voice-profile/refresh", {
        method: "POST",
      });
      setProfile(res.profile);
      if (!res.profile) {
        setRefreshError("Not enough sent mail to build a profile yet.");
      }
    } catch (err) {
      captureClientError(err, { scope: "voice-profile.refresh" });
      setRefreshError("Could not refresh. Try again in a moment.");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[#0f1115]">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-stone-100">Voice profile</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            What EVE has learned about your writing style from your sent mail. Used to draft replies
            that sound like you.
          </p>
        </div>

        {loading ? (
          <div className="h-48 animate-pulse rounded-xl border border-stone-800 bg-stone-900/30" />
        ) : profile ? (
          <>
            <section className="rounded-2xl border border-stone-800 bg-stone-900/40 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span
                    className={`inline-block rounded-full border px-2.5 py-1 text-[11px] font-medium ${TONE_META[profile.tone].className}`}
                  >
                    {TONE_META[profile.tone].label}
                  </span>
                  <p className="mt-2 text-[12px] text-stone-500">
                    {TONE_META[profile.tone].description}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-stone-600">Confidence</p>
                  <div className="mt-1">
                    <ConfidenceBar value={profile.confidence} />
                  </div>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2 border-t border-stone-800 pt-4">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-stone-600">
                    Typical length
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-stone-200">
                    ~{profile.avgLengthWords} words
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-stone-600">Sampled</p>
                  <p className="mt-0.5 text-sm font-medium text-stone-200">
                    {new Date(profile.sampledAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
              </div>
            </section>

            {profile.keyTraits.length > 0 && (
              <section className="mt-4 rounded-xl border border-stone-800 bg-stone-900/30 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">
                  Key traits
                </p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {profile.keyTraits.map((trait) => (
                    <li
                      key={trait}
                      className="rounded-full border border-stone-700 bg-stone-800/40 px-2.5 py-0.5 text-[12px] text-stone-300"
                    >
                      {trait}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {profile.closingPhrases.length > 0 && (
              <section className="mt-4 rounded-xl border border-stone-800 bg-stone-900/30 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">
                  Closing phrases
                </p>
                <ul className="mt-2 space-y-1">
                  {profile.closingPhrases.map((phrase) => (
                    <li
                      key={phrase}
                      className="rounded-md border border-stone-800 bg-black/20 px-2 py-1 font-mono text-[12px] text-stone-400"
                    >
                      {phrase}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {profile.exampleOpeners.length > 0 && (
              <section className="mt-4 rounded-xl border border-stone-800 bg-stone-900/30 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">
                  Example openers
                </p>
                <ul className="mt-2 space-y-1">
                  {profile.exampleOpeners.map((opener) => (
                    <li
                      key={opener}
                      className="rounded-md border border-stone-800 bg-black/20 px-2 py-1 font-mono text-[12px] text-stone-400"
                    >
                      {opener}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-stone-800 bg-stone-900/20 py-10 text-center">
            <p className="text-sm text-stone-400">No voice profile yet.</p>
            <p className="mt-1 text-[12px] text-stone-600">
              EVE needs at least a few sent emails to learn your style. Try refreshing once you have
              some sent mail.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="rounded-lg border border-stone-700 px-3 py-1.5 text-[12px] text-stone-300 transition hover:border-stone-500 hover:text-stone-100 disabled:opacity-50"
          >
            {refreshing ? "Analyzing sent mail…" : "Refresh profile"}
          </button>
          {refreshError && <span className="text-[12px] text-red-400">{refreshError}</span>}
        </div>

        <p className="mt-6 text-[11px] leading-5 text-stone-600">
          Bodies are sent to your configured LLM only for analysis and never persisted. The profile
          itself is stored locally with your account memory.
        </p>
      </div>
    </div>
  );
}

export default function VoicePage() {
  return (
    <AuthGuard>
      <VoiceContent />
    </AuthGuard>
  );
}
