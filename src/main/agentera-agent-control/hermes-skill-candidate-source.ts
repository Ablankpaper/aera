import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type {
  EligibleExperienceSkill,
  ExperienceCandidateBundleV1,
} from "../../shared/agentera-agent-control";
export type { EligibleExperienceSkill } from "../../shared/agentera-agent-control";
import {
  canonicalizeExperienceCandidate,
  MAX_EXPERIENCE_CANDIDATE_BYTES,
  MAX_EXPERIENCE_CANDIDATE_FILES,
  MAX_EXPERIENCE_CANDIDATE_FILE_BYTES,
} from "./experience-candidate-contract";

const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 4096;
const PROJECTED_SKILL_PREFIX = "agentera.";
const FORBIDDEN_ENTRY_NAMES = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  ".venv",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
  "site-packages",
  "__pycache__",
  "__pypackages__",
  "venv",
  "virtualenv",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
]);

export interface HermesSkillCandidateRead {
  sourceRelativePath: string;
  bundle: ExperienceCandidateBundleV1;
}

export interface HermesSkillCandidateSource {
  listEligible(profilePath: string): EligibleExperienceSkill[];
  readCandidate(
    profilePath: string,
    skillName: string,
  ): HermesSkillCandidateRead;
}

export interface HermesSkillCandidateFileIO {
  lstat(path: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
  };
  realpath(path: string): string;
  readdir(path: string): string[];
  readFile(path: string): Buffer;
}

export type HermesSkillCandidateSourceErrorCode = "candidate_source_ineligible";

export class HermesSkillCandidateSourceError extends Error {
  readonly code: HermesSkillCandidateSourceErrorCode;

  constructor(code: HermesSkillCandidateSourceErrorCode) {
    super("Hermes Skill candidate source is not eligible.");
    this.name = "HermesSkillCandidateSourceError";
    this.code = code;
  }
}

interface ResolvedSourceRoot {
  profileRoot: string;
  skillsRoot: string;
}

interface SkillDescriptor {
  skillName: string;
  description: string;
  directoryPath: string;
  directoryRelativePath: string;
}

interface EligibilityMetadata {
  usage: Record<string, unknown>;
  bundledNames: Set<string>;
  hubNames: Set<string>;
  hubPaths: Set<string>;
}

const nodeIO: HermesSkillCandidateFileIO = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path),
};

function ineligible(): never {
  throw new HermesSkillCandidateSourceError("candidate_source_ineligible");
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function safeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function forbiddenEntry(name: string): boolean {
  return name.startsWith(".") || FORBIDDEN_ENTRY_NAMES.has(name.toLowerCase());
}

function decodeUtf8(bytes: Buffer): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return ineligible();
  }
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (
      code === 0 ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    ) {
      return ineligible();
    }
  }
  return content;
}

function scalarFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function readFrontmatter(
  content: string,
  fallbackName: string,
): { skillName: string; description: string } {
  const result = { skillName: fallbackName, description: "" };
  const lines = content.slice(0, 16 * 1024).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return result;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = scalarFrontmatterValue(line.slice(separator + 1));
    if (key === "name" && value.length > 0) result.skillName = value;
    if (key === "description" && value.length > 0) {
      result.description = value.slice(0, 512);
    }
  }
  return result;
}

function exactRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ReadOnlyHermesSkillCandidateSource implements HermesSkillCandidateSource {
  private readonly io: HermesSkillCandidateFileIO;

  constructor(io: HermesSkillCandidateFileIO = nodeIO) {
    this.io = io;
  }

  listEligible(profilePath: string): EligibleExperienceSkill[] {
    try {
      const root = this.resolveRoot(profilePath);
      const metadata = this.readMetadata(root);
      const descriptors = this.discoverSkills(root);
      const counts = new Map<string, number>();
      for (const descriptor of descriptors) {
        counts.set(
          descriptor.skillName,
          (counts.get(descriptor.skillName) ?? 0) + 1,
        );
      }
      return descriptors
        .filter(
          (descriptor) =>
            counts.get(descriptor.skillName) === 1 &&
            this.isEligible(descriptor, metadata),
        )
        .map(({ skillName, description }) => ({ skillName, description }))
        .sort((left, right) =>
          Buffer.compare(
            Buffer.from(left.skillName, "utf8"),
            Buffer.from(right.skillName, "utf8"),
          ),
        );
    } catch (error) {
      if (error instanceof HermesSkillCandidateSourceError) throw error;
      return ineligible();
    }
  }

  readCandidate(
    profilePath: string,
    skillName: string,
  ): HermesSkillCandidateRead {
    try {
      if (!SKILL_NAME_PATTERN.test(skillName)) return ineligible();
      const root = this.resolveRoot(profilePath);
      const metadata = this.readMetadata(root);
      const matches = this.discoverSkills(root).filter(
        (descriptor) => descriptor.skillName === skillName,
      );
      if (matches.length !== 1 || !this.isEligible(matches[0], metadata)) {
        return ineligible();
      }
      const descriptor = matches[0];
      const bundle = this.readBundle(root, descriptor);
      return {
        sourceRelativePath: `skills/${descriptor.directoryRelativePath}`,
        bundle,
      };
    } catch (error) {
      if (error instanceof HermesSkillCandidateSourceError) throw error;
      return ineligible();
    }
  }

  private resolveRoot(profilePath: string): ResolvedSourceRoot {
    if (!isAbsolute(profilePath)) return ineligible();
    const profileStat = this.io.lstat(profilePath);
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
      return ineligible();
    }
    const profileRoot = this.io.realpath(profilePath);
    if (!isAbsolute(profileRoot)) return ineligible();
    const skillsPath = join(profileRoot, "skills");
    const skillsStat = this.io.lstat(skillsPath);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
      return ineligible();
    }
    const skillsRoot = this.io.realpath(skillsPath);
    if (!contained(profileRoot, skillsRoot)) return ineligible();
    return { profileRoot, skillsRoot };
  }

  private readMetadata(root: ResolvedSourceRoot): EligibilityMetadata {
    const usageValue = this.readOptionalJson(
      join(root.skillsRoot, ".usage.json"),
      root,
    );
    const usage = exactRecord(usageValue) ? usageValue : {};

    const bundledNames = new Set<string>();
    const bundled = this.readOptionalText(
      join(root.skillsRoot, ".bundled_manifest"),
      root,
    );
    for (const line of bundled?.split(/\r?\n/) ?? []) {
      const name = line.trim().split(":", 1)[0]?.trim();
      if (name) bundledNames.add(name);
    }

    const hubNames = new Set<string>();
    const hubPaths = new Set<string>();
    const hubValue = this.readOptionalJson(
      join(root.skillsRoot, ".hub", "lock.json"),
      root,
    );
    if (exactRecord(hubValue) && exactRecord(hubValue.installed)) {
      for (const [name, rawEntry] of Object.entries(hubValue.installed)) {
        hubNames.add(name);
        if (
          !exactRecord(rawEntry) ||
          typeof rawEntry.install_path !== "string"
        ) {
          continue;
        }
        const normalized = this.normalizeRelativeMetadataPath(
          rawEntry.install_path,
        );
        if (normalized !== null) hubPaths.add(normalized);
      }
    }
    return { usage, bundledNames, hubNames, hubPaths };
  }

  private readOptionalJson(path: string, root: ResolvedSourceRoot): unknown {
    const text = this.readOptionalText(path, root);
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private readOptionalText(
    path: string,
    root: ResolvedSourceRoot,
  ): string | null {
    let stat: ReturnType<HermesSkillCandidateFileIO["lstat"]>;
    try {
      stat = this.io.lstat(path);
    } catch {
      return null;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 0 ||
      stat.size > MAX_METADATA_BYTES
    ) {
      return null;
    }
    const realPath = this.io.realpath(path);
    if (!contained(root.skillsRoot, realPath)) return null;
    const bytes = this.io.readFile(path);
    if (bytes.length !== stat.size || bytes.length > MAX_METADATA_BYTES)
      return null;
    try {
      return decodeUtf8(bytes);
    } catch {
      return null;
    }
  }

  private normalizeRelativeMetadataPath(value: string): string | null {
    const trimmed = value.trim().replaceAll("\\", "/");
    if (trimmed.length === 0 || trimmed.startsWith("/")) return null;
    const parts = trimmed.split("/");
    if (parts.some((part) => !safeEntryName(part))) return null;
    return parts.join("/");
  }

  private discoverSkills(root: ResolvedSourceRoot): SkillDescriptor[] {
    const descriptors: SkillDescriptor[] = [];
    let visited = 0;
    const entries = [...this.io.readdir(root.skillsRoot)].sort();
    for (const firstName of entries) {
      visited += 1;
      if (visited > MAX_DISCOVERY_ENTRIES) return ineligible();
      if (!safeEntryName(firstName) || forbiddenEntry(firstName)) continue;
      const firstPath = join(root.skillsRoot, firstName);
      if (!this.safeDirectory(root, firstPath)) continue;
      const flat = this.readDescriptor(root, firstPath, firstName);
      if (flat !== null) {
        descriptors.push(flat);
        continue;
      }
      let children: string[];
      try {
        children = [...this.io.readdir(firstPath)].sort();
      } catch {
        continue;
      }
      for (const secondName of children) {
        visited += 1;
        if (visited > MAX_DISCOVERY_ENTRIES) return ineligible();
        if (!safeEntryName(secondName) || forbiddenEntry(secondName)) continue;
        const secondPath = join(firstPath, secondName);
        if (!this.safeDirectory(root, secondPath)) continue;
        const nested = this.readDescriptor(
          root,
          secondPath,
          `${firstName}/${secondName}`,
        );
        if (nested !== null) descriptors.push(nested);
      }
    }
    return descriptors;
  }

  private safeDirectory(root: ResolvedSourceRoot, path: string): boolean {
    try {
      const stat = this.io.lstat(path);
      return (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        contained(root.skillsRoot, this.io.realpath(path))
      );
    } catch {
      return false;
    }
  }

  private readDescriptor(
    root: ResolvedSourceRoot,
    directoryPath: string,
    directoryRelativePath: string,
  ): SkillDescriptor | null {
    const skillPath = join(directoryPath, "SKILL.md");
    try {
      const stat = this.io.lstat(skillPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 0 ||
        stat.size > MAX_EXPERIENCE_CANDIDATE_FILE_BYTES
      ) {
        return null;
      }
      const realPath = this.io.realpath(skillPath);
      const realDirectory = this.io.realpath(directoryPath);
      if (
        !contained(root.skillsRoot, realDirectory) ||
        !contained(realDirectory, realPath)
      ) {
        return null;
      }
      const bytes = this.io.readFile(skillPath);
      if (bytes.length !== stat.size) return null;
      const frontmatter = readFrontmatter(
        decodeUtf8(bytes),
        directoryRelativePath.split("/").at(-1)!,
      );
      return {
        ...frontmatter,
        directoryPath,
        directoryRelativePath,
      };
    } catch {
      return null;
    }
  }

  private isEligible(
    descriptor: SkillDescriptor,
    metadata: EligibilityMetadata,
  ): boolean {
    if (
      !SKILL_NAME_PATTERN.test(descriptor.skillName) ||
      descriptor.skillName.startsWith(PROJECTED_SKILL_PREFIX) ||
      metadata.bundledNames.has(descriptor.skillName) ||
      metadata.hubNames.has(descriptor.skillName) ||
      metadata.hubPaths.has(descriptor.directoryRelativePath)
    ) {
      return false;
    }
    const record = metadata.usage[descriptor.skillName];
    if (!exactRecord(record)) return false;
    if (record.created_by !== "agent" && record.agent_created !== true) {
      return false;
    }
    if (
      record.state === "archived" ||
      (typeof record.archived_at === "string" && record.archived_at.length > 0)
    ) {
      return false;
    }
    const origin =
      typeof record.source === "string" ? record.source.toLowerCase() : "";
    return !["bundled", "hub", "external", "projected", "agentera"].includes(
      origin,
    );
  }

  private readBundle(
    root: ResolvedSourceRoot,
    descriptor: SkillDescriptor,
  ): ExperienceCandidateBundleV1 {
    const directoryRoot = this.io.realpath(descriptor.directoryPath);
    if (!contained(root.skillsRoot, directoryRoot)) return ineligible();
    const assets: ExperienceCandidateBundleV1["assets"] = [];
    const visitedDirectories = new Set<string>();
    let totalBytes = 0;
    let entries = 0;

    const visit = (directoryPath: string, segments: string[]): void => {
      const directoryStat = this.io.lstat(directoryPath);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        return ineligible();
      }
      const realDirectory = this.io.realpath(directoryPath);
      if (
        !contained(directoryRoot, realDirectory) ||
        visitedDirectories.has(realDirectory)
      ) {
        return ineligible();
      }
      visitedDirectories.add(realDirectory);
      for (const name of [...this.io.readdir(directoryPath)].sort()) {
        entries += 1;
        if (
          entries > MAX_DISCOVERY_ENTRIES ||
          !safeEntryName(name) ||
          forbiddenEntry(name)
        ) {
          return ineligible();
        }
        const path = join(directoryPath, name);
        const stat = this.io.lstat(path);
        if (stat.isSymbolicLink()) return ineligible();
        const realPath = this.io.realpath(path);
        if (!contained(directoryRoot, realPath)) return ineligible();
        if (stat.isDirectory()) {
          visit(path, [...segments, name]);
          continue;
        }
        if (
          !stat.isFile() ||
          stat.size < 0 ||
          stat.size > MAX_EXPERIENCE_CANDIDATE_FILE_BYTES ||
          assets.length >= MAX_EXPERIENCE_CANDIDATE_FILES
        ) {
          return ineligible();
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_EXPERIENCE_CANDIDATE_BYTES) return ineligible();
        const bytes = this.io.readFile(path);
        if (bytes.length !== stat.size) return ineligible();
        const after = this.io.lstat(path);
        if (
          !after.isFile() ||
          after.isSymbolicLink() ||
          after.size !== stat.size ||
          this.io.realpath(path) !== realPath
        ) {
          return ineligible();
        }
        const relativeAssetPath = [...segments, name].join("/");
        assets.push({
          path: `skills/${descriptor.skillName}/${relativeAssetPath}`,
          mediaType: name.toLowerCase().endsWith(".md")
            ? "text/markdown"
            : "text/plain",
          content: decodeUtf8(bytes),
        });
      }
    };
    visit(descriptor.directoryPath, []);
    try {
      return canonicalizeExperienceCandidate({
        schemaVersion: 1,
        skillName: descriptor.skillName,
        assets,
      }).bundle;
    } catch {
      return ineligible();
    }
  }
}
