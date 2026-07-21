"use client";

import Link from "next/link";
import { useState } from "react";
import AuthScreen from "@/components/auth-screen";
import { Input, Textarea } from "@/components/ui/input";
import { API_BASE } from "@/lib/api";

type Status = "idle" | "submitting" | "success" | "already" | "error";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/;

export default function EarlyAccessPage() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const resetFormError = () => {
    if (errorMsg) setErrorMsg(null);
    if (emailError) setEmailError(null);
    if (status === "error") setStatus("idle");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setEmailError(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) {
      // Field-associated inline error (WCAG 3.3.1): attach to the email input.
      setEmailError("Enter a valid email address.");
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
      setErrorMsg(
        "We could not reach the waitlist server. Check your connection and try again, or email hello@klorn.ai if this keeps happening.",
      );
    }
  };

  const isDone = status === "success" || status === "already";

  return (
    <AuthScreen
      eyebrow="Early access"
      title="Apply for the private Klorn beta"
      description="Klorn uses Gmail's restricted scope and is in Google OAuth testing mode until CASA review clears. I have to add your Google email as a test user before login works — this form is that request."
      navCtaHref="/login"
      navCtaLabel="Log in"
      asideTitle="What happens after you submit"
      asideBody="Three steps. The third one is the one you actually wait on."
      asideItems={[
        {
          label: "1. Submit",
          value: "Your email lands in my inbox as a noreply@klorn.ai alert.",
        },
        {
          label: "2. Approve",
          value:
            "I add you to Google Cloud Console as a test user (~30 seconds). Within 5 min when I'm awake (KST), within a few hours otherwise.",
        },
        {
          label: "3. Log in",
          value:
            "You get an email from noreply@klorn.ai. Open klorn.ai/login, Continue with Google — works.",
        },
      ]}
      footer={
        <span>
          <Link
            href="/privacy"
            className="inline-flex min-h-10 items-center px-1 transition hover:text-slate-500"
          >
            Privacy
          </Link>
          <span className="mx-2 text-slate-300">/</span>
          <Link
            href="/terms"
            className="inline-flex min-h-10 items-center px-1 transition hover:text-slate-500"
          >
            Terms
          </Link>
        </span>
      }
    >
      {isDone ? (
        <div>
          <div className="rounded-md border border-sky-300/25 bg-sky-300/10 p-4">
            <h2 className="text-base font-semibold text-slate-900">
              {status === "already"
                ? "You're already on the list"
                : "Request received — here's what's next"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              {status === "already" ? (
                <>
                  Your previous request is still in the queue. If it's been more than a few hours
                  and you haven't heard back, email{" "}
                  <a
                    href="mailto:k0820086@gmail.com"
                    className="underline decoration-stone-600 underline-offset-2 hover:text-slate-900"
                  >
                    k0820086@gmail.com
                  </a>{" "}
                  with the same email and I'll surface it.
                </>
              ) : (
                <>
                  I'll add you to Google Cloud Console as a test user{" "}
                  <span className="font-medium text-slate-900">within 5 minutes</span> if I'm awake
                  (KST), otherwise within a few hours. You'll get an email from{" "}
                  <span className="font-mono text-slate-900">noreply@klorn.ai</span> the moment
                  you're approved — then{" "}
                  <Link
                    href="/login"
                    className="underline decoration-sky-400/60 underline-offset-2 hover:text-sky-100"
                  >
                    Log in
                  </Link>{" "}
                  works.
                </>
              )}
            </p>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Link
              href="/"
              className="flex min-h-11 items-center justify-center rounded-md bg-sky-500 text-sm font-semibold text-stone-950 transition hover:bg-sky-200"
            >
              Back home
            </Link>
            <Link
              href="/login"
              className="flex min-h-11 items-center justify-center rounded-md border border-slate-200 text-sm text-slate-500 transition hover:border-slate-200"
            >
              Log in after approval
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Input
            id="email"
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => {
              resetFormError();
              setEmail(e.target.value);
            }}
            placeholder="you@example.com"
            error={emailError ?? undefined}
          />

          <Input
            id="name"
            label="Name (optional)"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => {
              resetFormError();
              setName(e.target.value);
            }}
            maxLength={120}
            placeholder="Optional"
          />

          <div>
            <Textarea
              id="useCase"
              label="Work pattern (optional)"
              value={useCase}
              onChange={(e) => {
                resetFormError();
                setUseCase(e.target.value);
              }}
              maxLength={500}
              rows={3}
              placeholder="Example: 50+ emails/day, follow-ups, meeting prep."
            />
            <p className="mt-2 text-xs leading-5 text-slate-400">
              This helps us understand which workflow to tune first.
            </p>
          </div>

          {errorMsg && (
            <p
              role="alert"
              className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
            >
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            disabled={status === "submitting"}
            className="flex h-11 w-full items-center justify-center rounded-md bg-sky-500 text-sm font-semibold text-stone-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          >
            {status === "submitting" ? "Submitting..." : "Request early access"}
          </button>

          <p className="text-xs leading-5 text-slate-400">
            By applying, you agree to the{" "}
            <Link
              href="/privacy"
              className="inline-flex min-h-10 items-center underline hover:text-slate-500"
            >
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link
              href="/terms"
              className="inline-flex min-h-10 items-center underline hover:text-slate-500"
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
