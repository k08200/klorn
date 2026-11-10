/**
 * Notifications → "Interruptions per day" (founder design N3, LOCKED
 * 2026-11-08): 3 · 5 · 10 · No limit. Rendered only when GET
 * /api/automations carries the budget fields — only for a user under the
 * attention policy, the same check PATCH uses — so the app never shows a
 * control the server would ignore.
 */
import { type KeyboardEvent, useRef } from "react";
import type { NotificationSettingsWire } from "../../api/wire";
import { useI18n } from "../../i18n/I18nProvider";
import {
  BUDGET_CHOICES,
  type BudgetChoice,
  budgetSetting,
  choiceValue,
  nextChoice,
  selectedChoice,
} from "./interrupt-budget-model";

export function InterruptBudgetGroup({
  data,
  save,
}: {
  data: NotificationSettingsWire;
  save: (patch: Partial<NotificationSettingsWire>) => Promise<void>;
}) {
  const { t, intlTag } = useI18n();
  const groupRef = useRef<HTMLDivElement>(null);
  const setting = budgetSetting(data);
  if (!setting) return null;
  const selected = selectedChoice(setting);
  const tabStop = selected ?? BUDGET_CHOICES[0];
  const number = new Intl.NumberFormat(intlTag);

  const choose = (choice: BudgetChoice) => {
    const value = choiceValue(choice, setting);
    if (value !== setting.value) void save({ interruptBudget: value });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const to = nextChoice(event.key, selected);
    if (to === null) return;
    event.preventDefault();
    choose(to);
    const index = BUDGET_CHOICES.indexOf(to);
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[index]?.focus();
  };

  return (
    <section className="set-group" aria-labelledby="set-budget">
      <h2 id="set-budget" className="set-group__title">
        {t("settings.budget.title")}
      </h2>
      <ul className="set-list card">
        <li className="set-row">
          <div className="set-row__control set-budget">
            <div
              ref={groupRef}
              className="segmented set-budget__choices"
              role="radiogroup"
              aria-labelledby="set-budget"
              aria-describedby="set-budget-hint"
              onKeyDown={onKeyDown}
            >
              {BUDGET_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={selected === choice}
                  tabIndex={choice === tabStop ? 0 : -1}
                  className="segmented__item"
                  onClick={() => choose(choice)}
                >
                  {choice === "none" ? t("settings.budget.none") : number.format(choice)}
                </button>
              ))}
            </div>
          </div>
        </li>
      </ul>
      <p id="set-budget-hint" className="set-group__foot">
        {t("settings.budget.hint")}
      </p>
    </section>
  );
}
