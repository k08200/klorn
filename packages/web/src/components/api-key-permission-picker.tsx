/**
 * The permission choice on the create-key form: "Read only" (default) or
 * "Read and write", plus the one sentence saying what read-write allows. Native
 * radios, so one tab stop and arrow-key movement come with the platform; each
 * label is the 44px target. Rendered only while the server reports write tools.
 */

import type { ApiKeyPermissionWire } from "@klorn/contract";
import { useId } from "react";
import { API_KEY_PERMISSIONS, permissionLabelKey } from "../lib/api-key-ui";
import { useT } from "../lib/i18n";

interface Props {
  value: ApiKeyPermissionWire;
  onChange: (next: ApiKeyPermissionWire) => void;
}

const OPTION = "flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink";
const RADIO = "size-4 shrink-0 accent-accent-solid focus-ring";

export function ApiKeyPermissionPicker({ value, onChange }: Props) {
  const { t } = useT();
  const groupName = useId();
  const noteId = useId();

  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-medium text-ink-mid">
        {t("settings.apiKeys.permission.legend")}
      </legend>
      <div className="flex flex-wrap gap-x-5">
        {API_KEY_PERMISSIONS.map((permission) => (
          <label key={permission} className={OPTION}>
            <input
              type="radio"
              name={groupName}
              value={permission}
              checked={value === permission}
              onChange={() => onChange(permission)}
              aria-describedby={permission === "read_write" ? noteId : undefined}
              className={RADIO}
            />
            {t(permissionLabelKey(permission))}
          </label>
        ))}
      </div>
      <p id={noteId} className="text-xs text-ink-mid">
        {t("settings.apiKeys.permission.readWriteNote")}
      </p>
    </fieldset>
  );
}
