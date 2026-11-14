"use client";

/**
 * "Delivered to" for bell rows, loaded lazily once the panel opens:
 * GET /api/notifications/:id/delivery per row (newest first, capped). The
 * route is rolling out server-side, so the first 404 marks it missing and the
 * hook stops asking for the rest of the page session. Any other failure only
 * leaves that row without the line.
 */

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import {
  type CenterNotification,
  deliveryPath,
  isMissingRoute,
  parseDeliveryResponse,
} from "../../lib/notification-center";

/** Rows looked up per panel open; the rest stay without the line. */
const LOOKUP_CAP = 12;

let routeMissing = false;

export function useDeliveredTo(
  open: boolean,
  rows: readonly CenterNotification[],
): Record<string, string | null> {
  const [labels, setLabels] = useState<Record<string, string | null>>({});
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open || routeMissing) return;
    const ids = rows
      .filter((n) => n.deliveredTo === undefined && !requested.current.has(n.id))
      .slice(0, LOOKUP_CAP)
      .map((n) => n.id);
    if (ids.length === 0) return;
    let live = true;
    for (const id of ids) requested.current.add(id);
    void (async () => {
      for (const id of ids) {
        if (routeMissing || !live) return;
        try {
          const label = parseDeliveryResponse(await apiFetch<unknown>(deliveryPath(id)));
          if (live) setLabels((prev) => ({ ...prev, [id]: label }));
        } catch (err) {
          if (isMissingRoute(err)) {
            routeMissing = true;
            return;
          }
          console.error("[notification-center] delivery lookup failed", err);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [open, rows]);

  return labels;
}
