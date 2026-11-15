import type { Io } from "../context.js";
import { CliError } from "../errors.js";

/**
 * Destructive or disruptive steps ask first. `--yes` skips the question; with
 * no TTY and no `--yes` the command refuses instead of hanging or guessing.
 */

function requireInteractive(io: Io): void {
  if (!io.interactive) {
    throw new CliError("refusing without confirmation in a non-interactive shell — pass --yes");
  }
}

export async function confirmYesNo(io: Io, question: string, yes: boolean): Promise<void> {
  if (yes) return;
  requireInteractive(io);
  const answer = (await io.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new CliError("aborted");
}

export async function confirmTyped(
  io: Io,
  prompt: string,
  expected: string,
  yes: boolean,
): Promise<void> {
  if (yes) return;
  requireInteractive(io);
  const answer = (await io.ask(prompt)).trim();
  if (answer !== expected) throw new CliError(`"${answer}" did not match "${expected}" — aborted`);
}
