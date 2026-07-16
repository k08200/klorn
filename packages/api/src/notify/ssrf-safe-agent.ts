import dns from "node:dns";
import { Agent } from "node:https";
import type { LookupFunction } from "node:net";
import { isPrivateIp } from "./is-safe-push-endpoint.js";

/**
 * A DNS lookup that refuses to connect to any hostname resolving to a
 * private/internal address. Wired into the web-push HTTPS agent so the SSRF
 * decision is made at CONNECT time on the actually-resolved IP.
 *
 * isSafePushEndpoint() validates the endpoint's hostname *string* at
 * subscribe/delivery time, but a public-looking name whose A/AAAA record points
 * at 10.x / 169.254.169.254 / ::1 (rebindable per query) sails through that. By
 * re-checking every resolved address here — right before the socket connects,
 * with no gap in which DNS can flip — the rebinding vector is closed. If ANY
 * resolved address is private we abort rather than pick a "safe" one, so a
 * multi-record response can't smuggle an internal target.
 */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void;
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      cb(err, "", 0);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad) {
      cb(
        Object.assign(new Error(`SSRF blocked: ${hostname} resolves to private ${bad.address}`), {
          code: "ESSRFBLOCKED",
        }),
        "",
        0,
      );
      return;
    }
    if (options.all) {
      cb(null, list);
      return;
    }
    const first = list[0];
    cb(null, first.address, first.family);
  });
};

/** Shared HTTPS agent that blocks SSRF to private addresses at connect time. */
export const ssrfSafeHttpsAgent = new Agent({ lookup: ssrfSafeLookup });
