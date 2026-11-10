import { redirect } from "next/navigation";
import { DEFAULT_SETTINGS_SECTION, settingsSectionHref } from "../sections";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/settings` has no content of its own: it forwards to the first section and
 * carries the query string along, so OAuth callbacks (`?google=…`, `?inbox=…`)
 * and stored notification links keep working. A `#fragment` survives the
 * redirect in the browser and is mapped to its section by the shell.
 */
export default async function SettingsIndexPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) query.append(key, item);
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  redirect(`${settingsSectionHref(DEFAULT_SETTINGS_SECTION)}${suffix}`);
}
