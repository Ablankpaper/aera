import { createHash } from "node:crypto";
import type {
  CanonicalExperienceCandidate,
  ExperienceCandidateAssetV1,
  ExperienceCandidateBundleV1,
  ExperienceCandidateFinding,
} from "../../shared/agentera-agent-control";

export const EXPERIENCE_CANDIDATE_SCHEMA_VERSION = 1;
export const EXPERIENCE_CANDIDATE_DLP_VERSION = "experience-candidate-dlp-v1";
export const MAX_EXPERIENCE_CANDIDATE_FILES = 32;
export const MAX_EXPERIENCE_CANDIDATE_FILE_BYTES = 256 * 1024;
export const MAX_EXPERIENCE_CANDIDATE_BYTES = 1024 * 1024;

const MAX_EXPERIENCE_CANDIDATE_PATH_BYTES = 512;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const FORBIDDEN_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "__pycache__",
  "__pypackages__",
  "venv",
  "virtualenv",
  "site-packages",
  "target",
  "dist",
  "build",
  "coverage",
  "auth.json",
  "memory.md",
  "user.md",
  "credentials",
  "credential-store",
  "sessions",
  "conversation",
  "conversations",
  "curator",
  "archives",
]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".dmg",
  ".pkg",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".class",
  ".jar",
  ".pyc",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".mp3",
  ".mp4",
  ".mov",
]);

type ExperienceCandidateValidationErrorCode = "invalid_experience_candidate";

interface DLPPattern {
  code: string;
  pattern: RegExp;
}

const DLP_PATTERNS: readonly DLPPattern[] = [
  {
    code: "credential_private_key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i,
  },
  {
    code: "credential_bearer_token",
    pattern: /\bbearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    code: "credential_jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/,
  },
  {
    code: "credential_url",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@[^/\s]+/i,
  },
  {
    code: "credential_api_key",
    pattern:
      /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/i,
  },
  {
    code: "credential_environment_secret",
    pattern:
      /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIALS?)[ \t]*=[ \t]*["']?[^"'\s#]{8,}/i,
  },
  {
    code: "private_absolute_path",
    pattern:
      /(?:^|[\s"'(])\/(?:Users|home|var\/folders|private\/var\/folders)\/[^\s"'<>]+/,
  },
  {
    code: "private_absolute_path",
    pattern:
      /\b[A-Z]:\\(?:Users|Documents and Settings|ProgramData)\\[^\r\n"'<>]+/i,
  },
  {
    code: "private_absolute_path",
    pattern:
      /(?:HERMES_HOME|userData|\.hermes[/\\]profiles)[ \t]*[:=][ \t]*\S+/i,
  },
  {
    code: "private_memory_payload",
    pattern: /^[ \t]*#{1,6}[ \t]+MEMORY(?:\.md)?[ \t]*$/i,
  },
  {
    code: "private_user_payload",
    pattern: /^[ \t]*#{1,6}[ \t]+USER(?:\.md)?[ \t]*$/i,
  },
  {
    code: "private_session_payload",
    pattern: /"session_id"[ \t]*:.*"messages"[ \t]*:/i,
  },
  {
    code: "private_conversation_payload",
    pattern: /"conversation_id"[ \t]*:.*"messages"[ \t]*:/i,
  },
  {
    code: "private_credential_store_payload",
    pattern: /"credential_store"[ \t]*:/i,
  },
  {
    code: "private_curator_payload",
    pattern: /"curator_state"[ \t]*:/i,
  },
];

export class ExperienceCandidateValidationError extends Error {
  readonly code: ExperienceCandidateValidationErrorCode;

  constructor(code: ExperienceCandidateValidationErrorCode) {
    super(`ExperienceCandidate validation failed: ${code}.`);
    this.name = "ExperienceCandidateValidationError";
    this.code = code;
  }
}

function invalidCandidate(): never {
  throw new ExperienceCandidateValidationError("invalid_experience_candidate");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function exactObject(value: unknown, fields: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pathExtension(value: string): string {
  const basename = value.slice(value.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? "" : basename.slice(dot).toLowerCase();
}

function normalizeCandidatePath(value: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    hasUnpairedSurrogate(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("://") ||
    value.startsWith("/") ||
    (value.length >= 2 && value[1] === ":")
  ) {
    return invalidCandidate();
  }
  const normalized = value.normalize("NFC");
  if (
    normalized === "." ||
    Buffer.byteLength(normalized, "utf8") > MAX_EXPERIENCE_CANDIDATE_PATH_BYTES
  ) {
    return invalidCandidate();
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      FORBIDDEN_SEGMENTS.has(lower) ||
      FORBIDDEN_EXTENSIONS.has(pathExtension(lower))
    ) {
      return invalidCandidate();
    }
  }
  return normalized;
}

function normalizeAssets(
  skillName: string,
  input: readonly ExperienceCandidateAssetV1[],
): ExperienceCandidateAssetV1[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_EXPERIENCE_CANDIDATE_FILES
  ) {
    return invalidCandidate();
  }
  const prefix = `skills/${skillName}/`;
  const requiredSkillPath = `${prefix}SKILL.md`;
  const assets: ExperienceCandidateAssetV1[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let hasSkill = false;
  for (const candidate of input) {
    if (!exactObject(candidate, ["path", "mediaType", "content"])) {
      return invalidCandidate();
    }
    const normalizedPath = normalizeCandidatePath(candidate.path);
    if (
      !normalizedPath.startsWith(prefix) ||
      normalizedPath === prefix ||
      seen.has(normalizedPath) ||
      typeof candidate.content !== "string" ||
      hasUnpairedSurrogate(candidate.content) ||
      candidate.content.includes("\0")
    ) {
      return invalidCandidate();
    }
    const extension = pathExtension(normalizedPath);
    if (
      (extension === ".md" && candidate.mediaType !== "text/markdown") ||
      (extension !== ".md" && candidate.mediaType !== "text/plain")
    ) {
      return invalidCandidate();
    }
    const contentBytes = Buffer.byteLength(candidate.content, "utf8");
    if (contentBytes > MAX_EXPERIENCE_CANDIDATE_FILE_BYTES) {
      return invalidCandidate();
    }
    totalBytes += contentBytes;
    if (totalBytes > MAX_EXPERIENCE_CANDIDATE_BYTES) {
      return invalidCandidate();
    }
    seen.add(normalizedPath);
    hasSkill ||= normalizedPath === requiredSkillPath;
    assets.push({
      path: normalizedPath,
      mediaType: candidate.mediaType,
      content: candidate.content,
    });
  }
  if (!hasSkill) return invalidCandidate();
  return assets.sort((left, right) => utf8Compare(left.path, right.path));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function canonicalizeExperienceCandidate(
  input: ExperienceCandidateBundleV1,
): CanonicalExperienceCandidate {
  if (
    !exactObject(input, ["schemaVersion", "skillName", "assets"]) ||
    input.schemaVersion !== EXPERIENCE_CANDIDATE_SCHEMA_VERSION ||
    typeof input.skillName !== "string" ||
    hasUnpairedSurrogate(input.skillName) ||
    !SKILL_NAME_PATTERN.test(input.skillName)
  ) {
    return invalidCandidate();
  }
  const assets = normalizeAssets(input.skillName, input.assets);
  const bundle: ExperienceCandidateBundleV1 = {
    schemaVersion: EXPERIENCE_CANDIDATE_SCHEMA_VERSION,
    skillName: input.skillName,
    assets,
  };
  const encoded = canonicalJson({
    schema_version: EXPERIENCE_CANDIDATE_SCHEMA_VERSION,
    skill_name: bundle.skillName,
    assets: bundle.assets.map((asset) => ({
      path: asset.path,
      media_type: asset.mediaType,
      content: asset.content,
    })),
  });
  return {
    bundle,
    canonicalJson: encoded,
    contentDigest: createHash("sha256").update(encoded, "utf8").digest("hex"),
  };
}

export function scanExperienceCandidate(
  candidate: CanonicalExperienceCandidate,
): ExperienceCandidateFinding[] {
  const findings: ExperienceCandidateFinding[] = [];
  const seen = new Set<string>();
  for (const asset of candidate.bundle.assets) {
    for (const [index, rawLine] of asset.content.split("\n").entries()) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      for (const rule of DLP_PATTERNS) {
        if (!rule.pattern.test(line)) continue;
        const finding: ExperienceCandidateFinding = {
          code: rule.code,
          path: asset.path,
          line: index + 1,
        };
        const key = `${finding.code}\0${finding.path}\0${finding.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding);
      }
    }
  }
  return findings.sort((left, right) => {
    const codeOrder = utf8Compare(left.code, right.code);
    if (codeOrder !== 0) return codeOrder;
    const pathOrder = utf8Compare(left.path, right.path);
    if (pathOrder !== 0) return pathOrder;
    return (left.line ?? 0) - (right.line ?? 0);
  });
}
