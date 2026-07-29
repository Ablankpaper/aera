export const AGENTERA_GLOBAL_PROFILE_CATEGORIES = [
  "communication_style",
  "decision_pattern",
  "risk_preference",
  "work_habit",
  "tool_preference",
  "accessibility",
  "locale",
] as const;

export type AgenteraGlobalProfileCategory =
  (typeof AGENTERA_GLOBAL_PROFILE_CATEGORIES)[number];

export interface AgenteraGlobalProfileEntry {
  id: string;
  category: AgenteraGlobalProfileCategory;
  content: string;
  source: "user_explicit" | "candidate_confirmed" | "imported";
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgenteraGlobalProfile {
  schemaVersion: 1;
  profileVersion: number;
  updatedAt: string | null;
  entries: AgenteraGlobalProfileEntry[];
}

export interface SetAgenteraGlobalProfileEntryInput {
  id: string;
  category: AgenteraGlobalProfileCategory;
  content: string;
}

export type AgenteraGlobalProfileResult<T> =
  { success: true; value: T } | { success: false; error: string };

export interface PrepareAgenteraGlobalProfileConversationContextInput {
  runId: string;
  profile?: string;
  resumeSessionId: string | null;
}

export interface AgenteraConversationBoundarySummary {
  scope: "USER" | "WORKSPACE" | "ORGANIZATION";
  scopeId: string;
  scopeDisplayName: string | null;
  visibility:
    "PRIVATE" | "WORKSPACE_SHARED" | "ORGANIZATION_SHARED" | "ARTIFACT_ONLY";
  origin: "NEW_CONVERSATION" | "LEGACY_DEFAULT";
}

export interface AgenteraGlobalProfileConversationContext {
  globalProfileVersion: number | null;
  requiresBoundApiTransport: boolean;
  degraded: boolean;
  conversationBoundary: AgenteraConversationBoundarySummary | null;
}

export interface AgenteraGlobalProfileHistoryItem {
  profileVersion: number;
  updatedAt: string | null;
  entryCount: number;
}
