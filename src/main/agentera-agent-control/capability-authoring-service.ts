import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type {
  AgentDraftAssetInput,
  AgentMcpRequirementV3,
  AuthoringCapabilitySummary,
  AuthoringInstalledSkillSummary,
  AuthoringMcpServerSummary,
  ConfirmInstalledSkillSnapshotInput,
  ConfirmMcpRequirementInput,
  ExperienceCandidateFinding,
  McpRequirementPreview,
  PrepareInstalledSkillSnapshotInput,
  PrepareMcpRequirementInput,
  SkillSnapshotPreview,
} from "../../shared/agentera-agent-control";
import type { InstalledSkill } from "../skills";
import {
  normalizeMcpDiscoveredTools,
  type McpDiscoveredTool,
  type McpServerInfo,
} from "../mcp-servers";
import {
  canonicalizeExperienceCandidate,
  MAX_EXPERIENCE_CANDIDATE_BYTES,
  MAX_EXPERIENCE_CANDIDATE_FILES,
  MAX_EXPERIENCE_CANDIDATE_FILE_BYTES,
  scanExperienceCandidate,
} from "./experience-candidate-contract";
import { canonicalizeEditableAgent } from "./manifest";

const HANDLE_TTL_MS = 10 * 60 * 1000;
const MAX_DISCOVERY_ENTRIES = 4096;
const FORBIDDEN_ENTRY_NAMES = new Set([
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
  ".git",
  ".github",
  ".cache",
]);

export type CapabilityAuthoringServiceErrorCode =
  | "invalid_request"
  | "capability_profile_unavailable"
  | "capability_source_unsafe"
  | "capability_dlp_blocked"
  | "capability_handle_invalid"
  | "capability_handle_expired"
  | "capability_requirement_invalid";

export class CapabilityAuthoringServiceError extends Error {
  readonly code: CapabilityAuthoringServiceErrorCode;
  readonly findings: readonly ExperienceCandidateFinding[];

  constructor(
    code: CapabilityAuthoringServiceErrorCode,
    findings: readonly ExperienceCandidateFinding[] = [],
  ) {
    super(`Agent capability authoring failed: ${code}.`);
    this.name = "CapabilityAuthoringServiceError";
    this.code = code;
    this.findings = findings.map((finding) => ({ ...finding }));
  }
}

export interface CapabilityAuthoringProfile {
  profileHandle: string;
  displayName: string;
  profilePath: string;
}

export interface CapabilityAuthoringServiceOptions {
  getOwnerKey: () => string;
  resolveProfile: (
    profileHandle: string,
  ) => Promise<CapabilityAuthoringProfile>;
  listInstalledSkills: (profileHandle: string) => InstalledSkill[];
  listMcpServers: (profileHandle: string) => Promise<McpServerInfo[]>;
  discoverMcpTools: (
    logicalName: string,
    profileHandle: string,
  ) => Promise<McpDiscoveredTool[]>;
  now?: () => Date;
  randomUUID?: () => string;
}

interface ActiveInventory {
  ownerKey: string;
  profile: CapabilityAuthoringProfile;
  skills: Array<InstalledSkill & { public: AuthoringInstalledSkillSummary }>;
  mcpServers: Array<{
    public: AuthoringMcpServerSummary;
  }>;
}

interface PreparedSkill {
  ownerKey: string;
  profileHandle: string;
  expiresAt: number;
  preview: Omit<SkillSnapshotPreview, "snapshotHandle">;
  assets: AgentDraftAssetInput[];
}

interface PreparedRequirement {
  ownerKey: string;
  profileHandle: string;
  expiresAt: number;
  preview: Omit<McpRequirementPreview, "requirementHandle">;
  requirement: AgentMcpRequirementV3;
}

interface FileIO {
  lstat(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
  };
  realpath(path: string): string;
  readdir(path: string): string[];
  readFile(path: string): Buffer;
}

const nodeIO: FileIO = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path),
};

function serviceError(
  code: CapabilityAuthoringServiceErrorCode,
  findings: readonly ExperienceCandidateFinding[] = [],
): never {
  throw new CapabilityAuthoringServiceError(code, findings);
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safeDisplayText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex -- Display metadata must strip the complete ASCII control range.
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return Array.from(normalized).slice(0, maximum).join("");
}

function sensitiveDisplayText(value: string): boolean {
  if (value.includes("://")) return true;
  try {
    const canonical = canonicalizeExperienceCandidate({
      schemaVersion: 1,
      skillName: "display-metadata",
      assets: [
        {
          path: "skills/display-metadata/SKILL.md",
          mediaType: "text/markdown",
          content: "# Display metadata\n",
        },
        {
          path: "skills/display-metadata/value.txt",
          mediaType: "text/plain",
          content: value,
        },
      ],
    });
    return scanExperienceCandidate(canonical).length > 0;
  } catch {
    return true;
  }
}

function safeMetadata(value: unknown, maximum: number): string {
  const text = safeDisplayText(value, maximum);
  return text && !sensitiveDisplayText(text) ? text : "";
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

function validProfileHandle(value: unknown): value is string {
  return (
    value === "default" ||
    (typeof value === "string" && /^[a-z0-9_][a-z0-9_-]{0,63}$/.test(value))
  );
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function safeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !FORBIDDEN_ENTRY_NAMES.has(name.toLowerCase())
  );
}

function decodeUtf8(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return serviceError("capability_source_unsafe");
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code === 0 ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    ) {
      return serviceError("capability_source_unsafe");
    }
  }
  return text;
}

function normalizedSkillName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 100)
    .replace(/[-_]+$/g, "");
  if (/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/.test(normalized)) {
    return normalized;
  }
  return `installed-skill-${createHash("sha256")
    .update(name, "utf8")
    .digest("hex")
    .slice(0, 12)}`;
}

export class CapabilityAuthoringService {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly io: FileIO;
  private active: ActiveInventory | null = null;
  private readonly skills = new Map<string, PreparedSkill>();
  private readonly requirements = new Map<string, PreparedRequirement>();

  constructor(
    private readonly options: CapabilityAuthoringServiceOptions,
    io: FileIO = nodeIO,
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.io = io;
  }

  invalidate(): void {
    this.active = null;
    this.skills.clear();
    this.requirements.clear();
  }

  notifyContextChanged(): void {
    if (this.active?.ownerKey !== this.ownerKey()) {
      this.invalidate();
    }
  }

  async listAuthoringCapabilities(
    profileId: string,
  ): Promise<AuthoringCapabilitySummary> {
    if (!validProfileHandle(profileId)) return serviceError("invalid_request");
    const ownerKey = this.ownerKey();
    let profile: CapabilityAuthoringProfile;
    let installed: InstalledSkill[];
    let servers: McpServerInfo[];
    try {
      profile = await this.options.resolveProfile(profileId);
      if (
        profile.profileHandle !== profileId ||
        !isAbsolute(profile.profilePath) ||
        !safeDisplayText(profile.displayName, 80) ||
        !this.profileRootIsSafe(profile.profilePath)
      ) {
        return serviceError("capability_profile_unavailable");
      }
      installed = this.options.listInstalledSkills(profileId);
      servers = await this.options.listMcpServers(profileId);
    } catch (error) {
      if (error instanceof CapabilityAuthoringServiceError) throw error;
      return serviceError("capability_profile_unavailable");
    }
    if (this.ownerKey() !== ownerKey) {
      return serviceError("capability_profile_unavailable");
    }

    const skills = installed
      .map((skill) => ({
        ...skill,
        public: {
          name: safeMetadata(skill.name, 100),
          category: safeMetadata(skill.category, 100),
          description: safeMetadata(skill.description, 512),
        },
      }))
      .filter(
        (
          skill,
        ): skill is InstalledSkill & {
          public: AuthoringInstalledSkillSummary;
        } =>
          !!skill.public.name &&
          typeof skill.path === "string" &&
          isAbsolute(skill.path) &&
          this.skillRootIsSafe(profile.profilePath, skill.path),
      )
      .sort(
        (left, right) =>
          utf8Compare(left.public.category, right.public.category) ||
          utf8Compare(left.public.name, right.public.name),
      );

    const mcpServers: ActiveInventory["mcpServers"] = [];
    const logicalNames = new Set<string>();
    for (const server of servers) {
      const logicalName = safeMetadata(server.name, 128);
      if (!logicalName || logicalNames.has(logicalName)) {
        return serviceError("capability_source_unsafe");
      }
      logicalNames.add(logicalName);
      let tools = normalizeMcpDiscoveredTools(server.tools);
      if (server.enabled && tools.length === 0) {
        try {
          tools = normalizeMcpDiscoveredTools(
            await this.options.discoverMcpTools(logicalName, profileId),
          );
        } catch {
          tools = [];
        }
      }
      tools = tools.map((tool) => ({
        name: tool.name,
        description: safeMetadata(tool.description, 512),
      }));
      mcpServers.push({
        public: {
          logicalName,
          enabled: server.enabled === true,
          tools,
        },
      });
    }
    mcpServers.sort((left, right) =>
      utf8Compare(left.public.logicalName, right.public.logicalName),
    );

    if (
      this.active !== null &&
      (this.active.ownerKey !== ownerKey ||
        this.active.profile.profileHandle !== profileId)
    ) {
      this.skills.clear();
      this.requirements.clear();
    }
    const displayName = safeMetadata(profile.displayName, 80) || profileId;
    this.active = {
      ownerKey,
      profile: { ...profile, displayName },
      skills,
      mcpServers,
    };
    return {
      profile: { profileHandle: profileId, displayName },
      skills: skills.map((skill) => ({ ...skill.public })),
      mcpServers: mcpServers.map(({ public: server }) => ({
        logicalName: server.logicalName,
        enabled: server.enabled,
        tools: server.tools.map((tool) => ({ ...tool })),
      })),
    };
  }

  prepareInstalledSkillSnapshot(
    input: PrepareInstalledSkillSnapshotInput,
  ): SkillSnapshotPreview {
    if (
      !exactObject(input, ["profileId", "skillName"]) ||
      !validProfileHandle(input.profileId) ||
      typeof input.skillName !== "string"
    ) {
      return serviceError("invalid_request");
    }
    const active = this.requireActive(input.profileId);
    const matches = active.skills.filter(
      (skill) => skill.public.name === input.skillName,
    );
    if (matches.length !== 1) return serviceError("capability_source_unsafe");
    const selected = matches[0];
    const canonical = this.readSkillSnapshot(
      active.profile.profilePath,
      selected.path,
      selected.public.name,
    );
    const findings = scanExperienceCandidate(canonical);
    if (findings.length > 0) {
      return serviceError("capability_dlp_blocked", findings);
    }
    const expiresAt = this.now().getTime() + HANDLE_TTL_MS;
    const files = canonical.bundle.assets.map((asset) => ({
      draftLocation: asset.path,
      mediaType: asset.mediaType,
      sizeBytes: Buffer.byteLength(asset.content, "utf8"),
      sha256: createHash("sha256").update(asset.content, "utf8").digest("hex"),
    }));
    const preview: Omit<SkillSnapshotPreview, "snapshotHandle"> = {
      profileHandle: input.profileId,
      skillName: canonical.bundle.skillName,
      category: selected.public.category,
      description: selected.public.description,
      files,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      contentDigest: canonical.contentDigest,
      findings: [],
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const snapshotHandle = this.randomUUID();
    this.skills.set(snapshotHandle, {
      ownerKey: active.ownerKey,
      profileHandle: input.profileId,
      expiresAt,
      preview,
      assets: canonical.bundle.assets.map((asset) => ({
        path: asset.path,
        content: asset.content,
      })),
    });
    return { snapshotHandle, ...preview };
  }

  confirmInstalledSkillSnapshot(
    input: ConfirmInstalledSkillSnapshotInput,
  ): AgentDraftAssetInput[] {
    if (
      !exactObject(input, ["snapshotHandle", "confirmation"]) ||
      typeof input.snapshotHandle !== "string" ||
      input.confirmation !== "copy-selected-skill-to-draft"
    ) {
      return serviceError("invalid_request");
    }
    const prepared = this.skills.get(input.snapshotHandle);
    this.skills.delete(input.snapshotHandle);
    if (!prepared || !this.preparedIsCurrent(prepared)) {
      return serviceError("capability_handle_invalid");
    }
    if (this.now().getTime() > prepared.expiresAt) {
      return serviceError("capability_handle_expired");
    }
    return prepared.assets.map((asset) => ({ ...asset }));
  }

  prepareMcpRequirement(
    input: PrepareMcpRequirementInput,
  ): McpRequirementPreview {
    if (
      !exactObject(input, [
        "profileId",
        "logicalName",
        "tools",
        "required",
        "permissionReason",
      ]) ||
      !validProfileHandle(input.profileId) ||
      typeof input.logicalName !== "string" ||
      !Array.isArray(input.tools) ||
      !input.tools.every((tool) => typeof tool === "string") ||
      typeof input.required !== "boolean" ||
      typeof input.permissionReason !== "string"
    ) {
      return serviceError("invalid_request");
    }
    const active = this.requireActive(input.profileId);
    const server = active.mcpServers.find(
      ({ public: candidate }) => candidate.logicalName === input.logicalName,
    )?.public;
    if (!server || !server.enabled) {
      return serviceError("capability_requirement_invalid");
    }
    const selectedTools = [...input.tools].sort(utf8Compare);
    const available = new Map(server.tools.map((tool) => [tool.name, tool]));
    if (
      selectedTools.length === 0 ||
      new Set(selectedTools).size !== selectedTools.length ||
      selectedTools.some((tool) => tool !== tool.trim() || !available.has(tool))
    ) {
      return serviceError("capability_requirement_invalid");
    }
    let requirement: AgentMcpRequirementV3;
    try {
      const canonical = canonicalizeEditableAgent(
        {
          schemaVersion: 3,
          identity: { systemPrompt: "Use selected installed capabilities." },
          assets: [],
          modelPolicy: {
            mode: "user_select",
            allowedProviders: [],
            allowedModels: [],
          },
          mcpRequirements: [
            {
              logicalName: input.logicalName,
              tools: selectedTools,
              required: input.required,
              permissionReason: input.permissionReason,
            },
          ],
          tools: { allowed: selectedTools, denied: [] },
          dependencies: [],
          runtimeCompatibility: {
            minimumVersion: "v0.18.2-agentera.1",
            maximumVersionExclusive: null,
          },
        },
        [],
      );
      if (canonical.normalizedManifest.schemaVersion !== 3) {
        return serviceError("capability_requirement_invalid");
      }
      requirement = {
        ...canonical.normalizedManifest.mcpRequirements[0],
        tools: [...canonical.normalizedManifest.mcpRequirements[0].tools],
      };
    } catch {
      return serviceError("capability_requirement_invalid");
    }
    const expiresAt = this.now().getTime() + HANDLE_TTL_MS;
    const preview: Omit<McpRequirementPreview, "requirementHandle"> = {
      profileHandle: input.profileId,
      logicalName: requirement.logicalName,
      tools: requirement.tools.map((name) => ({ ...available.get(name)! })),
      required: requirement.required,
      permissionReason: requirement.permissionReason,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const requirementHandle = this.randomUUID();
    this.requirements.set(requirementHandle, {
      ownerKey: active.ownerKey,
      profileHandle: input.profileId,
      expiresAt,
      preview,
      requirement,
    });
    return { requirementHandle, ...preview };
  }

  confirmMcpRequirement(
    input: ConfirmMcpRequirementInput,
  ): AgentMcpRequirementV3 {
    if (
      !exactObject(input, ["requirementHandle", "confirmation"]) ||
      typeof input.requirementHandle !== "string" ||
      input.confirmation !== "add-logical-mcp-requirement"
    ) {
      return serviceError("invalid_request");
    }
    const prepared = this.requirements.get(input.requirementHandle);
    this.requirements.delete(input.requirementHandle);
    if (!prepared || !this.preparedIsCurrent(prepared)) {
      return serviceError("capability_handle_invalid");
    }
    if (this.now().getTime() > prepared.expiresAt) {
      return serviceError("capability_handle_expired");
    }
    return { ...prepared.requirement, tools: [...prepared.requirement.tools] };
  }

  private ownerKey(): string {
    const ownerKey = this.options.getOwnerKey();
    if (typeof ownerKey !== "string" || !ownerKey) {
      return serviceError("invalid_request");
    }
    return ownerKey;
  }

  private requireActive(profileId: string): ActiveInventory {
    const active = this.active;
    if (
      !active ||
      active.profile.profileHandle !== profileId ||
      active.ownerKey !== this.ownerKey()
    ) {
      return serviceError("capability_profile_unavailable");
    }
    return active;
  }

  private preparedIsCurrent(prepared: {
    ownerKey: string;
    profileHandle: string;
  }): boolean {
    return (
      prepared.ownerKey === this.ownerKey() &&
      this.active?.ownerKey === prepared.ownerKey &&
      this.active.profile.profileHandle === prepared.profileHandle
    );
  }

  private readSkillSnapshot(
    profilePath: string,
    skillPath: string,
    displayName: string,
  ): ReturnType<typeof canonicalizeExperienceCandidate> {
    try {
      const profileStat = this.io.lstat(profilePath);
      if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
        return serviceError("capability_source_unsafe");
      }
      const profileRoot = this.io.realpath(profilePath);
      const skillsPath = join(profilePath, "skills");
      const skillsStat = this.io.lstat(skillsPath);
      if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
        return serviceError("capability_source_unsafe");
      }
      const skillsRoot = this.io.realpath(skillsPath);
      if (!contained(profileRoot, skillsRoot)) {
        return serviceError("capability_source_unsafe");
      }
      const skillStat = this.io.lstat(skillPath);
      if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) {
        return serviceError("capability_source_unsafe");
      }
      const skillRoot = this.io.realpath(skillPath);
      if (!contained(skillsRoot, skillRoot)) {
        return serviceError("capability_source_unsafe");
      }
      const sourceRelative = relative(skillsRoot, skillRoot);
      let chain = skillsRoot;
      for (const segment of sourceRelative.split(/[\\/]+/)) {
        if (!safeEntryName(segment)) {
          return serviceError("capability_source_unsafe");
        }
        chain = join(chain, segment);
        if (this.io.lstat(chain).isSymbolicLink()) {
          return serviceError("capability_source_unsafe");
        }
      }

      const skillName = normalizedSkillName(displayName);
      const assets: Array<{
        path: string;
        mediaType: "text/markdown" | "text/plain";
        content: string;
      }> = [];
      const draftPaths = new Set<string>();
      const visited = new Set<string>();
      let totalBytes = 0;
      let entries = 0;
      const visit = (directory: string, segments: string[]): void => {
        const realDirectory = this.io.realpath(directory);
        if (
          !contained(skillRoot, realDirectory) ||
          visited.has(realDirectory)
        ) {
          return serviceError("capability_source_unsafe");
        }
        visited.add(realDirectory);
        for (const name of [...this.io.readdir(directory)].sort(utf8Compare)) {
          entries += 1;
          if (entries > MAX_DISCOVERY_ENTRIES || !safeEntryName(name)) {
            return serviceError("capability_source_unsafe");
          }
          const source = join(directory, name);
          const stat = this.io.lstat(source);
          if (stat.isSymbolicLink()) {
            return serviceError("capability_source_unsafe");
          }
          const realSource = this.io.realpath(source);
          if (!contained(skillRoot, realSource)) {
            return serviceError("capability_source_unsafe");
          }
          const normalizedName = name.normalize("NFC");
          if (stat.isDirectory()) {
            const nestedEntries = this.io.readdir(source);
            if (nestedEntries.includes("SKILL.md")) {
              const nestedSkillStat = this.io.lstat(join(source, "SKILL.md"));
              if (
                nestedSkillStat.isFile() &&
                !nestedSkillStat.isSymbolicLink()
              ) {
                continue;
              }
            }
            visit(source, [...segments, normalizedName]);
            continue;
          }
          if (
            !stat.isFile() ||
            stat.size < 0 ||
            stat.size > MAX_EXPERIENCE_CANDIDATE_FILE_BYTES ||
            assets.length >= MAX_EXPERIENCE_CANDIDATE_FILES
          ) {
            return serviceError("capability_source_unsafe");
          }
          const bytes = this.io.readFile(source);
          if (bytes.length !== stat.size) {
            return serviceError("capability_source_unsafe");
          }
          totalBytes += bytes.length;
          if (totalBytes > MAX_EXPERIENCE_CANDIDATE_BYTES) {
            return serviceError("capability_source_unsafe");
          }
          const relativeSegments = [...segments, normalizedName];
          const draftPath = `skills/${skillName}/${relativeSegments.join("/")}`;
          if (draftPaths.has(draftPath)) {
            return serviceError("capability_source_unsafe");
          }
          draftPaths.add(draftPath);
          assets.push({
            path: draftPath,
            mediaType: normalizedName.toLowerCase().endsWith(".md")
              ? "text/markdown"
              : "text/plain",
            content: decodeUtf8(bytes),
          });
        }
      };
      visit(skillPath, []);
      if (!draftPaths.has(`skills/${skillName}/SKILL.md`)) {
        return serviceError("capability_source_unsafe");
      }
      return canonicalizeExperienceCandidate({
        schemaVersion: 1,
        skillName,
        assets,
      });
    } catch (error) {
      if (error instanceof CapabilityAuthoringServiceError) throw error;
      return serviceError("capability_source_unsafe");
    }
  }

  private profileRootIsSafe(profilePath: string): boolean {
    try {
      const profileStat = this.io.lstat(profilePath);
      if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
        return false;
      }
      const profileRoot = this.io.realpath(profilePath);
      const skillsPath = join(profilePath, "skills");
      const skillsStat = this.io.lstat(skillsPath);
      return (
        skillsStat.isDirectory() &&
        !skillsStat.isSymbolicLink() &&
        contained(profileRoot, this.io.realpath(skillsPath))
      );
    } catch {
      return false;
    }
  }

  private skillRootIsSafe(profilePath: string, skillPath: string): boolean {
    try {
      if (!this.profileRootIsSafe(profilePath)) return false;
      const skillsRoot = this.io.realpath(join(profilePath, "skills"));
      const stat = this.io.lstat(skillPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const skillRoot = this.io.realpath(skillPath);
      if (!contained(skillsRoot, skillRoot)) return false;
      let chain = skillsRoot;
      for (const segment of relative(skillsRoot, skillRoot).split(/[\\/]+/)) {
        if (!safeEntryName(segment)) return false;
        chain = join(chain, segment);
        if (this.io.lstat(chain).isSymbolicLink()) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
