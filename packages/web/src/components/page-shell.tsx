/**
 * One page shell for every app route (design detail pass W5): content starts
 * 32px from the sidebar (16px on a phone), is at most 1120px wide, and is
 * left-aligned — so the H1 sits at the same x on Today, Mail, Calendar, Files,
 * Assistant and Settings instead of drifting with each page's own centring.
 * The shell's <main> (app-shell.tsx DOCK_CLEARANCE) pads the scroll end past
 * the phone tab bar and the assistant button, so no page adds its own.
 */
export const PAGE_SHELL =
  "w-full max-w-[calc(1120px+4rem)] px-4 pb-6 pt-6 md:px-8 md:pb-10 md:pt-8";
