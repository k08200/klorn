"use client";

/**
 * One name field in a Sheet (the repo's modal primitive: focus moves in, is
 * trapped, and returns to the opener): "New folder" and "Rename" in the Klorn
 * drive. The name is checked here first (drive-model `nameErrorKey`), then
 * sent; a refusal keeps the sheet open with the reason on the field
 * (role="alert", announced again on every attempt) and focus back in it.
 * While the request runs the sheet cannot be dismissed. The caller closes it
 * on success, and mounts a fresh one for each opening (no state carried over).
 */

import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { Input } from "../../components/ui/input";
import { Sheet } from "../../components/ui/sheet";
import { useT } from "../../lib/i18n";
import { NAME_MAX_CHARS, nameErrorKey } from "./drive-model";
import { PendingButton } from "./pending-button";
import { useDialogAction } from "./use-dialog-action";

interface NameDialogProps {
  open: boolean;
  title: string;
  label: string;
  submitLabel: string;
  initialName: string;
  /** Error reporting scope for an unexpected failure. */
  scope: string;
  onClose: () => void;
  /** Sends the name; throws to keep the sheet open with the failure shown. */
  onSubmit: (name: string) => Promise<void>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

export function NameDialog({
  open,
  title,
  label,
  submitLabel,
  initialName,
  scope,
  onClose,
  onSubmit,
  returnFocusRef,
  fallbackFocusRef,
}: NameDialogProps) {
  const { t } = useT();
  const formId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const action = useDialogAction(scope);
  const dismiss = () => {
    if (!action.blocked()) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action.blocked()) return;
    const invalid = nameErrorKey(name);
    if (invalid !== null) {
      action.fail(invalid);
      inputRef.current?.focus();
      return;
    }
    const sent = await action.run(() => onSubmit(name.trim()));
    if (!sent) inputRef.current?.focus();
  };

  const failure = action.failure;
  return (
    <Sheet
      open={open}
      onClose={dismiss}
      title={title}
      closeLabel={t("common.close")}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      fallbackFocusRef={fallbackFocusRef}
      closeUnavailable={action.pending}
      footer={
        <>
          <PendingButton variant="ghost" unavailable={action.pending} onClick={dismiss}>
            {t("common.cancel")}
          </PendingButton>
          <PendingButton type="submit" form={formId} pending={action.pending}>
            {submitLabel}
          </PendingButton>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate>
        {/* No maxLength: a longer paste is shown and refused, never cut short. */}
        <Input
          ref={inputRef}
          id={inputId}
          label={label}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          error={failure ? t(failure.key, { max: String(NAME_MAX_CHARS) }) : undefined}
          errorAttempt={failure?.attempt}
          className="min-h-11 pointer-coarse:text-field"
        />
      </form>
    </Sheet>
  );
}
