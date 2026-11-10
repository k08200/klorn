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
 * Hidden in the native shell: Apple and Naver block WebView OAuth the way
 * Google does, and the external-browser relay speaks Google only.
 */
export function providerLane(
  nativeShell: boolean | null,
  data: AuthProvidersResponse | undefined,
): ProviderLane {
  if (nativeShell !== false) return { extras: [], resolved: false };
  const extras = (data?.providers ?? [])
    .map((provider) => provider.id)
    .filter((id): id is AuthProviderId => id === "apple" || id === "naver");
  return { extras, resolved: data !== undefined };
}
