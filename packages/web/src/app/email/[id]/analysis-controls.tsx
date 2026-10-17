"use client";

/**
 * The controls inside "Klorn judgment" (the reader's analysis card), on the
 * three button roles of components/ui/button (design detail pass W3):
 *
 * - Action items: "Create all tasks" and each item's "+ task" are chips.
 * - Priority correction ("Wrong label"): one chip menu of the other
 *   priorities. Legacy reader only — the Mail v2 header's label menu and
 *   "Move to lane" are where v2 corrects a mail's label.
 * - The reply-needed judgment: one "Reply state" chip menu instead of a row of
 *   seven chips. The v2 reader leaves out Later and Done, which its header
 *   already offers as actions on the mail.
 *
 * Every menu is ui/menu: a 28px chip with a 32px hit area (44px on touch),
 * 44px items, arrow keys, Escape back to the trigger.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import { Menu, type MenuItem } from "../../../components/ui/menu";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { captureClientError } from "../../../lib/sentry";
import { serverErrorMessage } from "../../../lib/server-error";
import type { EmailPriority } from "./types";

interface LabelFeedback {
  id: string;
  emailId: string;
  originalPriority: EmailPriority;
  correctedPriority: EmailPriority;
  reason: string | null;
  signals: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReplyNeededChoice =
  | "needed"
  | "today"
  | "waiting_on_me"
  | "waiting_on_them"
  | "not_needed"
  | "later"
  | "done";

interface ReplyNeededFeedback {
  id: string;
  choice: ReplyNeededChoice;
  signal: string;
  evidence: string | null;
  createdAt: string;
}

/** Menu order: the reply states first, then the two that act like triage. */
const REPLY_CHOICES: ReadonlyArray<{ choice: ReplyNeededChoice; labelKey: string }> = [
  { choice: "today", labelKey: "emailDetail.replyNeeded.today" },
  { choice: "waiting_on_me", labelKey: "emailDetail.replyNeeded.onMe" },
  { choice: "waiting_on_them", labelKey: "emailDetail.replyNeeded.waitingOnThem" },
  { choice: "needed", labelKey: "emailDetail.replyNeeded.needed" },
  { choice: "not_needed", labelKey: "emailDetail.replyNeeded.notNeeded" },
  { choice: "later", labelKey: "emailDetail.replyNeeded.later" },
  { choice: "done", labelKey: "emailDetail.replyNeeded.done" },
];

/** The reply states the v2 reader leaves to its header (Later ⌄ and Done). */
export const HEADER_OWNED_REPLY_CHOICES: ReadonlySet<ReplyNeededChoice> = new Set([
  "later",
  "done",
]);

/** `t` is passed in rather than called via useT() here — this is a plain
 * helper, not a component, so it cannot use hooks itself. */
export function priorityLabel(t: (key: string) => string, priority: EmailPriority): string {
  const labels: Record<EmailPriority, string> = {
    URGENT: t("emailDetail.priority.urgent"),
    NORMAL: t("emailDetail.priority.normal"),
    LOW: t("emailDetail.priority.low"),
  };
  return labels[priority];
}

export function ActionItemsPanel({
  emailId,
  actionItems,
}: {
  emailId: string;
  actionItems: string[];
}) {
  const { toast } = useToast();
  const { t } = useT();
  const idPrefix = useId();
  const [creating, setCreating] = useState<"all" | number | null>(null);
  const [created, setCreated] = useState<Set<number>>(new Set());

  async function createTask(index: number) {
    if (created.has(index) || creating !== null) return;
    setCreating(index);
    try {
      await apiFetch(`/api/email/${emailId}/create-tasks`, {
        method: "POST",
        body: JSON.stringify({ indices: [index] }),
      });
      setCreated((prev) => new Set([...prev, index]));
      toast(t("emailDetail.actionItems.taskCreated"), "success");
    } catch (err) {
      captureClientError(err, { scope: "email.action-items.create", emailId });
      toast(t("emailDetail.actionItems.taskCreateFailed"), "error");
    } finally {
      setCreating(null);
    }
  }

  async function createAll() {
    if (creating !== null) return;
    setCreating("all");
    try {
      const uncreatedIndices = actionItems.map((_, i) => i).filter((i) => !created.has(i));
      await apiFetch(`/api/email/${emailId}/create-tasks`, {
        method: "POST",
        body: JSON.stringify({ indices: uncreatedIndices }),
      });
      setCreated(new Set(actionItems.map((_, i) => i)));
      toast(
        t(
          uncreatedIndices.length > 1
            ? "emailDetail.actionItems.taskCreatedMany"
            : "emailDetail.actionItems.taskCreatedOne",
          { count: String(uncreatedIndices.length) },
        ),
        "success",
      );
    } catch (err) {
      captureClientError(err, { scope: "email.action-items.create-all", emailId });
      toast(t("emailDetail.actionItems.tasksCreateFailed"), "error");
    } finally {
      setCreating(null);
    }
  }

  const allCreated = created.size >= actionItems.length;

  return (
    <div className="mt-3">
      {/* On touch each row is 44px tall, so the chips' padded 44px hit areas
          never overlap the row above or below. */}
      <div className="mb-1 flex items-center justify-between gap-2 pointer-coarse:min-h-11">
        <p className="text-caption text-ink-muted">{t("emailDetail.actionItems.title")}</p>
        {!allCreated && (
          <Button
            variant="chip"
            onClick={createAll}
            disabled={creating !== null}
            loading={creating === "all"}
          >
            {t("emailDetail.actionItems.createAll")}
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {actionItems.map((item, i) => {
          const done = created.has(i);
          return (
            // Items are positional (the create-tasks API takes indices).
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the item's identity here
            <li
              key={i}
              className="flex min-h-8 items-center gap-2 text-body pointer-coarse:min-h-11"
            >
              <span aria-hidden="true" className={done ? "text-state-ok-ink" : "text-ink-muted"}>
                {done ? "✓" : "□"}
              </span>
              <span
                id={`${idPrefix}-${i}`}
                className={`min-w-0 flex-1 ${done ? "text-ink-dim line-through" : "text-ink-mid"}`}
              >
                {item}
              </span>
              {!done && (
                <Button
                  variant="chip"
                  // The visible "+ task" stays the name (label in name, WCAG
                  // 2.5.3); the item it adds is its description.
                  aria-describedby={`${idPrefix}-${i}`}
                  onClick={() => createTask(i)}
                  disabled={creating !== null}
                  loading={creating === i}
                  className="shrink-0"
                >
                  {t("emailDetail.actionItems.addTask")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Legacy reader: "Wrong label ⌄" — the other priorities as a chip menu. */
export function LabelFeedbackControl({
  emailId,
  currentPriority,
  onPriorityChange,
}: {
  emailId: string;
  currentPriority: EmailPriority;
  onPriorityChange: (priority: EmailPriority) => void;
}) {
  const { t } = useT();
  const [feedback, setFeedback] = useState<LabelFeedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ feedback: LabelFeedback | null }>(`/api/email/${emailId}/feedback`)
      .then((data) => {
        if (!cancelled) setFeedback(data.feedback);
      })
      .catch((err) => captureClientError(err, { scope: "email.feedback.load", emailId }));
    return () => {
      cancelled = true;
    };
  }, [emailId]);

  const submit = async (correctedPriority: EmailPriority) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<{ feedback: LabelFeedback }>(`/api/email/${emailId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ correctedPriority }),
      });
      setFeedback(data.feedback);
      onPriorityChange(correctedPriority);
    } catch (err) {
      captureClientError(err, { scope: "email.feedback.submit", emailId, correctedPriority });
      setError(serverErrorMessage(err, t("emailDetail.error.reportLabel")));
    } finally {
      setSubmitting(false);
    }
  };

  if (feedback) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-ink-soft">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent-solid" />
        {t("emailDetail.feedback.reported", {
          original: priorityLabel(t, feedback.originalPriority),
          corrected: priorityLabel(t, feedback.correctedPriority),
        })}
      </span>
    );
  }

  const items: MenuItem[] = (["URGENT", "NORMAL", "LOW"] as const)
    .filter((priority) => priority !== currentPriority)
    .map((priority) => ({
      id: priority,
      label: priorityLabel(t, priority),
      onSelect: () => void submit(priority),
    }));

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Menu
        label={t("emailDetail.feedback.wrongLabel")}
        // Not disabled while saving: a disabled trigger would drop the focus the
        // menu hands back to it. submit() ignores a second choice meanwhile.
        sections={[{ id: "priority", heading: t("emailDetail.feedback.actualPriority"), items }]}
      >
        {t("emailDetail.feedback.wrongLabel")}
      </Menu>
      {error && (
        <span role="alert" className="text-caption text-state-danger-ink">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * The reply-needed judgment as one "Reply state ⌄" chip menu. `omit` drops
 * choices another surface already offers (the v2 header's Later and Done).
 * `onStateChange` hears the stored state once loaded and each saved choice, so
 * the v2 header's Done knows whether the user already answered here.
 */
export function ReplyNeededFeedbackControl({
  emailId,
  omit,
  onStateChange,
}: {
  emailId: string;
  omit?: ReadonlySet<ReplyNeededChoice>;
  onStateChange?: (emailId: string, choice: ReplyNeededChoice | null) => void;
}) {
  const { t } = useT();
  const [feedback, setFeedback] = useState<ReplyNeededFeedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ feedback: ReplyNeededFeedback | null }>(
      `/api/email/${emailId}/reply-needed/feedback`,
    )
      .then((data) => {
        if (cancelled) return;
        setFeedback(data.feedback);
        onStateChangeRef.current?.(emailId, data.feedback?.choice ?? null);
      })
      .catch((err) =>
        captureClientError(err, { scope: "email.reply-needed-feedback.load", emailId }),
      );
    return () => {
      cancelled = true;
    };
  }, [emailId]);

  const submit = async (choice: ReplyNeededChoice) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<{
        feedback: { emailId: string; choice: ReplyNeededChoice; signal: string };
      }>(`/api/email/${emailId}/reply-needed/feedback`, {
        method: "POST",
        body: JSON.stringify({ choice }),
      });
      setFeedback({
        id: `${emailId}-${data.feedback.choice}`,
        choice: data.feedback.choice,
        signal: data.feedback.signal,
        evidence: null,
        createdAt: new Date().toISOString(),
      });
      onStateChangeRef.current?.(emailId, data.feedback.choice);
    } catch (err) {
      captureClientError(err, { scope: "email.reply-needed-feedback.submit", emailId, choice });
      setError(serverErrorMessage(err, t("emailDetail.error.saveFeedback")));
    } finally {
      setSubmitting(false);
    }
  };

  // A stored state the menu leaves out (an earlier Done) is still named on the trigger.
  const current = REPLY_CHOICES.find((option) => option.choice === feedback?.choice);
  const currentLabel = current ? t(current.labelKey) : null;
  const items: MenuItem[] = REPLY_CHOICES.filter((option) => !omit?.has(option.choice)).map(
    (option) => ({
      id: option.choice,
      label: t(option.labelKey),
      kind: "radio",
      checked: option.choice === feedback?.choice,
      onSelect: () => void submit(option.choice),
    }),
  );

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
      <span className="text-caption text-ink-muted">
        {t("emailDetail.replyNeeded.judgmentLabel")}
      </span>
      <Menu
        label={
          currentLabel
            ? t("emailDetail.replyNeeded.menuA11y", { state: currentLabel })
            : t("emailDetail.replyNeeded.menu")
        }
        active={Boolean(currentLabel)}
        // Not disabled while saving: a disabled trigger would drop the focus the
        // menu hands back to it. submit() ignores a second choice meanwhile.
        sections={[{ id: "reply-state", items }]}
      >
        {currentLabel ?? t("emailDetail.replyNeeded.menu")}
      </Menu>
      {error && (
        <span role="alert" className="text-caption text-state-danger-ink">
          {error}
        </span>
      )}
    </div>
  );
}
