"use client";

/**
 * Today — "Recent files" (productization plan §1, P12): the newest few files
 * of every drive source that is on. Rendered only while the server reports a
 * drive source (`user.files`); with it off nothing is asked for.
 */

import { FILES_HOME } from "../../lib/home";
import { useT } from "../../lib/i18n";
import { FileRow } from "../files/file-row";
import { useRecentFiles } from "../files/use-files";
import { BlockError, BlockNote, LinesSkeleton, RailOpenLink, TodayBlock } from "./block";

export function RecentFilesBlock({
  timeZone,
  className = "",
}: {
  timeZone: string;
  className?: string;
}) {
  const { t } = useT();
  const recent = useRecentFiles(true);
  return (
    <TodayBlock
      headingId="today-files"
      title={t("today.files.title")}
      layout="card"
      action={<RailOpenLink href={FILES_HOME} />}
      className={className}
    >
      {recent.loading && <LinesSkeleton lines={3} label={t("files.loading")} />}
      {recent.failed && <BlockError message={t("files.error")} onRetry={recent.retry} />}
      {!recent.loading && !recent.failed && recent.files.length === 0 && (
        <BlockNote>{t("today.files.none")}</BlockNote>
      )}
      {recent.files.length > 0 && (
        <ul className="-mx-[18px] flex flex-col px-[6px]">
          {recent.files.map((file) => (
            <li key={file.id}>
              <FileRow file={file} timeZone={timeZone} />
            </li>
          ))}
        </ul>
      )}
    </TodayBlock>
  );
}
