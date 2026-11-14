/**
 * Connect routes of the fixed-host app-password presets (provider phase 2): one
 * `imapConnectRoutes` plugin per preset at `/api/<slug>-imap`, the same factory
 * Naver and iCloud use, so each preset's host is the registry constant and nothing
 * a request sends can change it.
 *
 * All of them are behind IMAP_PRESETS_ENABLED: while it is off, every route answers
 * the cloaked 404 before authentication (darkRouteGate); in `cohort` mode the routes
 * exist and let in only ROLLOUT_COHORT_USER_IDS (cohortGate, after authentication).
 */

import type { FastifyInstance } from "fastify";
import { IMAP_PRESETS_FLAGS, imapPresetsLive } from "../config.js";
import { IMAP_PRESET_KEYS, imapPresetRouteSlug } from "../mail/imap-preset-keys.js";
import { IMAP_PROVIDERS } from "../mail/imap-providers.js";
import { imapConnectRoutes } from "./imap-connect.js";

export async function registerImapPresetRoutes(app: FastifyInstance): Promise<void> {
  for (const key of IMAP_PRESET_KEYS) {
    await app.register(
      imapConnectRoutes(IMAP_PROVIDERS[key], {
        gate: imapPresetsLive,
        cohortFlags: IMAP_PRESETS_FLAGS,
      }),
      { prefix: `/api/${imapPresetRouteSlug(key)}-imap` },
    );
  }
}
