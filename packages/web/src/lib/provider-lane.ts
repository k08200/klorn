import type { AuthProviderId, AuthProvidersResponse } from "@klorn/contract";

export interface ProviderLane {
  /** Providers to show under Google, in server order (Google is implicit). */
  extras: AuthProviderId[];
  /** True once there is an answer to show — drives the reveal. */
  resolved: boolean;
}

/**
 * What the sign-in page's provider lane shows.
 *
 * `nativeShell` is null until the page has mounted. The server cannot know it,
 * and it cannot read the localStorage seed either, so until mount the lane
 * must render exactly what the server rendered — empty and closed — or React
 * hits a hydration mismatch whenever a cached provider list exists (#1407
 * follow-up). After mount the cached seed counts as an answer.
 *
 * In a native shell Apple and Naver block WebView OAuth the way Google does,
 * so only `nativeProviders` — the ones the shell's system-browser relay can
 * run (Apple in the Capacitor shell, native-auth.ts) — are shown there.
 * App Store guideline 4.8: an app offering Google sign-in offers Apple too.
 */
export function providerLane(
  nativeShell: boolean | null,
  data: AuthProvidersResponse | undefined,
  nativeProviders: readonly AuthProviderId[] = [],
): ProviderLane {
  if (nativeShell === null) return { extras: [], resolved: false };
  const offered = (data?.providers ?? [])
    .map((provider) => provider.id)
    .filter((id): id is AuthProviderId => id === "apple" || id === "naver");
  if (!nativeShell) return { extras: offered, resolved: data !== undefined };
  const extras = offered.filter((id) => nativeProviders.includes(id));
  return { extras, resolved: data !== undefined && extras.length > 0 };
}
