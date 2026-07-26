import type {
  AgenteraGlobalProfile,
  SetAgenteraGlobalProfileEntryInput,
} from "./agentera-global-profile";

export interface AgenteraAgentIdentityCandidateProposal {
  kind: "agent_identity";
  profileId: string;
  proposedDisplayName: string;
  summary: string;
  confidence: number;
}

export interface AgenteraGlobalProfileCandidateProposal {
  kind: "global_profile";
  profileId: string;
  proposedValue: string;
  entry: SetAgenteraGlobalProfileEntryInput;
  summary: string;
  confidence: number;
}

export type AgenteraMemoryCandidateProposal =
  | AgenteraAgentIdentityCandidateProposal
  | AgenteraGlobalProfileCandidateProposal;

export type AgenteraMemoryCandidateDecision =
  | "pending"
  | "confirmed"
  | "rejected"
  | "expired";

export interface AgenteraMemoryCandidateBatch {
  id: string;
  decision: AgenteraMemoryCandidateDecision;
  proposals: AgenteraMemoryCandidateProposal[];
  createdAt: string;
  expiresAt: string;
}

export interface AgenteraMemoryCandidateAppliedIdentity {
  profileId: string;
  displayName: string;
  revision: number;
  updatedAt: string;
}

export interface AgenteraMemoryCandidateConfirmation {
  batch: AgenteraMemoryCandidateBatch;
  identity: AgenteraMemoryCandidateAppliedIdentity | null;
  globalProfile: AgenteraGlobalProfile | null;
}

export type AgenteraMemoryCandidateResult<T> =
  | { success: true; value: T }
  | { success: false; error: string };
