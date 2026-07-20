// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ExperienceCandidateBundleV1,
  ExperienceCandidateFinding,
} from "../../shared/agentera-agent-control";
import {
  EXPERIENCE_CANDIDATE_DLP_VERSION,
  ExperienceCandidateValidationError,
  canonicalizeExperienceCandidate,
  scanExperienceCandidate,
} from "./experience-candidate-contract";

interface VectorAsset {
  path: string;
  media_type: "text/markdown" | "text/plain";
  content: string;
}

interface VectorBundle {
  schema_version: number;
  skill_name: string;
  assets: VectorAsset[];
}

interface CanonicalVector {
  name: string;
  bundle: VectorBundle;
  canonical_json?: string;
  content_digest?: string;
  first_asset_content_base64?: string;
}

interface DLPVector {
  name: string;
  bundle: VectorBundle;
  findings: Array<{ code: string; path: string; line: number }>;
}

interface CandidateVectors {
  contract_version: string;
  canonical_cases: CanonicalVector[];
  canonical_rejections: CanonicalVector[];
  dlp_cases: DLPVector[];
}

const vectors = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../contracts/experience-candidate-v1-vectors.json",
    ),
    "utf8",
  ),
) as CandidateVectors;

const forbiddenEvidence = [
  "abcdefghijklmnopqrstuvwxyz012345",
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  "correct-horse-battery",
  "/Users/alice/.hermes/profiles/work",
  String.raw`C:\Users\Alice\.hermes\profiles\work`,
  "private preference",
  "session-1",
  "conversation-1",
];

function toBundle(value: VectorBundle): ExperienceCandidateBundleV1 {
  return {
    schemaVersion: value.schema_version as 1,
    skillName: value.skill_name,
    assets: value.assets.map((asset) => ({
      path: asset.path,
      mediaType: asset.media_type,
      content: asset.content,
    })),
  };
}

function expectInvalidCandidate(
  callback: () => unknown,
): ExperienceCandidateValidationError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ExperienceCandidateValidationError);
    const candidateError = error as ExperienceCandidateValidationError;
    expect(candidateError.code).toBe("invalid_experience_candidate");
    for (const evidence of forbiddenEvidence) {
      expect(candidateError.message).not.toContain(evidence);
    }
    return candidateError;
  }
  throw new Error("expected ExperienceCandidate validation to fail");
}

describe("ExperienceCandidate canonical and DLP contract", () => {
  it("matches the exact versioned canonical vectors and SHA-256 digest", () => {
    expect(vectors.contract_version).toBe(EXPERIENCE_CANDIDATE_DLP_VERSION);
    for (const vector of vectors.canonical_cases) {
      const input = toBundle(vector.bundle);
      const before = structuredClone(input);
      const canonical = canonicalizeExperienceCandidate(input);
      expect(canonical.canonicalJson, vector.name).toBe(vector.canonical_json);
      expect(canonical.contentDigest, vector.name).toBe(vector.content_digest);
      expect(input, `${vector.name} input mutation`).toEqual(before);
    }
  });

  it("rejects every locked invalid canonical vector without evidence text", () => {
    for (const vector of vectors.canonical_rejections) {
      const bundle = toBundle(vector.bundle);
      if (vector.first_asset_content_base64) {
        const invalidBytes = Buffer.from(
          vector.first_asset_content_base64,
          "base64",
        );
        expect(() =>
          new TextDecoder("utf-8", { fatal: true }).decode(invalidBytes),
        ).toThrow();
        bundle.assets[0].content = "\udcff";
      }
      expectInvalidCandidate(() => canonicalizeExperienceCandidate(bundle));
    }
  });

  it("enforces the Go file-count, per-file, and aggregate UTF-8 byte limits", () => {
    const base = toBundle(vectors.canonical_cases[0].bundle);
    expectInvalidCandidate(() =>
      canonicalizeExperienceCandidate({
        ...base,
        assets: [
          ...base.assets,
          ...Array.from({ length: 32 }, (_, index) => ({
            path: `skills/weekly-summary/file-${index}.txt`,
            mediaType: "text/plain" as const,
            content: "x",
          })),
        ],
      }),
    );
    expectInvalidCandidate(() =>
      canonicalizeExperienceCandidate({
        ...base,
        assets: [{ ...base.assets[0], content: "x".repeat(256 * 1024 + 1) }],
      }),
    );
    expectInvalidCandidate(() =>
      canonicalizeExperienceCandidate({
        ...base,
        assets: Array.from({ length: 5 }, (_, index) => ({
          path:
            index === 0
              ? "skills/weekly-summary/SKILL.md"
              : `skills/weekly-summary/part-${index}.txt`,
          mediaType: index === 0 ? "text/markdown" : "text/plain",
          content: "x".repeat(256 * 1024),
        })),
      }),
    );
  });

  it("matches every locked DLP finding and never serializes evidence", () => {
    for (const vector of vectors.dlp_cases) {
      const canonical = canonicalizeExperienceCandidate(
        toBundle(vector.bundle),
      );
      const findings: ExperienceCandidateFinding[] =
        scanExperienceCandidate(canonical);
      expect(findings, vector.name).toEqual(vector.findings);
      const serialized = JSON.stringify(findings);
      for (const evidence of forbiddenEvidence) {
        expect(serialized, vector.name).not.toContain(evidence);
      }
    }
  });

  it("returns no findings for the locked safe candidate", () => {
    const canonical = canonicalizeExperienceCandidate(
      toBundle(vectors.canonical_cases[0].bundle),
    );
    expect(scanExperienceCandidate(canonical)).toEqual([]);
  });
});
