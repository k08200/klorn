"use client";

/**
 * Mail split view (design detail pass X3, Reader.dc; MAIL_V2 only): from
 * 700px — a Fold opened, an iPad in portrait, anything wider — the list
 * stays on the left and the reader opens beside it. The list takes 45% of
 * the space beside the shell's navigation, 280–440px (globals.css,
 * .mail-split-list); on a two-segment screen (a book-style foldable or a
 * dual-screen phone) the seam sits on the hinge instead, and the split is on
 * whatever the width. A layout, so the list — its scroll, view and
 * selection — survives moving between mails. Below 700px, without MAIL_V2,
 * and on /email/candidates this renders the route alone: the list → page
 * flow is unchanged.
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

const SPLIT_QUERY = "(min-width: 700px), (horizontal-viewport-segments: 2)";
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
  const split = wide && user?.mailV2 === true && splitRoute;
  // `children` keeps the same place in the tree whether or not the split is
  // on (the wrappers turn into display: contents), so the media query
  // resolving after the first paint does not remount the reader.
  return (
    <div className={split ? "flex h-full min-h-0" : "contents"}>
      {split && (
        <section
          data-mail-scroll
          className="mail-split-list h-full shrink-0 overflow-y-auto border-r border-line bg-surface-panel"
        >
          <MailV2 pane={{ selectedId }} />
        </section>
      )}
      <div
        data-reader-scroll={split || undefined}
        className={
          split
            ? "mail-split-reader h-full min-w-0 flex-1 overflow-y-auto bg-surface-app"
            : "contents"
        }
      >
        {split && !selectedId ? <SplitEmpty /> : children}
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
