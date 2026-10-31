"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Listbox, type ListboxSection } from "@/components/ui/listbox";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useT } from "@/lib/i18n";
import {
  formatPrice,
  isValidModelId,
  type ModelGroup,
  modelsFor,
  PLAYGROUND_PROVIDERS,
  type PlaygroundModel,
  type PlaygroundProvider,
  PRICES_CHECKED_ON,
  PROVIDER_LABEL,
} from "./models";

/** Sentinel option id for the free-text model field. */
export const OTHER_MODEL = "__other__";

const GROUP_ORDER: readonly ModelGroup[] = ["klorn", "anthropic", "google", "openai", "xai"];
// Vendor names are proper nouns, the same in every locale.
const VENDOR_HEADING: Record<Exclude<ModelGroup, "klorn">, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  xai: "xAI",
};

interface ModelFieldProps {
  provider: PlaygroundProvider;
  onProviderChange: (next: PlaygroundProvider) => void;
  /** A listed model id, or OTHER_MODEL. */
  choice: string;
  onChoiceChange: (next: string) => void;
  customModel: string;
  onCustomModelChange: (next: string) => void;
  disabled?: boolean;
}

function useSections(provider: PlaygroundProvider): ListboxSection[] {
  const { t } = useT();
  const models = modelsFor(provider);
  const listed = GROUP_ORDER.flatMap((group) => {
    const inGroup = models.filter((m) => m.group === group);
    if (inGroup.length === 0) return [];
    return [
      {
        id: group,
        heading: group === "klorn" ? t("playground.model.klorn") : VENDOR_HEADING[group],
        options: inGroup.map((m) => ({
          id: m.id,
          label: m.id,
          mono: true,
          badge: m.measured
            ? t("playground.model.measured", {
                correct: String(m.measured.correct),
                total: String(m.measured.total),
              })
            : undefined,
          hint: formatPrice(m),
        })),
      },
    ];
  });
  return [
    ...listed,
    { id: "other", options: [{ id: OTHER_MODEL, label: t("playground.model.other") }] },
  ];
}

function TriggerFace({ model, choice }: { model: PlaygroundModel | undefined; choice: string }) {
  const { t } = useT();
  if (!model || choice === OTHER_MODEL) {
    return <span className="truncate text-label text-ink">{t("playground.model.other")}</span>;
  }
  return (
    <>
      <span className="min-w-0 flex-1 truncate font-mono text-label text-ink">{model.id}</span>
      {model.measured && (
        <span className="shrink-0 rounded-control bg-state-info-bg px-2 py-0.5 text-caption font-semibold text-accent-deeper">
          {t("playground.model.klorn")}
        </span>
      )}
      {model.measured && (
        <span className="hidden shrink-0 text-caption text-ink-mid sm:inline">
          {model.measured.correct}/{model.measured.total}
        </span>
      )}
    </>
  );
}

export function ModelField({
  provider,
  onProviderChange,
  choice,
  onChoiceChange,
  customModel,
  onCustomModelChange,
  disabled = false,
}: ModelFieldProps) {
  const { t } = useT();
  const labelId = useId();
  const sections = useSections(provider);
  const selected = modelsFor(provider).find((m) => m.id === choice);
  const customInvalid =
    choice === OTHER_MODEL && customModel.trim() !== "" && !isValidModelId(customModel.trim());

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-label text-ink-soft">{t("playground.provider.label")}</span>
        <SegmentedControl
          ariaLabel={t("playground.provider.label")}
          value={provider}
          onChange={onProviderChange}
          disabled={disabled}
          segments={PLAYGROUND_PROVIDERS.map((p) => ({ id: p, label: PROVIDER_LABEL[p] }))}
          className="max-md:[&_[role=radio]]:h-11"
        />
      </div>
      <div className="flex flex-col gap-2">
        <span id={labelId} className="text-label text-ink-soft">
          {t("playground.model.label")}
        </span>
        <Listbox
          label={t("playground.model.label")}
          labelledBy={labelId}
          sections={sections}
          value={choice}
          onChange={onChoiceChange}
          disabled={disabled}
          footer={t("playground.model.priceNote", { date: PRICES_CHECKED_ON })}
        >
          <TriggerFace model={selected} choice={choice} />
        </Listbox>
        {choice === OTHER_MODEL ? (
          <Input
            label={t("playground.model.otherLabel")}
            value={customModel}
            onChange={(e) => onCustomModelChange(e.target.value)}
            placeholder={t("playground.model.otherPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            className="font-mono"
            error={customInvalid ? t("playground.model.otherInvalid") : undefined}
          />
        ) : (
          <p className="text-caption text-ink-mid">
            {selected?.measured
              ? t("playground.model.klornNote")
              : t("playground.model.listedNote")}
          </p>
        )}
      </div>
    </div>
  );
}
