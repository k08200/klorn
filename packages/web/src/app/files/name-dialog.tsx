"use client";

/**
 * One name field in a Sheet (the repo's modal primitive: focus moves in, is
 * trapped, and returns to the opener): "New folder" and "Rename" in the Klorn
 * drive. The name is checked here first (drive-model `nameErrorKey`), then
 * sent; a refusal keeps the sheet open with the reason on the field
 * (role="alert") and focus back in it. The caller closes the sheet on success.
 */

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import Button from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Sheet } from "../../components/ui/sheet";
import { useT } from "../../lib/i18n";
import { NAME_MAX_CHARS, type NameErrorKey, nameErrorKey } from "./drive-model";
import { reportDriveError } from "./use-klorn-drive";

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
}: NameDialogProps) {
  const { t } = useT();
  const formId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [errorKey, setErrorKey] = useState<NameErrorKey | null>(null);
  const [pending, setPending] = useState(false);

  // Each opening starts from the given name, with no error left over.
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setErrorKey(null);
    setPending(false);
  }, [open, initialName]);

  const fail = (key: NameErrorKey) => {
    setErrorKey(key);
    inputRef.current?.focus();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const invalid = nameErrorKey(name);
    if (invalid !== null) {
      fail(invalid);
      return;
    }
    setPending(true);
    setErrorKey(null);
    try {
      await onSubmit(name.trim());
    } catch (err) {
      fail(reportDriveError(err, scope));
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t("common.close")}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate>
        <Input
          ref={inputRef}
          id={inputId}
          label={label}
          value={name}
          onChange={(event) => setName(event.target.value)}
          // maxLength counts UTF-16 units; the check counts characters, as the server does.
          maxLength={NAME_MAX_CHARS * 2}
          autoComplete="off"
          spellCheck={false}
          error={errorKey ? t(errorKey) : undefined}
          className="min-h-11 pointer-coarse:text-field"
        />
      </form>
    </Sheet>
  );
}
