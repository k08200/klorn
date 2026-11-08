"use client";

/**
 * Settings → Notifications, "Interruptions per day" (founder design N3,
 * LOCKED 2026-11-08): 3 · 5 · 10 · No limit. Shown only when GET
 * /api/automations carries the budget fields, which it does only for a user
 * under the attention policy — the same check PATCH uses — so this never
 * offers a control the server would ignore.
 */

import { useEffect, useState } from "react";
import { useToast } from "../../../components/toast";
import { SegmentedControl } from "../../../components/ui/segmented-control";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import {
  BUDGET_CHOICES,
  type BudgetChoice,
  type BudgetSetting,
  budgetSetting,
  choiceValue,
  selectedChoice,
} from "./interrupt-budget-model";
import type { AutomationConfig } from "./use-automation-config";

const TITLE_ID = "interrupt-budget-title";
const DESC_ID = "interrupt-budget-desc";

const choiceId = (choice: BudgetChoice): string => String(choice);
const choiceFromId = (id: string): BudgetChoice =>
  BUDGET_CHOICES.find((choice) => choiceId(choice) === id) ?? "none";

export function InterruptBudgetRow({ config }: { config: AutomationConfig | null }) {
  const { t, locale } = useT();
  const { toast } = useToast();
  const [setting, setSetting] = useState<BudgetSetting | null>(null);

  useEffect(() => {
    setSetting(budgetSetting(config));
  }, [config]);

  if (!setting) return null;

  const number = new Intl.NumberFormat(locale);
  const segments = BUDGET_CHOICES.map((choice) => ({
    id: choiceId(choice),
    label: choice === "none" ? t("settings.interruptBudget.none") : number.format(choice),
  }));
  const selected = selectedChoice(setting);

  const save = async (choice: BudgetChoice) => {
    const previous = setting;
    const value = choiceValue(choice, setting);
    if (value === setting.value) return;
    setSetting({ ...setting, value });
    try {
      await apiFetch("/api/automations", {
        method: "PATCH",
        body: JSON.stringify({ interruptBudget: value }),
      });
    } catch (err) {
      captureClientError(err, { scope: "settings.interrupt-budget" });
      setSetting(previous);
      toast(t("settings.toast.settingSaveFailed"), "error");
    }
  };

  return (
    <div className="p-5 space-y-3">
      <div>
        <h3 id={TITLE_ID} className="font-medium">
          {t("settings.interruptBudget.title")}
        </h3>
        <p id={DESC_ID} className="text-role-body text-ink-mid">
          {t("settings.interruptBudget.desc")}
        </p>
      </div>
      <SegmentedControl
        segments={segments}
        value={selected === null ? null : choiceId(selected)}
        onChange={(id) => void save(choiceFromId(id))}
        ariaLabel={t("settings.interruptBudget.title")}
        tall
        className="w-full sm:w-auto sm:max-w-md"
      />
    </div>
  );
}
