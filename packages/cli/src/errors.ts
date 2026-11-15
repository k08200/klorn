/** Bad invocation: unknown flag, missing argument, malformed value. Exit 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The command ran and something it depends on failed or refused. Exit 1. */
export class CliError extends Error {
  override readonly name = "CliError";
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
