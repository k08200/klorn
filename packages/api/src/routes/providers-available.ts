/**
 * GET /api/providers/available — which account types this deployment can
 * connect (productization plan P8). The first run's provider grid draws its
 * tiles from this, so a provider whose connector flag is off is never offered.
 *
 * Read-only and the same for every signed-in user: it reports deployment
 * facts (flags, and whether the Outlook app registration is present), never a
 * value. Behind ONBOARDING_V2 via darkRouteGate: while off it answers
 * Fastify's default 404 before authentication, so the surface is the same as
 * the route not existing.
 */

import type { ProviderAvailability, ProvidersAvailableResponse } from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import {
  caldavCalendarEnabled,
  genericImapEnabled,
  icloudInboxEnabled,
  imapActionsEnabled,
  imapMoveActionsEnabled,
  imapSendEnabled,
  MULTI_INBOX_SYNC_ENABLED,
  onboardingV2Enabled,
  outlookCalendarEnabled,
  outlookInboxEnabled,
} from "../config.js";
import { outlookConfigured } from "../mail/outlook-oauth.js";
import { darkRouteGate } from "./dark-route-gate.js";

/** One read per first-run screen, plus retries. */
const AVAILABLE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

/** The deployment facts the answer is computed from; injected so it is testable. */
export interface ProviderFacts {
  multiInboxSync: boolean;
  outlookInbox: boolean;
  outlookConfigured: boolean;
  outlookCalendar: boolean;
  icloudInbox: boolean;
  genericImap: boolean;
  caldavCalendar: boolean;
  imapActions: boolean;
  imapMoveActions: boolean;
  imapSend: boolean;
}

export function readProviderFacts(): ProviderFacts {
  return {
    multiInboxSync: MULTI_INBOX_SYNC_ENABLED,
    outlookInbox: outlookInboxEnabled(),
    outlookConfigured: outlookConfigured(),
    outlookCalendar: outlookCalendarEnabled(),
    icloudInbox: icloudInboxEnabled(),
    genericImap: genericImapEnabled(),
    caldavCalendar: caldavCalendarEnabled(),
    imapActions: imapActionsEnabled(),
    imapMoveActions: imapMoveActionsEnabled(),
    imapSend: imapSendEnabled(),
  };
}

/**
 * The connectable providers, in display order. Google and Naver predate the
 * flag doctrine and are always listed; the others appear only while their
 * connector is on (Outlook also needs its app registration, without which the
 * link route answers 503). Mirrors mail/providers/dispatch.ts for `readOnly`:
 * generic IMAP never sends, so only its flag and move actions count.
 */
export function availableProviders(facts: ProviderFacts): ProviderAvailability[] {
  const imapWrites = facts.imapActions || facts.imapMoveActions;
  const providers: ProviderAvailability[] = [
    {
      provider: "GOOGLE",
      calendar: true,
      readOnly: false,
      additionalAccounts: facts.multiInboxSync,
    },
  ];
  if (facts.outlookInbox && facts.outlookConfigured) {
    providers.push({
      provider: "OUTLOOK",
      calendar: facts.outlookCalendar,
      readOnly: false,
      additionalAccounts: true,
    });
  }
  providers.push({
    provider: "NAVER",
    calendar: facts.caldavCalendar,
    readOnly: !(imapWrites || facts.imapSend),
    additionalAccounts: true,
  });
  if (facts.icloudInbox) {
    providers.push({
      provider: "ICLOUD",
      calendar: facts.caldavCalendar,
      readOnly: !(imapWrites || facts.imapSend),
      additionalAccounts: true,
    });
  }
  if (facts.genericImap) {
    providers.push({
      provider: "IMAP",
      calendar: false,
      readOnly: !imapWrites,
      additionalAccounts: true,
    });
  }
  return providers;
}

export async function providersAvailableRoutes(app: FastifyInstance) {
  app.addHook("onRequest", darkRouteGate(onboardingV2Enabled));
  app.addHook("preHandler", requireAuth);

  app.get(
    "/available",
    { config: { rateLimit: AVAILABLE_RATE_LIMIT } },
    async (): Promise<ProvidersAvailableResponse> => ({
      providers: availableProviders(readProviderFacts()),
    }),
  );
}
