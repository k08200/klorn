import type { WorkGraphContext } from "./work-graph";

export type EvePlaybookId =
  | "investment_ops"
  | "customer_success"
  | "launch_room"
  | "hiring_pipeline";

export type EvePlaybookDomain = "investment" | "customer_success" | "launch" | "hiring";

export interface PlaybookStep {
  id: string;
  title: string;
  description: string;
}

export interface EvePlaybook {
  id: EvePlaybookId;
  domain: EvePlaybookDomain;
  name: string;
  description: string;
  bestFor: string;
  cadence: string;
  targetSignals: string[];
  activationChecklist: PlaybookStep[];
  active?: boolean;
}

export interface PlaybookContextHit {
  id: string;
  kind: WorkGraphContext["kind"];
  title: string;
  href: string | null;
  risk: WorkGraphContext["risk"];
  lastActivityAt: string;
  reasons: string[];
  matchedKeywords: string[];
  signalScore: number;
}

export interface PlaybookRecommendation {
  playbook: EvePlaybook;
  score: number;
  confidence: number;
  reasons: string[];
  activeContexts: PlaybookContextHit[];
  suggestedFirstActions: PlaybookStep[];
}

export interface PlaybookRecommendationSummary {
  generatedAt: string;
  playbooks: EvePlaybook[];
  recommendations: PlaybookRecommendation[];
}
