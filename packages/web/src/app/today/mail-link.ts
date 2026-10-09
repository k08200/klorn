/**
 * Open Mail on one lane. Mail v2 keeps its view (lane, account, filter) in
 * sessionStorage and restores it on mount, so writing the view before the
 * navigation is what preselects the lane. The key and shape are Mail v2's
 * (app/email/_v2/use-view-state.ts). The legacy list ignores it.
 */

import type { LiveTier } from "@klorn/contract";
import { ALL_ACCOUNTS } from "../email/_v2/model";

const MAIL_VIEW_STORAGE_KEY = "klorn.mailV2.view";

export const MAIL_HREF = "/email";

export function preselectMailLane(lane: LiveTier): void {
  try {
    window.sessionStorage.setItem(
      MAIL_VIEW_STORAGE_KEY,
      JSON.stringify({ lane, account: ALL_ACCOUNTS, filter: "none" }),
    );
  } catch {
    // Storage unavailable: Mail opens on its default lane.
  }
}
