"use client";

import type { OrgViewResponse } from "@klorn/contract";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import { captureClientError } from "../../../../lib/sentry";
import { apiErrorCode, orgErrorKey } from "./model";

/** The current organization view; `undefined` while loading, kept when a reload fails. */
export function useOrgView() {
  const [view, setView] = useState<OrgViewResponse | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      setView(await apiFetch<OrgViewResponse>("/api/orgs/current"));
      setFailed(false);
    } catch (err) {
      // The last good view stays on screen; `failed` only adds a retry line.
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
      // A refusal the server explained (it carries a code) is expected;
      // anything else is reported.
      if (apiErrorCode(err) === null) captureClientError(err, { scope: "org.action" });
      setErrorKey(orgErrorKey(err));
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

/** A list a panel loads itself: its rows, whether the last load failed, and a reload. */
export function useOrgList<T>(path: string, pick: (body: unknown) => T[], scope: string) {
  const [rows, setRows] = useState<T[]>([]);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setRows(pick(await apiFetch<unknown>(path)));
      setFailed(false);
    } catch (err) {
      captureClientError(err, { scope });
      setFailed(true);
    }
  }, [path, pick, scope]);
  useEffect(() => {
    void load();
  }, [load]);
  return { rows, failed, load };
}
