"use client";

import Link from "next/link";
import { useState } from "react";
import AuthScreen from "@/components/auth-screen";
import { API_BASE } from "@/lib/api";

type Status = "idle" | "submitting" | "success" | "already" | "error";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/;

export default function EarlyAccessPage() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const resetFormError = () => {
    if (errorMsg) setErrorMsg(null);
    if (status === "error") setStatus("idle");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) {
      setErrorMsg("Enter a valid email address.");
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch(`${API_BASE}/api/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cleanEmail,
          name: name.trim() || undefined,
          useCase: useCase.trim() || undefined,
        }),
      });

      if (res.status === 429) {
        setStatus("error");
        setErrorMsg("Too many requests. Please try again shortly.");
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setErrorMsg(body.error || "Something went wrong. Please try again shortly.");
        return;
      }

      const body = (await res.json()) as { ok: boolean; alreadyOnList?: boolean };
      setStatus(body.alreadyOnList ? "already" : "success");
    } catch (_err) {
      setStatus("error");
      setErrorMsg("Waitlist service is offline. Please try again shortly.");
    }
  };

  const isDone = status === "success" || status === "already";

  return (
    <AuthScreen
      eyebrow="Early access"
      title="Apply for the private Jigeum beta"
      description="We are inviting teams that live in mail, meetings, and follow-ups first."
      navCtaHref="/login"
      navCtaLabel="Log in"
      asideTitle="A focused beta for busy operators"
      asideBody="We review teams where mail, meetings, and follow-ups create real decision load."
      asideItems={[
        { label: "Apply", value: "Leave your email and the work pattern you want organized." },
        { label: "Review", value: "We check beta fit within 24 hours." },
        { label: "Invite", value: "Approved teams receive access by email." },
      ]}
      footer={
        <span>
          <Link
            href="/privacy"
            className="inline-flex min-h-10 items-center px-1 transition hover:text-stone-300"
          >
            Privacy
          </Link>
          <span className="mx-2 text-stone-700">/</span>
          <Link
            href="/terms"
            className="inline-flex min-h-10 items-center px-1 transition hover:text-stone-300"
          >
            Terms
          </Link>
        </span>
      }
    >
      {isDone ? (
        <div>
          <div className="rounded-md border border-amber-300/25 bg-amber-300/10 p-4">
            <h2 className="text-base font-semibold text-white">
              {status === "already" ? "You are already on the list" : "Request received"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-stone-300">
              {status === "already"
                ? "We will review your existing request and follow up by email."
                : "We will review within 24 hours. If invited, you can sign in to Jigeum."}
            </p>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Link
              href="/"
              className="flex h-10 items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
            >
              Back home
            </Link>
            <Link
              href="/login"
              className="flex h-10 items-center justify-center rounded-md border border-stone-700 text-sm text-stone-300 transition hover:border-stone-500"
            >
              Log in after approval
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-stone-400" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => {
                resetFormError();
                setEmail(e.target.value);
              }}
              className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-white outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-stone-400" htmlFor="name">
              Name (optional)
            </label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => {
                resetFormError();
                setName(e.target.value);
              }}
              maxLength={120}
              className="w-full rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-white outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
              placeholder="Optional"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-stone-400" htmlFor="useCase">
              Work pattern (optional)
            </label>
            <textarea
              id="useCase"
              value={useCase}
              onChange={(e) => {
                resetFormError();
                setUseCase(e.target.value);
              }}
              maxLength={500}
              rows={3}
              className="w-full resize-none rounded-md border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-white outline-none transition placeholder:text-stone-600 focus:border-amber-300 focus:ring-1 focus:ring-amber-300/25"
              placeholder="Example: 50+ emails/day, follow-ups, meeting prep."
            />
            <p className="mt-2 text-xs leading-5 text-stone-500">
              This helps us understand which workflow to tune first.
            </p>
          </div>

          {errorMsg && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            disabled={status === "submitting"}
            className="flex h-11 w-full items-center justify-center rounded-md bg-amber-300 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
          >
            {status === "submitting" ? "Submitting..." : "Request early access"}
          </button>

          <p className="text-xs leading-5 text-stone-500">
            By applying, you agree to the{" "}
            <Link
              href="/privacy"
              className="inline-flex min-h-10 items-center underline hover:text-stone-300"
            >
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link
              href="/terms"
              className="inline-flex min-h-10 items-center underline hover:text-stone-300"
            >
              Terms
            </Link>
            .
          </p>
        </form>
      )}
    </AuthScreen>
  );
}
