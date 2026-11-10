import {
  type ClientAddressRequest,
  clientAddress,
  deriveClientAddress,
  looksProxiedWithoutSource,
  resolveClientAddressConfig,
} from "./client-address.js";
import { type CidrRule, isRateLimitAllowedIp } from "./scanner-allowlist.js";

/**
 * The global @fastify/rate-limit registration (index.ts). The key and the scan
 * exemption read the same address, from security/client-address.ts, so a
 * client can neither pick its bucket nor claim an exempt address by sending a
 * header the deployment does not trust. Never the plugin's default key, which
 * is request.ip: under trustProxy, the leftmost X-Forwarded-For entry.
 */

const GLOBAL_MAX_PER_WINDOW = 100;
const GLOBAL_WINDOW = "1 minute";

interface AllowListRequest extends ClientAddressRequest {
  readonly url?: string;
}

/** Route prefixes exempt from the global per-address limit. */
const EXEMPT_ROUTE_PREFIXES: readonly string[] = [
  // OAuth callback: Google redirects here after consent; rate-limiting it
  // would break the login flow for users on slow networks or retry loops.
  "/api/auth/google/callback",
  // Gmail Pub/Sub push traffic comes from Google's shared infra; under heavy
  // mail load it would otherwise trip the per-IP limit and back up delivery.
  "/api/gmail/push",
];

const PROXIED_WITHOUT_SOURCE_WARNING =
  "[security] requests carry X-Forwarded-For or CF-Connecting-IP but CLIENT_IP_SOURCE is socket: behind a proxy every client shares one rate-limit bucket. See docs/self-hosting.md (Client address).";

export function makeRateLimitAllowList(scannerAllowRules: readonly CidrRule[]) {
  return (request: AllowListRequest): boolean => {
    // Authorized security scan: a CASA DAST fires thousands of requests from a
    // few source ranges and would otherwise be throttled into an incomplete
    // report. Empty unless RATE_LIMIT_ALLOW_IPS names the assessor's ranges.
    if (
      scannerAllowRules.length > 0 &&
      isRateLimitAllowedIp(clientAddress(request), scannerAllowRules)
    ) {
      return true;
    }
    const url = request.url ?? "";
    return EXEMPT_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix));
  };
}

/**
 * The options index.ts registers. The key generator also warns once when the
 * deployment looks proxied but still keys on the TCP peer (an upgrade from a
 * setup whose proxy wrote CF-Connecting-IP): safe, but every client then
 * shares the proxy's bucket.
 */
export function rateLimitOptions(
  scannerAllowRules: readonly CidrRule[],
  warn: (message: string) => void = console.warn,
) {
  let proxiedWarningLogged = false;
  return {
    max: GLOBAL_MAX_PER_WINDOW,
    timeWindow: GLOBAL_WINDOW,
    keyGenerator: (request: ClientAddressRequest): string => {
      const config = resolveClientAddressConfig(process.env);
      if (!proxiedWarningLogged && looksProxiedWithoutSource(request, config)) {
        proxiedWarningLogged = true;
        warn(PROXIED_WITHOUT_SOURCE_WARNING);
      }
      return deriveClientAddress(request, config);
    },
    allowList: makeRateLimitAllowList(scannerAllowRules),
  };
}
