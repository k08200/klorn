import type { CommandSpec } from "./exec.js";

/** The self-host stack: docker-compose.selfhost.yml plus its env file. */
export interface ComposeRef {
  composeFile: string;
  envFile: string;
}

/**
 * `docker compose --env-file <env> -f <file> <args...>`. Compose reads the
 * secrets from the env file itself; only the file's PATH is in argv.
 */
export function composeSpec(
  ref: ComposeRef,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): CommandSpec {
  return {
    cmd: "docker",
    args: ["compose", "--env-file", ref.envFile, "-f", ref.composeFile, ...args],
    ...(env ? { env } : {}),
  };
}
