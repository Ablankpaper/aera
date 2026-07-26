import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentIdentityService } from "../agent-identity";
import { safeWriteFile } from "../utils";
import { AgenteraMemoryCandidateManager } from "./candidate-manager";
import { AgenteraMemoryCandidateConfirmationCoordinator } from "./candidate-confirmation";
import { AgenteraGlobalProfileManager } from "./manager";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "vertical-agent-one";
const SECOND_PROFILE_ID = "vertical-agent-two";

interface CandidateFixture {
  root: string;
  profileRoot: string;
  secondProfileRoot: string;
  candidates: AgenteraMemoryCandidateManager;
  identities: AgentIdentityService;
  globalProfiles: AgenteraGlobalProfileManager;
  coordinator: AgenteraMemoryCandidateConfirmationCoordinator;
}

function snapshotFiles(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix = ""): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) visit(path, relative);
      else result[relative] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return result;
}

function createFixture(
  options: { failGlobalProfileWrite?: boolean } = {},
): CandidateFixture {
  const root = mkdtempSync(join(tmpdir(), "aera-candidate-confirmation-"));
  const profileRoot = join(root, "profiles", PROFILE_ID);
  const secondProfileRoot = join(root, "profiles", SECOND_PROFILE_ID);
  safeWriteFile(
    join(profileRoot, "profile-meta.json"),
    `${JSON.stringify({ id: PROFILE_ID, name: "原始名字" }, null, 2)}\n`,
    0o600,
  );
  safeWriteFile(join(profileRoot, "SOUL.md"), "# 原始身份\n", 0o600);
  safeWriteFile(
    join(secondProfileRoot, "profile-meta.json"),
    `${JSON.stringify({ id: SECOND_PROFILE_ID, name: "第二个智能体" }, null, 2)}\n`,
    0o600,
  );
  safeWriteFile(
    join(secondProfileRoot, "SOUL.md"),
    "# 第二个智能体的独立身份\n",
    0o600,
  );

  const candidates = new AgenteraMemoryCandidateManager({
    userDataPath: root,
    createBatchId: () => BATCH_ID,
  });
  const identities = new AgentIdentityService({
    resolveProfilePath: (profileId) => join(root, "profiles", profileId),
    createOperationId: (() => {
      const ids = [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ];
      return () => ids.shift()!;
    })(),
  });
  const globalProfiles = new AgenteraGlobalProfileManager({
    userDataPath: root,
    writeFile: (path, content, mode) => {
      if (
        options.failGlobalProfileWrite &&
        path.endsWith(join(USER_ID, "global-profile.json"))
      ) {
        throw new Error("simulated global profile failure");
      }
      safeWriteFile(path, content, mode);
    },
  });
  const coordinator = new AgenteraMemoryCandidateConfirmationCoordinator({
    candidates,
    identities,
    globalProfiles,
  });

  return {
    root,
    profileRoot,
    secondProfileRoot,
    candidates,
    identities,
    globalProfiles,
    coordinator,
  };
}

describe("AgenteraMemoryCandidateConfirmationCoordinator", () => {
  it("applies one mixed batch to the current Agent identity and account profile before confirming it", () => {
    const fixture = createFixture();
    const extracted = fixture.candidates.extract(
      USER_ID,
      "你的名字是星港，以后称呼我为领航员。",
      PROFILE_ID,
    );
    if (!extracted.success || !extracted.value) {
      throw new Error("missing candidate batch");
    }
    const result = fixture.coordinator.confirm(
      USER_ID,
      extracted.value.id,
      PROFILE_ID,
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.value.batch.decision).toBe("confirmed");
    expect(result.value.identity).toMatchObject({
      profileId: PROFILE_ID,
      displayName: "星港",
      revision: 1,
    });
    expect(result.value.globalProfile?.entries).toEqual([
      expect.objectContaining({
        id: "communication_style.preferred_address",
        content: "Address the user as “领航员”.",
        source: "candidate_confirmed",
        confidence: 1,
      }),
    ]);
    expect(
      JSON.parse(
        readFileSync(join(fixture.profileRoot, "profile-meta.json"), "utf8"),
      ),
    ).toMatchObject({ name: "星港" });
    expect(
      readFileSync(join(fixture.profileRoot, "SOUL.md"), "utf8"),
    ).toContain("星港");
  });

  it("shares the confirmed address with a second Agent conversation without sharing the first Agent identity", () => {
    const fixture = createFixture();
    const secondSoulBefore = readFileSync(
      join(fixture.secondProfileRoot, "SOUL.md"),
      "utf8",
    );
    const extracted = fixture.candidates.extract(
      USER_ID,
      "你的名字是星港，以后称呼我为领航员。",
      PROFILE_ID,
    );
    if (!extracted.success || !extracted.value) {
      throw new Error("missing candidate batch");
    }

    expect(
      fixture.coordinator.confirm(USER_ID, extracted.value.id, PROFILE_ID),
    ).toMatchObject({ success: true });
    const secondConversation =
      fixture.globalProfiles.prepareConversationSnapshot(
        USER_ID,
        "second-agent-new-conversation",
      );
    if (!secondConversation.success) {
      throw new Error(secondConversation.error);
    }
    expect(
      fixture.globalProfiles.bindConversationSnapshotToSession(
        USER_ID,
        "second-agent-new-conversation",
        SECOND_PROFILE_ID,
        "second-agent-hermes-session",
      ),
    ).toMatchObject({ success: true });

    expect(secondConversation.value.renderedSnapshot).toContain(
      "Address the user as “领航员”.",
    );
    expect(secondConversation.value.renderedSnapshot).not.toContain("星港");
    expect(
      readFileSync(join(fixture.secondProfileRoot, "SOUL.md"), "utf8"),
    ).toBe(secondSoulBefore);
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.secondProfileRoot, "profile-meta.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ name: "第二个智能体" });
  });

  it("restores the Agent identity and keeps the batch pending when the account profile write fails", () => {
    const fixture = createFixture({ failGlobalProfileWrite: true });
    const extracted = fixture.candidates.extract(
      USER_ID,
      "你的名字是星港，以后称呼我为领航员。",
      PROFILE_ID,
    );
    if (!extracted.success || !extracted.value) {
      throw new Error("missing candidate batch");
    }
    const beforeConfirmation = snapshotFiles(fixture.root);

    const result = fixture.coordinator.confirm(
      USER_ID,
      extracted.value.id,
      PROFILE_ID,
    );

    expect(result).toEqual({
      success: false,
      error: "simulated global profile failure",
    });
    expect(
      JSON.parse(
        readFileSync(join(fixture.profileRoot, "profile-meta.json"), "utf8"),
      ),
    ).toMatchObject({ name: "原始名字" });
    expect(readFileSync(join(fixture.profileRoot, "SOUL.md"), "utf8")).toBe(
      "# 原始身份\n",
    );
    expect(
      fixture.candidates.prepareConfirmation(USER_ID, extracted.value.id),
    ).toMatchObject({ success: true, value: { decision: "pending" } });
    expect(fixture.globalProfiles.get(USER_ID)).toEqual({
      success: true,
      value: {
        schemaVersion: 1,
        profileVersion: 0,
        updatedAt: null,
        entries: [],
      },
    });
    expect(snapshotFiles(fixture.root)).toEqual(beforeConfirmation);
  });

  it("compensates both writes if marking the candidate batch confirmed fails", () => {
    const fixture = createFixture();
    const extracted = fixture.candidates.extract(
      USER_ID,
      "你的名字是星港，以后称呼我为领航员。",
      PROFILE_ID,
    );
    if (!extracted.success || !extracted.value) {
      throw new Error("missing candidate batch");
    }
    const batchPath = join(
      fixture.root,
      "agentera-global-profile",
      USER_ID,
      "candidates",
      `${BATCH_ID}.json`,
    );
    const originalBatch = readFileSync(batchPath, "utf8");
    const beforeConfirmation = snapshotFiles(fixture.root);
    const failingCandidates = new AgenteraMemoryCandidateManager({
      userDataPath: fixture.root,
      writeFile: (path, content, mode) => {
        if (content.includes('"decision": "confirmed"')) {
          throw new Error("simulated confirmation failure");
        }
        safeWriteFile(path, content, mode);
      },
    });
    const coordinator = new AgenteraMemoryCandidateConfirmationCoordinator({
      candidates: failingCandidates,
      identities: fixture.identities,
      globalProfiles: fixture.globalProfiles,
    });

    const result = coordinator.confirm(USER_ID, extracted.value.id, PROFILE_ID);

    expect(result).toEqual({
      success: false,
      error: "simulated confirmation failure",
    });
    expect(readFileSync(batchPath, "utf8")).toBe(originalBatch);
    expect(
      JSON.parse(
        readFileSync(join(fixture.profileRoot, "profile-meta.json"), "utf8"),
      ),
    ).toMatchObject({ name: "原始名字" });
    expect(readFileSync(join(fixture.profileRoot, "SOUL.md"), "utf8")).toBe(
      "# 原始身份\n",
    );
    const profile = fixture.globalProfiles.get(USER_ID);
    expect(profile.success && profile.value.entries).toEqual([]);
    expect(existsSync(batchPath)).toBe(true);
    expect(snapshotFiles(fixture.root)).toEqual(beforeConfirmation);
  });

  it("refuses to confirm a batch through a different Agent target", () => {
    const fixture = createFixture();
    const extracted = fixture.candidates.extract(
      USER_ID,
      "你的名字是星港。",
      PROFILE_ID,
    );
    if (!extracted.success || !extracted.value) {
      throw new Error("missing candidate batch");
    }

    expect(
      fixture.coordinator.confirm(
        USER_ID,
        extracted.value.id,
        "vertical-agent-two",
      ),
    ).toEqual({
      success: false,
      error: "Memory candidate batch does not belong to this Agent.",
    });
    expect(
      JSON.parse(
        readFileSync(join(fixture.profileRoot, "profile-meta.json"), "utf8"),
      ),
    ).toMatchObject({ name: "原始名字" });
  });

  it("rejects a batch only through the Agent that produced it", () => {
    const fixture = createFixture();
    const extracted = fixture.candidates.extract(
      USER_ID,
      "以后称呼我为领航员。",
      PROFILE_ID,
    );
    if (!extracted.success || !extracted.value) {
      throw new Error("missing candidate batch");
    }

    expect(
      fixture.coordinator.reject(
        USER_ID,
        extracted.value.id,
        "vertical-agent-two",
      ),
    ).toEqual({
      success: false,
      error: "Memory candidate batch does not belong to this Agent.",
    });
    expect(
      fixture.coordinator.reject(USER_ID, extracted.value.id, PROFILE_ID),
    ).toMatchObject({ success: true, value: { decision: "rejected" } });
  });
});
