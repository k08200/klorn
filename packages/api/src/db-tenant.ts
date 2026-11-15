import type { PrismaClient } from "@prisma/client";
import { INTERACTIVE_TX_OPTIONS, prisma } from "./db.js";
import { logDbFailure } from "./report-db-failure.js";

/**
 * Tenant-scoped and system-scoped query execution for Postgres Row-Level
 * Security.
 *
 * RLS is enabled (not FORCEd) on every per-user table, and is inert today: the
 * app connects as `postgres`, which both owns the tables and carries the
 * BYPASSRLS attribute (measured 2026-08-04). Ownership alone would be fixable
 * with FORCE; BYPASSRLS is not — it outranks FORCE, so no amount of forcing
 * makes these policies evaluate while the app connects as that role.
 *
 * What activates them is connecting as a dedicated least-privilege role that
 * owns nothing and has no BYPASSRLS. Plain ENABLE constrains a non-owner role,
 * so at that point the existing migration is already sufficient. These helpers
 * bind the request's tenant context now so that switch needs no second code
 * change. See docs/rls-rollout.md for the staged plan and its ordering hazard
 * (the switch arms every table at once; unrouted queries return zero rows
 * rather than erroring).
 *
 * Mechanism: an interactive transaction with `set_config(name, value, true)`.
 * The `is_local = true` third arg scopes the GUC to the transaction, so it can
 * never leak across a pooled (PgBouncer transaction-mode) connection — the one
 * pattern that is pooler-safe. Every query inside must use the passed `tx`
 * handle; a query issued on the global `prisma` client runs in its own
 * connection without the GUC and (once RLS binds) sees zero rows.
 *
 * Policies OR two permissive rules: `"userId" = app.current_user_id` (tenant)
 * and `app.bypass_rls = 'on'` (system). withSystem is for the paths that have
 * no single tenant — schedulers, webhook ingest, admin fleet queries.
 *
 * ## Why the transaction is skipped while RLS is inert
 *
 * That transaction exists only to carry a GUC. While the connected role
 * bypasses RLS no policy ever reads that GUC, so the wrapper buys nothing and
 * costs `BEGIN` + `set_config` + `COMMIT` — three extra round trips, measured
 * at 3.7x a bare query (11.5 ms → 42.1 ms) and ~+190 ms from the API's region,
 * which is ~4,700 km from the database. Paying that for a no-op is what made
 * routing the remaining call sites look unaffordable; it is not the routing
 * that is expensive, it is wrapping ahead of the switch. So these helpers
 * detect whether RLS can actually constrain the connected role and skip the
 * transaction when it cannot. Routing a call site is then free until the role
 * switches, and the cost arrives together with the isolation it buys.
 *
 * The tradeoff is worth stating plainly: while inert the callback receives the
 * global client, so a query that wrongly uses `prisma` instead of the passed
 * handle behaves identically and stays invisible until the switch. Tests run
 * with the wrapper forced on (`RLS_ENFORCEMENT=on`, vitest.config.ts) so that
 * discipline is still enforced where it can be observed.
 */

type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

/**
 * `enforced` — RLS can constrain this connection, so the context must be bound.
 * `inert` — the role bypasses RLS, so binding it changes nothing.
 */
type RlsMode = "enforced" | "inert";

interface ScopeOptions {
  /**
   * Open a transaction even when RLS is inert — for callers that need the block
   * to be atomic for their own reasons (a read-then-write guard, say). That
   * requirement does not disappear along with the GUC.
   */
  atomic?: boolean;
}

/** Detection result. Only successful probes are cached. */
let detectedMode: Promise<RlsMode> | null = null;

/**
 * Ask the database, rather than trust a flag, whether RLS applies here.
 *
 * A flag would have to be flipped in the same change that repoints
 * `DATABASE_URL`, and the cost of forgetting is total: RLS armed with no GUC
 * bound returns zero rows on every table at once. Deriving the answer from the
 * connection itself cannot drift from it.
 *
 * Superusers and BYPASSRLS roles are unconstrained. A table owner is too under
 * plain ENABLE — deliberately not probed, because the role this rollout
 * switches to owns nothing; were a future role to own tables this reports
 * `enforced` and costs round trips it did not need, which is the harmless
 * direction to be wrong in.
 */
async function probeRlsMode(): Promise<RlsMode> {
  const rows = await prisma.$queryRaw<{ bypasses: boolean }[]>`
    SELECT (rolsuper OR rolbypassrls) AS bypasses
    FROM pg_roles
    WHERE rolname = current_user
  `;
  const bypasses = rows[0]?.bypasses;
  if (bypasses === undefined) throw new Error("pg_roles has no row for current_user");
  return bypasses ? "inert" : "enforced";
}

/** Last override announced, so the notice is logged on change, not per query. */
let announcedOverride: string | null = null;

/**
 * Say out loud that the probe was overridden. An override left set across the
 * role switch is the one way this mechanism fails loudly-but-late: `off` after
 * the switch binds no context, and the policies then deny every row on every
 * table at once. The probed path announces its conclusion, so this path must
 * too, or the deploy that matters is the one with nothing in its log.
 */
function announceOverride(value: "on" | "off"): void {
  if (announcedOverride === value) return;
  announcedOverride = value;
  console.warn(
    value === "off"
      ? "[rls] RLS_ENFORCEMENT=off — role probe skipped, tenant context NOT bound; unset this before switching the database role"
      : "[rls] RLS_ENFORCEMENT=on — role probe skipped, tenant context bound per call",
  );
}

function resolveRlsMode(): Promise<RlsMode> {
  // Operator override for the two things the probe cannot settle: forcing the
  // wrapper on ahead of a role switch, and forcing it off if the probe is ever
  // wrong in the slow direction. Anything else (including unset) asks the
  // database — an unrecognised value must not silently mean "off".
  const override = process.env.RLS_ENFORCEMENT;
  if (override === "on" || override === "off") {
    announceOverride(override);
    return Promise.resolve(override === "on" ? "enforced" : "inert");
  }

  if (!detectedMode) {
    detectedMode = probeRlsMode()
      .then((mode) => {
        console.info(
          mode === "inert"
            ? "[rls] connected role bypasses RLS — tenant context not bound (wrapper inert)"
            : "[rls] connected role is constrained by RLS — tenant context bound per call",
        );
        return mode;
      })
      .catch((error) => {
        // Assume enforcement: that costs round trips, whereas the other guess
        // runs routed call sites with no context bound. Not cached, so one
        // transient failure cannot pin the process to the slow path.
        detectedMode = null;
        logDbFailure("[rls] role probe failed, assuming RLS is enforced", error);
        return "enforced" as const;
      });
  }
  return detectedMode;
}

async function setLocalConfig(tx: TxClient, name: string, value: string): Promise<void> {
  // Both args are bound params (set_config takes them as function arguments),
  // so a hostile userId can never be spliced into SQL text.
  await tx.$executeRaw`SELECT set_config(${name}, ${value}, true)`;
}

async function runScoped<T>(
  bind: (tx: TxClient) => Promise<void>,
  fn: (tx: TxClient) => Promise<T>,
  options: ScopeOptions | undefined,
): Promise<T> {
  const mode = await resolveRlsMode();
  if (mode === "inert" && !options?.atomic) return fn(prisma);
  return prisma.$transaction(async (tx) => {
    await bind(tx as TxClient);
    return fn(tx as TxClient);
  }, INTERACTIVE_TX_OPTIONS); // SET LOCAL requires the interactive form; pool-sized options per #845
}

/**
 * Run `fn` in one user's RLS context. Every query in `fn` MUST use the client
 * it is passed, not the global `prisma` — that is what keeps the call site
 * correct on the day RLS starts binding.
 */
export function withTenant<T>(
  userId: string,
  fn: (tx: TxClient) => Promise<T>,
  options?: ScopeOptions,
): Promise<T> {
  return runScoped((tx) => setLocalConfig(tx, "app.current_user_id", userId), fn, options);
}

/**
 * Run `fn` with tenant isolation bypassed — for system paths with no single
 * owning user (schedulers, webhook ingest, admin aggregates). Kept explicit so
 * a bypass is always a deliberate, greppable choice.
 */
export function withSystem<T>(
  fn: (tx: TxClient) => Promise<T>,
  options?: ScopeOptions,
): Promise<T> {
  return runScoped((tx) => setLocalConfig(tx, "app.bypass_rls", "on"), fn, options);
}
