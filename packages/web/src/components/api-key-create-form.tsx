/**
 * The create-key controls. Without write tools: the pre-A3 row (name field and
 * Create side by side). With write tools: a real form in reading order: name,
 * the Read only / Read and write choice, then Create, so a keyboard or
 * screen-reader user meets the choice before submitting, and Enter in the name
 * field submits it.
 */

import type { ApiKeyPermissionWire } from "@klorn/contract";
import { fieldClasses, primaryButtonClasses } from "../lib/api-key-controls";
import { useT } from "../lib/i18n";
import { ApiKeyPermissionPicker } from "./api-key-permission-picker";

const NAME_MAX_LENGTH = 60;

interface Props {
  name: string;
  onNameChange: (next: string) => void;
  creating: boolean;
  onCreate: () => void;
  writeTools: boolean;
  permission: ApiKeyPermissionWire;
  onPermissionChange: (next: ApiKeyPermissionWire) => void;
}

export function ApiKeyCreateForm({
  name,
  onNameChange,
  creating,
  onCreate,
  writeTools,
  permission,
  onPermissionChange,
}: Props) {
  const { t } = useT();
  const canCreate = !creating && name.trim() !== "";
  const label = creating ? t("settings.apiKeys.creating") : t("settings.apiKeys.create");

  const nameField = (
    <input
      value={name}
      onChange={(e) => onNameChange(e.target.value)}
      maxLength={NAME_MAX_LENGTH}
      placeholder={t("settings.apiKeys.namePlaceholder")}
      className={fieldClasses(writeTools)}
    />
  );

  if (!writeTools) {
    return (
      <div className="flex gap-2">
        {nameField}
        <button
          type="button"
          onClick={onCreate}
          disabled={!canCreate}
          className={`${primaryButtonClasses(false)} shrink-0`}
        >
          {label}
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canCreate) onCreate();
      }}
    >
      {nameField}
      <ApiKeyPermissionPicker value={permission} onChange={onPermissionChange} />
      <button type="submit" disabled={!canCreate} className={primaryButtonClasses(true)}>
        {label}
      </button>
    </form>
  );
}
