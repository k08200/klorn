import { useParams, usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { resolveRouteParam } from "./route-param";

const subscribeNever = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * A dynamic route's id (`name` in `/email/[name]`, the segment after `prefix`)
 * on both builds: the router's param on the Next server, the URL's segment on
 * the static export's shared shell (see route-param.ts).
 */
export function useRouteParam(name: string, prefix: string): string | undefined {
  const params = useParams<Record<string, string | string[]>>();
  const pathname = usePathname();
  // false while hydrating the prerendered HTML, true on every render after.
  const hydrated = useSyncExternalStore(subscribeNever, onClient, onServer);
  return resolveRouteParam(params?.[name], pathname, prefix, hydrated);
}
