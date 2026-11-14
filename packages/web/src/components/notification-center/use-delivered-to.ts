"use client";

/**
 * "Delivered to" for bell rows, loaded lazily once the panel opens:
 * GET /api/notifications/:id/delivery per row (newest first, capped). A 404
 * disables only that row for the page session (the row is not yours, or was
 * deleted after the list loaded); only a 404 whose body proves the route is
 * missing stops every row (lib/notification-center.ts deliveryFailureKind).
 * Any other failure only leaves that row without the line this time.
 */

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import {
  type CenterNotification,
  createDeliveryLookupMemo,
  deliveryPath,
  parseDeliveryResponse,
} from "../../lib/notification-center";

/** Rows looked up per panel open; the rest stay without the line. */
const LOOKUP_CAP = 12;

/** Per page session: rows that answered 404, and whether the route is proven missing. */
const memo = createDeliveryLookupMemo();

export function useDeliveredTo(
  open: boolean,
  rows: readonly CenterNotification[],
): Record<string, string | null> {
  const [labels, setLabels] = useState<Record<string, string | null>>({});
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open || memo.routeMissing()) return;
    const ids = rows
      .filter((n) => memo.shouldLookup(n.id) && !requested.current.has(n.id))
      .slice(0, LOOKUP_CAP)
      .map((n) => n.id);
    if (ids.length === 0) return;
    let live = true;
    for (const id of ids) requested.current.add(id);
    void (async () => {
      for (const id of ids) {
        if (memo.routeMissing() || !live) return;
        try {
          const label = parseDeliveryResponse(await apiFetch<unknown>(deliveryPath(id)));
          if (live) setLabels((prev) => ({ ...prev, [id]: label }));
        } catch (err) {
          const kind = memo.recordFailure(id, err);
          if (kind === "route-missing") return;
          if (kind === "other") console.error("[notification-center] delivery lookup failed", err);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [open, rows]);

  return labels;
}
