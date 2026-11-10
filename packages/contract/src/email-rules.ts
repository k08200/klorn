/**
 * Wire contract for user-authored tier pins under `/api/email/rules` — the
 * settings Rules section and the natural-language rule compiler. Pins exist
 * at exactly two levels (founder decision 2026-08-27): an exact address or
 * an exact domain, each mapped to one live lane. Anything else a rule text
 * asks for comes back in `unsupported`, verbatim — never silently dropped.
 */

import type { LiveTier } from "./firewall.js";

export type TierPinScope = "sender" | "domain";

/** One pin as proposed (compiler output) or submitted (apply input). */
export interface TierPinInput {
  scope: TierPinScope;
  /** Bare lowercased address (a@b.com) or bare domain (b.com). */
  value: string;
  tier: LiveTier;
}

/** One stored pin, id included so the client can delete it. */
export interface TierPinWire extends TierPinInput {
  id: string;
}

/** `GET /api/email/rules/pins` */
export interface TierPinsListResponse {
  pins: TierPinWire[];
}

/** `POST /api/email/rules/compile` */
export interface CompileRulesRequest {
  text: string;
}
export interface CompileRulesResponse {
  pins: TierPinInput[];
  /** Clauses the two pin levels cannot express, in the user's own words. */
  unsupported: string[];
}

/** `POST /api/email/rules/pins` */
export interface ApplyTierPinsRequest {
  pins: TierPinInput[];
}
export interface ApplyTierPinsResponse {
  applied: TierPinWire[];
  /** Rejected entries echo the submitted values verbatim — they may not be
   * valid TierPinInput, that being the reason they were rejected. */
  rejected: Array<{
    pin: { scope: string; value: string; tier: string };
    reason: string;
  }>;
}
