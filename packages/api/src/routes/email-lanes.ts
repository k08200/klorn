/**
 * Lane routes (productization plan P5/P6). Registered against the email
 * plugin, so they inherit its requireAuth + requireAppAccess hooks. Two
 * readers: Mail v2 (MAIL_V2) and Today (UNIFIED_HOME). While both are off the
 * route answers Fastify's own 404.
 */

import type {
  EmailLaneCountsResponse,
  EmailReaderContextResponse,
  LiveTier,
  ReaderSenderLabel,
} from "@klorn/contract";
import type { FastifyInstance } from "fastify";
import { getUserId } from "../auth.js";
import { laneReadsEnabled, mailV2Enabled } from "../config.js";
import { prisma } from "../db.js";
import {
  countEmailsByLane,
  foldLaneCounts,
  isLanePageFilter,
  LANE_FILTERS,
  type LaneFilter,
  neighbourEmailIdsInLane,
  parseLaneFilter,
  resolveInboxScope,
} from "../judge/email-lanes.js";
import { gmailCategoryOf, rowSignalFor } from "../judge/row-signals.js";
import { resolveTierReason } from "../judge/tier-reason-strings.js";
import { toLiveTier } from "../judge/tiers.js";
import { isInternalSender } from "../mail/company-domains.js";
import { hasAnyMailSource } from "../mail/mail-source.js";
import { labelableDomain, senderLabelEntriesFor } from "../mail/sender-labels.js";
import { senderEmail } from "../notify/notification-format.js";
import { LANG_QUERY_PROPERTY, readerLanguageFor } from "../notify/request-language.js";
import { captureError } from "../sentry.js";
import { darkRouteGate } from "./dark-route-gate.js";

const laneCountsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    inbox: { type: "string", maxLength: 500 },
  },
} as const;

// Read on every view change and after every action; well above a busy session,
// well below a scripted loop. Same shape as the sibling email routes.
const LANE_COUNTS_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

// Read once per opened mail; holding J in the reader walks a lane quickly.
const READER_CONTEXT_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

const readerContextQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    // Validated in the handler (parseLaneFilter / isLanePageFilter), like the list.
    tier: { type: "string", maxLength: 500 },
    inbox: { type: "string", maxLength: 500 },
    filter: { type: "string", maxLength: 500 },
    search: { type: "string", maxLength: 500 },
    // The client's UI language for the reason (request-language.ts).
    lang: LANG_QUERY_PROPERTY,
  },
} as const;

interface DemoLaneRow {
  id: string;
  tier: LiveTier;
  isRead: boolean;
}

/**
 * A demo mail's context: its hand-assigned lane and its neighbours in the demo
 * list. Only the lane narrows the neighbours — `inbox`, `filter` and `search`
 * are not applied to demo rows (there is one demo account and a dozen rows), so
 * previous / next there walk the whole demo lane.
 */
function demoReaderContext(
  rows: readonly DemoLaneRow[],
  id: string,
  lane: LaneFilter,
): EmailReaderContextResponse | null {
  const current = rows.find((row) => row.id === id);
  if (!current) return null;
  const view = rows.filter((row) => row.id === id || lane === "ALL" || row.tier === lane);
  const at = view.findIndex((row) => row.id === id);
  return {
    tier: current.tier,
    tierReason: null,
    linkedInboxAccountId: null,
    firstContact: false,
    repliedCount: null,
    senderLabel: null,
    newerId: view[at - 1]?.id ?? null,
    olderId: view[at + 1]?.id ?? null,
  };
}

interface SenderFacts {
  firstContact: boolean;
  repliedCount: number | null;
  senderLabel: ReaderSenderLabel | null;
}

/**
 * The relationship facts the reader header states. Recorded facts only, and
 * fail-open like the row chips (firewall.ts): a failed lookup claims nothing —
 * a wrong "first contact" on a ten-year colleague is worse than no label.
 * The sender label's targets (address, domain) need no lookup, so a failed
 * lookup still lets the user correct the label; it only claims no current one.
 */
async function senderFactsFor(
  userId: string,
  email: { from: string; category: string | null; labels: string[] },
): Promise<SenderFacts> {
  const address = senderEmail(email.from).toLowerCase();
  if (!address) {
    return { firstContact: false, repliedCount: null, senderLabel: null };
  }
  const target = { address, domain: labelableDomain(address) };
  try {
    const [engagement, owner, labels] = await Promise.all([
      prisma.contactEngagementScore.findFirst({
        where: { userId, contactEmail: address },
        select: { outboundCount: true },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { companyDomains: true } }),
      senderLabelEntriesFor(userId, [address]),
    ]);
    const repliedCount = engagement?.outboundCount ?? 0;
    const userLabel = labels.get(address) ?? null;
    const signal = rowSignalFor({
      userLabel: userLabel?.category ?? null,
      internal: isInternalSender(email.from, owner?.companyDomains ?? []),
      judgeCategory: email.category,
      category: gmailCategoryOf(email.labels),
      repliedCount,
    });
    return {
      firstContact: signal?.kind === "first",
      repliedCount,
      senderLabel: {
        ...target,
        current: signal?.kind === "category" ? signal.category : null,
        correction: userLabel?.scope ?? null,
      },
    };
  } catch (err) {
    captureError(err, { tags: { scope: "email.readerContext.senderFacts" }, extra: { userId } });
    return {
      firstContact: false,
      repliedCount: null,
      senderLabel: { ...target, current: null, correction: null },
    };
  }
}

export function registerEmailLaneRoutes(
  app: FastifyInstance,
  options: { demoRows: () => readonly DemoLaneRow[] },
) {
  // GET /api/email/lane-counts?inbox= — mail per lane (total + unread) for the
  // lane control: one grouped query, not one count per lane.
  app.get(
    "/lane-counts",
    {
      onRequest: darkRouteGate(laneReadsEnabled),
      schema: { querystring: laneCountsQuerySchema },
      config: { rateLimit: LANE_COUNTS_RATE_LIMIT },
    },
    async (request): Promise<EmailLaneCountsResponse> => {
      const uid = getUserId(request);
      const { inbox } = request.query as { inbox?: string };
      // Same source rule as the list (hasAnyMailSource), so the control and the
      // rows agree: no source → every lane zero, flagged; never demo counts.
      if (!(await hasAnyMailSource(uid))) {
        return { counts: foldLaneCounts([]), source: "demo", needsConnection: true };
      }
      // A linked id is checked against its owner; one that is not the caller's
      // counts nothing.
      const scope = await resolveInboxScope(uid, inbox);
      return { counts: await countEmailsByLane(uid, scope), source: "gmail" };
    },
  );

  // GET /api/email/:id/reader-context?tier=&inbox=&filter=&search= — the Mail
  // v2 reader header: the lane and why, the account, the sender facts that left
  // the list row, and the previous / next mail in the view it was opened from.
  app.get(
    "/:id/reader-context",
    {
      onRequest: darkRouteGate(mailV2Enabled),
      schema: { querystring: readerContextQuerySchema },
      config: { rateLimit: READER_CONTEXT_RATE_LIMIT },
    },
    async (request, reply): Promise<EmailReaderContextResponse> => {
      const uid = getUserId(request);
      const { id } = request.params as { id: string };
      const { tier, inbox, filter, search } = request.query as {
        tier?: string;
        inbox?: string;
        filter?: string;
        search?: string;
      };
      const lane = tier === undefined ? "ALL" : parseLaneFilter(tier);
      if (lane === null) {
        return reply
          .code(400)
          .send({ error: `tier must be one of ${LANE_FILTERS.join(", ")}.` } as never);
      }
      if (!isLanePageFilter(filter)) {
        return reply
          .code(400)
          .send({ error: `filter=${filter} cannot narrow a reader context.` } as never);
      }

      if (id.startsWith("demo-")) {
        const demo = demoReaderContext(options.demoRows(), id, lane);
        if (!demo) return reply.code(404).send({ error: "Email not found" } as never);
        return demo;
      }

      // The owner is part of the lookup: another user's mail is a 404, and
      // nothing below runs for it.
      const email = await prisma.emailMessage.findFirst({
        where: { userId: uid, OR: [{ id }, { gmailId: id }] },
        select: { id: true, from: true, category: true, labels: true, linkedInboxAccountId: true },
      });
      if (!email) return reply.code(404).send({ error: "Email not found" } as never);

      const [item, language, facts, scope] = await Promise.all([
        prisma.attentionItem.findFirst({
          where: { userId: uid, source: "EMAIL", sourceId: email.id },
          select: { tier: true, tierReason: true },
        }),
        readerLanguageFor(request, reply, uid),
        senderFactsFor(uid, email),
        // A linked id is checked against its owner; one that is not the
        // caller's has no neighbours.
        resolveInboxScope(uid, inbox),
      ]);
      const neighbours = await neighbourEmailIdsInLane({
        userId: uid,
        lane,
        scope,
        filter,
        search: search?.trim() || undefined,
        emailId: email.id,
      });
      return {
        // No AttentionItem yet: the mail is shown, but no lane is claimed.
        tier: item ? toLiveTier(item.tier) : null,
        tierReason: item ? resolveTierReason(item.tierReason, language) : null,
        linkedInboxAccountId: email.linkedInboxAccountId,
        ...facts,
        ...neighbours,
      };
    },
  );
}
