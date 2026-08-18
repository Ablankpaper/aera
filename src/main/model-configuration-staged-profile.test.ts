import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearManagedModelFileRoots,
  managedModelFileLocation,
  registerManagedModelFileRoots,
} from "./model-configuration-managed-files";
import {
  createStagedProfileCandidate,
  StagedProfileError,
} from "./model-configuration-staged-profile";
import * as stagedProfileModule from "./model-configuration-staged-profile";
import { profileHome, safeWriteFile } from "./utils";

const roots: string[] = [];

afterEach(() => {
  clearManagedModelFileRoots();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("staged Profile activation", () => {
  it("accepts a valid legacy or fresh Profile whose optional .env is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    registerManagedModelFileRoots({ globalRoot: root, profiles: {} });

    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "no-env-yet",
      sourceKind: "clone",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, "config.yaml"), "{}\n");
      },
    });

    const destination = await candidate.activate();

    expect(existsSync(destination)).toBe(true);
    expect(existsSync(join(destination, ".env"))).toBe(false);
  });

  it("rejects a staged global-catalog mutation instead of silently discarding it", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    const liveModels = [
      {
        id: "live-model",
        name: "Live model",
        provider: "openai",
        model: "gpt-live",
        baseUrl: "https://api.openai.com/v1",
        createdAt: 1,
      },
    ];
    writeFileSync(join(root, "models.json"), `${JSON.stringify(liveModels)}\n`);

    await expect(
      createStagedProfileCandidate({
        profilesRoot,
        destinationProfileId: "global-write-attempt",
        sourceKind: "clone",
        materialize: ({ stagingHome, stagingPath }) => {
          mkdirSync(stagingPath, { recursive: true });
          writeFileSync(join(stagingPath, "config.yaml"), "{}\n");
          writeFileSync(
            join(stagingHome, "models.json"),
            `${JSON.stringify([
              {
                ...liveModels[0],
                id: "staged-model",
                model: "gpt-staged",
              },
            ])}\n`,
          );
        },
      }),
    ).rejects.toMatchObject({ code: "staged_profile_invalid" });
    expect(existsSync(join(profilesRoot, "global-write-attempt"))).toBe(false);
    expect(readFileSync(join(root, "models.json"), "utf8")).toBe(
      `${JSON.stringify(liveModels)}\n`,
    );
  });

  it("refuses activation when the live global catalog changed after staging", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    registerManagedModelFileRoots({ globalRoot: root, profiles: {} });
    const originalModels = [
      {
        id: "route-a",
        name: "Route A",
        provider: "openai",
        model: "gpt-a",
        baseUrl: "https://api.openai.com/v1",
        createdAt: 1,
      },
    ];
    writeFileSync(
      join(root, "models.json"),
      `${JSON.stringify(originalModels)}\n`,
    );
    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "catalog-raced",
      sourceKind: "agent_projection",
      materialize: ({ stagingHome, stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(
          join(stagingPath, "config.yaml"),
          "model:\n  provider: openai\n  default: gpt-a\n  base_url: https://api.openai.com/v1\n",
        );
        writeFileSync(
          join(stagingHome, "models.json"),
          `${JSON.stringify(originalModels)}\n`,
        );
      },
    });
    writeFileSync(
      join(root, "models.json"),
      `${JSON.stringify([
        {
          ...originalModels[0],
          id: "route-b",
          model: "gpt-b",
        },
      ])}\n`,
    );

    await expect(candidate.activate()).rejects.toMatchObject({
      code: "staged_profile_invalid",
    });
    expect(existsSync(candidate.destinationPath)).toBe(false);
  });

  // @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Recoverable model configuration#Staged Profile activation protects live state]]
  it("registers the newly activated Profile as a managed-file root", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    registerManagedModelFileRoots({ globalRoot: root, profiles: {} });

    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "fresh-agent",
      sourceKind: "agent_projection",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, ".env"), "# staged\n");
      },
    });

    const destination = await candidate.activate();

    expect(existsSync(destination)).toBe(true);
    expect(managedModelFileLocation(join(destination, ".env"))).toEqual({
      role: "env",
      profileId: "fresh-agent",
    });
  });

  it("records a terminal committed activation without storing filesystem paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    registerManagedModelFileRoots({ globalRoot: root, profiles: {} });
    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "journalled",
      sourceKind: "encrypted_backup",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, ".env"), "# staged\n");
      },
    });

    await candidate.activate();

    const journalText = readFileSync(
      join(root, ".aera-profile-activation-journal.jsonl"),
      "utf8",
    );
    const records = journalText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.state)).toEqual([
      "staged",
      "committed",
    ]);
    expect(records.at(-1)).toMatchObject({
      profileId: "journalled",
      sourceKind: "encrypted_backup",
      state: "committed",
    });
    expect(journalText).not.toContain(root);
  });

  it("leaves live bytes absent and cleans only its own staging on owner change", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    const stagingRoot = join(root, ".aera-profile-staging");
    const unrelated = join(stagingRoot, "unrelated-diagnostic");
    mkdirSync(profilesRoot);
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, "keep.txt"), "keep\n");

    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "owner-changed",
      sourceKind: "agent_projection",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, ".env"), "# staged\n");
      },
    });

    await expect(
      candidate.activate({ authorize: () => false }),
    ).rejects.toMatchObject({
      code: "staged_profile_owner_changed",
    } satisfies Partial<StagedProfileError>);
    expect(existsSync(join(profilesRoot, "owner-changed"))).toBe(false);
    expect(existsSync(join(unrelated, "keep.txt"))).toBe(true);
  });

  it("refuses a destination created after staging without replacing its bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    const destination = join(profilesRoot, "collision");
    mkdirSync(profilesRoot);
    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "collision",
      sourceKind: "import",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, ".env"), "# staged\n");
      },
    });
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "unchanged\n");

    await expect(candidate.activate()).rejects.toMatchObject({
      code: "staged_profile_destination_exists",
    });
    expect(existsSync(join(destination, "keep.txt"))).toBe(true);
  });

  it("keeps follow-up Agent materialization inside staging until activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    registerManagedModelFileRoots({ globalRoot: root, profiles: {} });
    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "materialized-agent",
      sourceKind: "agent_projection",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, ".env"), "# staged\n");
      },
    });
    const materialize = (
      candidate as typeof candidate & {
        materialize<T>(
          callback: (context: {
            stagingHome: string;
            stagingPath: string;
          }) => T | Promise<T>,
        ): Promise<T>;
      }
    ).materialize;

    expect(typeof materialize).toBe("function");
    await materialize(({ stagingPath }) => {
      expect(stagingPath).toBe(candidate.stagingPath);
      expect(profileHome("materialized-agent")).toBe(stagingPath);
      expect(existsSync(candidate.destinationPath)).toBe(false);
      safeWriteFile(
        join(profileHome("materialized-agent"), "config.yaml"),
        "{}\n",
      );
      writeFileSync(join(stagingPath, "projection-marker.json"), "{}\n");
    });

    expect(existsSync(join(candidate.stagingPath, "projection-marker.json"))).toBe(
      true,
    );
    expect(existsSync(candidate.destinationPath)).toBe(false);
    await candidate.activate();
    expect(
      existsSync(join(candidate.destinationPath, "projection-marker.json")),
    ).toBe(true);
  });

  it("rejects a syntactically valid active route missing from the staged catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);

    await expect(
      createStagedProfileCandidate({
        profilesRoot,
        destinationProfileId: "missing-route",
        sourceKind: "clone",
        materialize: ({ stagingHome, stagingPath }) => {
          mkdirSync(stagingPath, { recursive: true });
          writeFileSync(join(stagingPath, ".env"), "OPENAI_API_KEY=<redacted>\n");
          writeFileSync(
            join(stagingPath, "config.yaml"),
            "model:\n  provider: openai\n  default: missing-model\n  base_url: https://api.openai.com/v1\n",
          );
          writeFileSync(
            join(stagingHome, "models.json"),
            `${JSON.stringify([
              {
                id: "known",
                name: "Known",
                provider: "openai",
                model: "known-model",
                baseUrl: "https://api.openai.com/v1",
                createdAt: 1,
              },
            ])}\n`,
          );
        },
      }),
    ).rejects.toMatchObject({ code: "staged_profile_invalid" });
    expect(existsSync(join(profilesRoot, "missing-route"))).toBe(false);
  });

  it("rolls back an interrupted staged candidate without touching other evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "interrupted",
      sourceKind: "import",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, ".env"), "# staged\n");
      },
    });
    const unrelated = join(root, ".aera-profile-staging", "keep-evidence");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "keep.txt"), "keep\n");
    const recover = (
      stagedProfileModule as typeof stagedProfileModule & {
        recoverStagedProfileActivations?: (input: {
          profilesRoot: string;
        }) => Promise<void>;
      }
    ).recoverStagedProfileActivations;

    expect(typeof recover).toBe("function");
    await recover?.({ profilesRoot });

    expect(existsSync(candidate.stagingHome)).toBe(false);
    expect(existsSync(candidate.destinationPath)).toBe(false);
    expect(readFileSync(join(unrelated, "keep.txt"), "utf8")).toBe("keep\n");
    const states = readFileSync(
      join(root, ".aera-profile-activation-journal.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { state: string }).state);
    expect(states).toEqual(["staged", "rolled_back"]);
  });

  it("finishes an interrupted post-rename activation without deleting live bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-staged-profile-"));
    roots.push(root);
    const profilesRoot = join(root, "profiles");
    mkdirSync(profilesRoot);
    const candidate = await createStagedProfileCandidate({
      profilesRoot,
      destinationProfileId: "renamed-before-journal",
      sourceKind: "agent_projection",
      materialize: ({ stagingPath }) => {
        mkdirSync(stagingPath, { recursive: true });
        writeFileSync(join(stagingPath, ".env"), "# staged\n");
      },
    });
    renameSync(candidate.stagingPath, candidate.destinationPath);
    const recover = (
      stagedProfileModule as typeof stagedProfileModule & {
        recoverStagedProfileActivations?: (input: {
          profilesRoot: string;
        }) => Promise<void>;
      }
    ).recoverStagedProfileActivations;

    expect(typeof recover).toBe("function");
    await recover?.({ profilesRoot });

    expect(readFileSync(join(candidate.destinationPath, ".env"), "utf8")).toBe(
      "# staged\n",
    );
    const states = readFileSync(
      join(root, ".aera-profile-activation-journal.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { state: string }).state);
    expect(states).toEqual(["staged", "committed"]);
  });
});
