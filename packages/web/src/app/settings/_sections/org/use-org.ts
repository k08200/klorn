"use client";

import type { OrgViewResponse } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import { captureClientError } from "../../../../lib/sentry";
import { orgErrorKey } from "./model";

/** The current organization view; `undefined` while loading. */
export function useOrgView() {
  const [view, setView] = useState<OrgViewResponse | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      setView(await apiFetch<OrgViewResponse>("/api/orgs/current"));
      setFailed(false);
    } catch (err) {
      captureClientError(err, { scope: "org.load" });
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { view, failed, reload };
}

/** Runs one org change at a time, keeping the localized error key of a refusal. */
export function useOrgAction() {
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setErrorKey(null);
    try {
      await work();
      return true;
    } catch (err) {
      const key = orgErrorKey(err);
      // A refusal the server explained is expected; anything else is reported.
      if (key === "settings.org.error.generic") captureClientError(err, { scope: "org.action" });
      setErrorKey(key);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, errorKey, run };
}

export function jsonBody(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}
