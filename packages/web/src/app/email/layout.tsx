"use client";

/**
 * Mail split view (design detail pass X3, Reader.dc; MAIL_V2 only): from
 * 1280px the list stays on the left (440px) and the reader opens beside it.
 * A layout, so the list — its scroll, view and selection — survives moving
 * between mails. Below 1280px, without MAIL_V2, and on /email/candidates this
 * renders the route alone: the list → page flow is unchanged.
 *
 * In the split the list's own hotkeys stand down while a mail is open, so the
 * reader's J / K / E are the only ones listening.
 */

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import EmptyState from "../../components/ui/empty-state";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { useMediaQuery } from "../../lib/use-media-query";
import { MailV2 } from "./_v2/mail-v2";

const SPLIT_QUERY = "(min-width: 1280px)";
const READER_PATH = /^\/email\/([^/]+)$/;

function openEmailId(pathname: string): string | null {
  const match = READER_PATH.exec(pathname);
  return match && match[1] !== "candidates" ? decodeURIComponent(match[1]) : null;
}

export default function EmailLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const { user } = useAuth();
  const wide = useMediaQuery(SPLIT_QUERY);
  const selectedId = openEmailId(pathname);
  const splitRoute = pathname === "/email" || selectedId !== null;
  if (!wide || user?.mailV2 !== true || !splitRoute) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0">
      <section
        data-mail-scroll
        className="h-full w-[440px] shrink-0 overflow-y-auto border-r border-line bg-surface-panel"
      >
        <MailV2 pane={{ selectedId }} />
      </section>
      <div data-reader-scroll className="h-full min-w-0 flex-1 overflow-y-auto bg-surface-app">
        {selectedId ? children : <SplitEmpty />}
      </div>
    </div>
  );
}

function SplitEmpty() {
  const { t } = useT();
  return (
    <EmptyState
      headingLevel="h2"
      title={t("mailV2.split.empty.title")}
      description={t("mailV2.split.empty.body")}
    />
  );
}
