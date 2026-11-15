import { UsageError } from "../errors.js";

/**
 * Which database a command operates on, from the `--db` / `--target` spec.
 *
 *   compose              the Postgres service of docker-compose.selfhost.yml;
 *                        tools run inside that container over its local socket,
 *                        so no credential ever passes through this CLI
 *   env:VAR              a postgres URL read from environment variable VAR
 *                        (the shell first, then the env file)
 *   postgresql://u@h/db  a URL with NO password; libpq finds it in PGPASSWORD
 *                        or ~/.pgpass
 *
 * A literal URL with a password is refused: argv is world-readable through
 * `ps`, so a password typed there is already leaked by the time we see it.
 */

/** Klorn's hosted production Supabase project. Restoring over it needs --i-know. */
export const HOSTED_PROD_REF = "wqqjldncizvmandepobc";

/** Fixed by docker-compose.selfhost.yml (POSTGRES_USER / POSTGRES_DB). */
export const COMPOSE_PG_USER = "klorn";
export const COMPOSE_PG_DATABASE = "klorn";

export interface PgConn {
  host: string;
  port: string;
  user: string;
  database: string;
  password: string | null;
  sslmode: string | null;
  sslrootcert: string | null;
  connectTimeout: string | null;
}

export interface ComposeTarget {
  kind: "compose";
  user: string;
  database: string;
  label: string;
}

export interface UrlTarget {
  kind: "url";
  conn: PgConn;
  /** host:port/database — never the user or password. Safe to print. */
  label: string;
  database: string;
  /** The parsed URL, password included. Never print it. */
  url: URL;
}

export type DbTarget = ComposeTarget | UrlTarget;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// libpq reads a dbname containing "=" (or a URI prefix) as a whole connection
// string, so the name passed in argv is held to a plain identifier.
const DATABASE_NAME = /^[A-Za-z0-9_$.-]{1,63}$/;

export function parseDbSpec(spec: string, lookup: (name: string) => string | undefined): DbTarget {
  if (spec === "compose") {
    return {
      kind: "compose",
      user: COMPOSE_PG_USER,
      database: COMPOSE_PG_DATABASE,
      label: `compose postgres (${COMPOSE_PG_DATABASE})`,
    };
  }
  if (spec.startsWith("env:")) {
    const name = spec.slice("env:".length);
    if (!ENV_NAME.test(name)) {
      throw new UsageError(`"${spec}" is not a valid env:VAR reference`);
    }
    const value = lookup(name);
    if (!value) throw new UsageError(`${name} is not set (needed by --db/--target env:${name})`);
    return parseUrlTarget(value, `the URL in ${name}`, true);
  }
  if (/^postgres(ql)?:\/\//.test(spec)) {
    return parseUrlTarget(spec, "the URL", false);
  }
  throw new UsageError(
    "a database must be `compose`, `env:VAR` or a postgres URL without a password",
  );
}

function parseUrlTarget(raw: string, what: string, passwordAllowed: boolean): UrlTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo `raw`: it may carry a password.
    throw new UsageError(`${what} is not a valid URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UsageError(`${what} must start with postgres:// or postgresql://`);
  }
  if ((url.password || url.searchParams.has("password")) && !passwordAllowed) {
    throw new UsageError(
      "a password on the command line is visible to every user through `ps`; " +
        "put it in PGPASSWORD or ~/.pgpass, or pass the whole URL as env:VAR",
    );
  }
  const database = decodePart(url.pathname.replace(/^\//, ""), what);
  if (!database) throw new UsageError(`${what} has no database name`);
  if (!DATABASE_NAME.test(database)) {
    throw new UsageError(
      `${what} has a database name this CLI does not accept (A-Z a-z 0-9 _ $ . -)`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UsageError(`${what} has no host`);
  const port = url.port || "5432";
  const conn: PgConn = {
    host,
    port,
    user: decodePart(url.username, what),
    database,
    password: url.password ? decodePart(url.password, what) : null,
    sslmode: url.searchParams.get("sslmode"),
    sslrootcert: url.searchParams.get("sslrootcert"),
    connectTimeout: url.searchParams.get("connect_timeout"),
  };
  return { kind: "url", conn, label: `${host}:${port}/${database}`, database, url };
}

/** decodeURIComponent that reports a malformed escape as a usage error, never echoing the value. */
function decodePart(value: string, what: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UsageError(`${what} has a malformed %-escape (encode a literal % as %25)`);
  }
}

/**
 * True when the target is (or routes to) Klorn's hosted production project.
 * Checks the decoded user and host as well as the raw URL, so a %-escaped
 * project ref (postgres.wqqjldncizvm%61ndepobc) cannot slip past.
 */
export function looksLikeHostedProd(target: DbTarget): boolean {
  if (target.kind === "compose") return false;
  const haystack = [target.url.href, target.conn.user, target.conn.host, target.conn.database];
  return haystack.some((part) => part.toLowerCase().includes(HOSTED_PROD_REF));
}

/**
 * The URL prisma needs (it reads DATABASE_URL only, never PGPASSWORD or
 * ~/.pgpass). A password-less URL is filled from PGPASSWORD when set.
 * Goes into a child's environment, never into argv or output.
 */
export function databaseUrlFor(
  target: UrlTarget,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(target.url.href);
  if (!url.password && env.PGPASSWORD) {
    url.password = encodeURIComponent(env.PGPASSWORD);
  }
  return url.href;
}
