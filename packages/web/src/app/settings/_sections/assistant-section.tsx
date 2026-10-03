"use client";

import { ByokKeysSection } from "../../../components/byok-keys-section";
import { AgentPanel } from "./agent-panel";
import { RepliesPanel } from "./replies-panel";
import { useAutomationConfig } from "./use-automation-config";

export function AssistantSection() {
  const config = useAutomationConfig();
  return (
    <>
      <AgentPanel config={config} />
      <RepliesPanel config={config} />
      {/* Bring your own LLM key */}
      <section className="mb-8">
        <ByokKeysSection />
      </section>
    </>
  );
}
