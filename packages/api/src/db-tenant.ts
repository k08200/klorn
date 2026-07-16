import type { PrismaClient } from "@prisma/client";
import { INTERACTIVE_TX_OPTIONS, prisma } from "./db.js";

/**
 * Tenant-scoped and system-scoped query execution for Postgres Row-Level
 * Security.
 *
 * RLS is enabled (not yet FORCEd) on every per-user table. Because the app
 * connects as the table owner, an un-FORCEd policy is inert today — these
 * helpers set the request's tenant context now so that flipping FORCE later
 * (per table, after a backup/restore rehearsal) activates isolation without a
 * second code change.
 *
 * Mechanism: an interactive transaction with `set_config(name, value, true)`.
 * The `is_local = true` third arg scopes the GUC to the transaction, so it can
 * never leak across a pooled (PgBouncer transaction-mode) connection — the one
 * pattern that is pooler-safe. Every query inside must use the passed `tx`
 * handle; a query issued on the global `prisma` client runs in its own
 * connection without the GUC and (once FORCEd) sees zero rows.
 *
 * Policies OR two permissive rules: `"userId" = app.current_user_id` (tenant)
 * and `app.bypass_rls = 'on'` (system). withSystem is for the paths that have
 * no single tenant — schedulers, webhook ingest, admin fleet queries.
 */

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

async function setLocalConfig(tx: TxClient, name: string, value: string): Promise<void> {
  // Both args are bound params (set_config takes them as function arguments),
  // so a hostile userId can never be spliced into SQL text.
  await tx.$executeRaw`SELECT set_config(${name}, ${value}, true)`;
}

/**
 * Run `fn` in a transaction bound to one user's RLS context. Every query in
 * `fn` MUST use the provided `tx` client, not the global `prisma`.
 */
export function withTenant<T>(userId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setLocalConfig(tx as TxClient, "app.current_user_id", userId);
    return fn(tx as TxClient);
  }, INTERACTIVE_TX_OPTIONS); // SET LOCAL requires the interactive form; pool-sized options per #845
}

/**
 * Run `fn` in a transaction that bypasses tenant isolation — for system paths
 * with no single owning user (schedulers, webhook ingest, admin aggregates).
 * Kept explicit so a bypass is always a deliberate, greppable choice.
 */
export function withSystem<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setLocalConfig(tx as TxClient, "app.bypass_rls", "on");
    return fn(tx as TxClient);
  }, INTERACTIVE_TX_OPTIONS); // SET LOCAL requires the interactive form; pool-sized options per #845
}
