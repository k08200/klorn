/**
 * The expanded layout's floating "Ask the assistant" opens this side sheet:
 * the same thread as the Assistant tab (one query cache), beside whatever the
 * user is reading. Back / Escape closes it.
 */
import { useI18n } from "../../i18n/I18nProvider";
import { Sheet } from "../../ui/Sheet";
import { ChatThread } from "./ChatThread";
import "./assistant.css";

export function AssistantSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet
      closeButton
      open={open}
      onClose={onClose}
      title={t("tab.assistant")}
      variant="side"
      className="assistant-sheet"
    >
      <ChatThread variant="sheet" onNavigate={onClose} />
    </Sheet>
  );
}
