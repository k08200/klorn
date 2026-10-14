"use client";

import { ApiKeysSection } from "../../../components/api-keys-section";
import { TelegramSection } from "../../../components/telegram-section";
import { useT } from "../../../lib/i18n";
import { PANEL, SECTION_TITLE } from "./shared";

export function IntegrationsSection() {
  const { t } = useT();
  return (
    <>
      {/* MCP API keys — machine credentials for the MCP endpoint */}
      <section className="mb-8">
        <h2 className={SECTION_TITLE}>{t("settings.section.apiKeys")}</h2>
        <div className={`${PANEL} p-5`}>
          <ApiKeysSection />
        </div>
      </section>

      {/* Telegram channel */}
      <section className="mb-8">
        <TelegramSection />
      </section>
    </>
  );
}
