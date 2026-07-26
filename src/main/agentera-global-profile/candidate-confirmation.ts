import type { AgentIdentityService } from "../agent-identity";
import type {
  AgenteraMemoryCandidateBatch,
  AgenteraMemoryCandidateConfirmation,
  AgenteraMemoryCandidateResult,
} from "../../shared/agentera-memory-candidate";
import type { AgenteraMemoryCandidateManager } from "./candidate-manager";
import type { AgenteraGlobalProfileManager } from "./manager";

export interface AgenteraMemoryCandidateConfirmationCoordinatorOptions {
  candidates: AgenteraMemoryCandidateManager;
  identities: AgentIdentityService;
  globalProfiles: AgenteraGlobalProfileManager;
}

export class AgenteraMemoryCandidateConfirmationCoordinator {
  private readonly candidates: AgenteraMemoryCandidateManager;
  private readonly identities: AgentIdentityService;
  private readonly globalProfiles: AgenteraGlobalProfileManager;

  constructor(options: AgenteraMemoryCandidateConfirmationCoordinatorOptions) {
    this.candidates = options.candidates;
    this.identities = options.identities;
    this.globalProfiles = options.globalProfiles;
  }

  confirm(
    userId: string,
    batchId: string,
    expectedProfileId: string,
  ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateConfirmation> {
    const prepared = this.candidates.prepareConfirmation(userId, batchId);
    if (!prepared.success) return prepared;
    if (
      !prepared.value.proposals.every(
        (proposal) => proposal.profileId === expectedProfileId,
      )
    ) {
      return {
        success: false,
        error: "Memory candidate batch does not belong to this Agent.",
      };
    }

    const identityProposal = prepared.value.proposals.find(
      (proposal) => proposal.kind === "agent_identity",
    );
    const globalProfileProposal = prepared.value.proposals.find(
      (proposal) => proposal.kind === "global_profile",
    );
    const currentGlobalProfile = globalProfileProposal
      ? this.globalProfiles.get(userId)
      : null;
    if (currentGlobalProfile && !currentGlobalProfile.success) {
      return currentGlobalProfile;
    }

    let identityChange: Extract<
      ReturnType<AgentIdentityService["setDisplayName"]>,
      { success: true }
    > | null = null;
    let globalProfileChange: Extract<
      ReturnType<AgenteraGlobalProfileManager["beginConfirmedCandidateEntry"]>,
      { success: true }
    > | null = null;

    const fail = (
      error: string,
    ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateConfirmation> => {
      const rollbackErrors: string[] = [];
      if (globalProfileChange) {
        const rollback =
          this.globalProfiles.rollbackUncommittedConfirmedCandidateEntry(
            userId,
            globalProfileChange.rollbackToken,
          );
        if (!rollback.success) rollbackErrors.push(rollback.error);
      }
      if (identityChange && identityProposal?.kind === "agent_identity") {
        const rollback = this.identities.rollbackUncommittedDisplayName(
          identityProposal.profileId,
          identityChange.operationId,
        );
        if (!rollback.success) rollbackErrors.push(rollback.error);
      }
      return {
        success: false as const,
        error:
          rollbackErrors.length === 0
            ? error
            : `${error} Rollback failed: ${rollbackErrors.join("; ")}`,
      };
    };

    if (identityProposal?.kind === "agent_identity") {
      const result = this.identities.setDisplayName(
        identityProposal.profileId,
        identityProposal.proposedDisplayName,
      );
      if (!result.success) return fail(result.error);
      identityChange = result;
    }

    if (globalProfileProposal?.kind === "global_profile") {
      const result = this.globalProfiles.beginConfirmedCandidateEntry(
        userId,
        globalProfileProposal.entry,
        globalProfileProposal.confidence,
      );
      if (!result.success) return fail(result.error);
      globalProfileChange = result;
    }

    const completed = this.candidates.completeConfirmation(userId, batchId);
    if (!completed.success) return fail(completed.error);
    if (globalProfileChange) {
      this.globalProfiles.commitConfirmedCandidateEntry(
        globalProfileChange.rollbackToken,
      );
    }

    return {
      success: true,
      value: {
        batch: completed.value,
        identity: identityChange?.identity ?? null,
        globalProfile: globalProfileChange?.value ?? null,
      },
    };
  }

  reject(
    userId: string,
    batchId: string,
    expectedProfileId: string,
  ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch> {
    const prepared = this.candidates.prepareConfirmation(userId, batchId);
    if (!prepared.success) return prepared;
    if (
      !prepared.value.proposals.every(
        (proposal) => proposal.profileId === expectedProfileId,
      )
    ) {
      return {
        success: false as const,
        error: "Memory candidate batch does not belong to this Agent.",
      };
    }
    return this.candidates.reject(userId, batchId);
  }
}
