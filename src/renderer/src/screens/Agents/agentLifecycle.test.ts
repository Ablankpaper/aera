import { describe, expect, it } from "vitest";
import {
  deriveAgentLifecycle,
  type AgentLifecycleAction,
  type AgentLifecycleState,
} from "./agentLifecycle";

describe("Organization Agent lifecycle", () => {
  it.each<{
    state: AgentLifecycleState;
    draftRevision: number;
    publishedRevision: number | null;
    submissionStatus:
      | "pending"
      | "approved"
      | "rejected"
      | "withdrawn"
      | "superseded"
      | null;
    actions: AgentLifecycleAction[];
  }>([
    {
      state: "local_only",
      draftRevision: 1,
      publishedRevision: null,
      submissionStatus: null,
      actions: ["edit", "submit", "delete_draft"],
    },
    {
      state: "pending",
      draftRevision: 1,
      publishedRevision: null,
      submissionStatus: "pending",
      actions: ["edit", "withdraw"],
    },
    {
      state: "rejected",
      draftRevision: 1,
      publishedRevision: null,
      submissionStatus: "rejected",
      actions: ["edit", "submit", "delete_draft"],
    },
    {
      state: "withdrawn",
      draftRevision: 1,
      publishedRevision: null,
      submissionStatus: "withdrawn",
      actions: ["edit", "submit", "delete_draft"],
    },
    {
      state: "superseded",
      draftRevision: 2,
      publishedRevision: null,
      submissionStatus: "superseded",
      actions: ["edit", "submit", "delete_draft"],
    },
    {
      state: "approved_current",
      draftRevision: 2,
      publishedRevision: 2,
      submissionStatus: "approved",
      actions: ["edit", "delete_draft"],
    },
    {
      state: "approved_dirty",
      draftRevision: 3,
      publishedRevision: 2,
      submissionStatus: "approved",
      actions: ["edit", "submit", "discard_unpublished"],
    },
  ])("derives $state and its exact actions", (input) => {
    expect(
      deriveAgentLifecycle({
        draftRevision: input.draftRevision,
        publishedRevision: input.publishedRevision,
        submissionStatus: input.submissionStatus,
        hasInstallation: false,
      }),
    ).toEqual({ state: input.state, actions: input.actions });
  });

  it("never exposes draft deletion while a submission is pending", () => {
    const lifecycle = deriveAgentLifecycle({
      draftRevision: 4,
      publishedRevision: 3,
      submissionStatus: "pending",
      hasInstallation: true,
    });

    expect(lifecycle.state).toBe("pending");
    expect(lifecycle.actions).toEqual([
      "edit",
      "withdraw",
      "archive_installation",
    ]);
    expect(lifecycle.actions).not.toContain("delete_draft");
    expect(lifecycle.actions).not.toContain("discard_unpublished");
  });
});
