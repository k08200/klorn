"use client";

/**
 * The one request a Klorn drive sheet sends (create, rename, move, delete):
 * at most one at a time, its pending state, and its failure. While it runs
 * the sheet cannot be dismissed (`blocked`), so its answer always lands in
 * the sheet that asked. A failure is shown in the sheet, numbered so the
 * same message is announced again on the next attempt; if the sheet is gone
 * by then (the page changed under it), the failure is a toast instead.
 */

import { useEffect, useRef, useState } from "react";
import { useToast } from "../../components/toast";
import { useT } from "../../lib/i18n";
import type { NameErrorKey } from "./drive-model";
import { reportDriveError } from "./use-klorn-drive";

export interface DialogFailure {
  key: NameErrorKey;
  /** Changes with every failure, the same message included. */
  attempt: number;
}

/**
 * `failureKey` rewords a failure for this sheet (createFailureKey: a "New
 * folder" timeout says to check the list before trying again).
 */
export function useDialogAction(
  scope: string,
  failureKey: (key: NameErrorKey) => NameErrorKey = (key) => key,
) {
  const { t } = useT();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<DialogFailure | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fail = (key: NameErrorKey) =>
    setFailure((last) => ({ key, attempt: (last?.attempt ?? 0) + 1 }));

  /** Runs the request unless one is running; true when it succeeded. */
  const run = async (request: () => Promise<void>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    try {
      await request();
      return true;
    } catch (err) {
      const key = failureKey(reportDriveError(err, scope));
      if (mounted.current) fail(key);
      else toast(t(key), "error");
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return {
    pending,
    failure,
    fail,
    run,
    /** True while a request runs: Cancel, Escape and the scrim do nothing. */
    blocked: () => busy.current,
  };
}
