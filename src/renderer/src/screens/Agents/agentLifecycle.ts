import type { OrganizationAgentSubmissionStatus } from "../../../../shared/agentera-agent-control";

export type AgentLifecycleState =
  | "local_only"
  | "pending"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "approved_current"
  | "approved_dirty";

export type AgentLifecycleAction =
  | "edit"
  | "submit"
  | "withdraw"
  | "delete_draft"
  | "discard_unpublished"
  | "archive_installation";

export interface AgentLifecycleInput {
  draftRevision: number;
  publishedRevision: number | null;
  submissionStatus: OrganizationAgentSubmissionStatus | null;
  hasInstallation: boolean;
}

export interface AgentLifecycle {
  state: AgentLifecycleState;
  actions: AgentLifecycleAction[];
}

export function deriveAgentLifecycle(
  input: AgentLifecycleInput,
): AgentLifecycle {
  let state: AgentLifecycleState;
  let actions: AgentLifecycleAction[];

  if (input.submissionStatus === "pending") {
    state = "pending";
    actions = ["edit", "withdraw"];
  } else if (
    input.submissionStatus === "rejected" ||
    input.submissionStatus === "withdrawn" ||
    input.submissionStatus === "superseded"
  ) {
    state = input.submissionStatus;
    actions = ["edit", "submit", "delete_draft"];
  } else if (input.publishedRevision !== null) {
    if (input.draftRevision === input.publishedRevision) {
      state = "approved_current";
      actions = ["edit", "delete_draft"];
    } else {
      state = "approved_dirty";
      actions = ["edit", "submit", "discard_unpublished"];
    }
  } else {
    state = "local_only";
    actions = ["edit", "submit", "delete_draft"];
  }

  if (input.hasInstallation) actions.push("archive_installation");
  return { state, actions };
}
