"use client";

import Link from "next/link";
import { useState } from "react";
import Button from "../../../components/ui/button";
import { useT } from "../../../lib/i18n";
import { SETTINGS_SECTIONS, settingsSectionHref } from "../sections";

const LIST_ID = "settings-section-list";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform duration-120 ease-fluid motion-reduce:transition-none ${
        open ? "rotate-180" : ""
      }`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * Settings section nav. From 768px it is a left column that is always open;
 * below that it collapses to a full-width picker showing the current section,
 * which expands to the same list of links.
 */
export function SettingsNav({ pathname, showTeam }: { pathname: string; showTeam: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  const sections = SETTINGS_SECTIONS.filter((section) => section.id !== "team" || showTeam);
  const current = SETTINGS_SECTIONS.find((section) => settingsSectionHref(section.id) === pathname);

  return (
    <nav
      aria-label={t("settings.nav.label")}
      className="mb-6 md:sticky md:top-6 md:mb-0 md:w-56 md:shrink-0 md:self-start"
    >
      <p className="mb-2 hidden px-3 text-head text-ink md:block">{t("settings.title")}</p>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-controls={LIST_ID}
        onClick={() => setOpen((value) => !value)}
        className="w-full md:hidden"
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <span className="sr-only">{t("settings.nav.label")}: </span>
          {current ? t(current.labelKey) : t("settings.title")}
        </span>
        <Chevron open={open} />
      </Button>
      <ul id={LIST_ID} className={`${open ? "mt-2" : "hidden"} space-y-1 md:mt-0 md:block`}>
        {sections.map((section) => {
          const href = settingsSectionHref(section.id);
          const active = href === pathname;
          return (
            <li key={section.id}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`focus-ring flex min-h-11 items-center rounded-control px-3 text-label transition-colors duration-120 ease-fluid ${
                  active
                    ? "bg-surface-hover text-ink"
                    : "text-ink-mid hover:bg-surface-hover hover:text-ink"
                }`}
              >
                {t(section.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
