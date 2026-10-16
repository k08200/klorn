"use client";

/**
 * "Correct the label" in the Mail v2 reader header, beside the lane: who this
 * sender IS, for this address or for the whole domain, and "clear my
 * correction" when the label shown is the user's own. The label is evidence
 * the classifier reads; the menu changes no lane and acts on no mail.
 * Mirrors the Mac app's SenderLabelMenuItems (Shared/LaneChip.swift).
 */

import type { ReaderSenderLabel } from "@klorn/contract";
import { Menu, type MenuSection } from "../../../../components/ui/menu";
import { useT } from "../../../../lib/i18n";
import { type SenderLabelChange, senderLabelOptions } from "./sender-label-model";

interface SenderLabelMenuProps {
  label: ReaderSenderLabel;
  onCorrect: (change: SenderLabelChange) => void;
}

function TagIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-ink-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
      <circle cx="5.5" cy="5.5" r="1" />
    </svg>
  );
}

export function SenderLabelMenu({ label, onCorrect }: SenderLabelMenuProps) {
  const { t } = useT();
  const options = senderLabelOptions(label);
  const name = (category: string) => t(`mailV2.label.category.${category}`);
  const current = label.current ? name(label.current) : null;

  const accessibleName = !current
    ? t("mailV2.reader.label.a11yNone")
    : t(label.correction ? "mailV2.reader.label.a11yYours" : "mailV2.reader.label.a11y", {
        label: current,
      });

  const sections: MenuSection[] = [
    {
      id: "sender",
      heading: t("mailV2.reader.label.address", { address: label.address }),
      items: options.address.map((choice) => ({
        id: choice.id,
        label: name(choice.category),
        kind: "radio",
        checked: choice.checked,
        onSelect: () => onCorrect(choice.change),
      })),
    },
  ];
  if (options.domain) {
    sections.push({
      id: "domain",
      heading: t("mailV2.reader.label.domain", { domain: options.domain.value }),
      items: options.domain.choices.map((choice) => ({
        id: choice.id,
        label: name(choice.category),
        kind: "radio",
        checked: choice.checked,
        onSelect: () => onCorrect(choice.change),
      })),
    });
  }
  if (options.clear) {
    const scope = options.clear;
    sections.push({
      id: "clear",
      items: [
        {
          id: "clear",
          label: t(
            scope === "sender"
              ? "mailV2.reader.label.clearSender"
              : "mailV2.reader.label.clearDomain",
          ),
          onSelect: () => onCorrect({ kind: "clear", scope }),
        },
      ],
    });
  }

  return (
    <Menu label={accessibleName} sections={sections} active={label.correction !== null} scroll>
      <TagIcon />
      <span className="truncate">{current ?? t("mailV2.reader.label.add")}</span>
    </Menu>
  );
}

export default SenderLabelMenu;
