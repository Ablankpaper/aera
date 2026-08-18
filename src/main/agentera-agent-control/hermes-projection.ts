import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { AgentVersion } from "./client";
import { resolveAgenteraControlPlanePaths } from "./db";
import { normalizeAgentAssetPath } from "./manifest";
import { canonicalizeAgentVersionContent } from "./trust";
import { safeWriteFile } from "../utils";
import { currentModelConfigurationWritePermit } from "../model-configuration-managed-files";
import {
  requireManagedModelMutationValue,
  type ManagedModelMutationPort,
} from "../model-configuration-mutation-port";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type HermesProjectionErrorCode =
  | "invalid_projection"
  | "projection_conflict"
  | "unsafe_external_dirs"
  | "profile_invalid";

export class HermesProjectionError extends Error {
  readonly code: HermesProjectionErrorCode;

  constructor(code: HermesProjectionErrorCode) {
    super(`Aera Runtime projection failed: ${code}.`);
    this.name = "HermesProjectionError";
    this.code = code;
  }
}

export interface HermesProjectionSkill {
  originalName: string;
  scopedName: string;
}

export interface HermesVersionProjection {
  agentInstallationId: string;
  definitionId: string;
  versionId: string;
  versionNumber: number;
  contentDigest: string;
  versionRoot: string;
  externalSkillsDirectory: string;
  skills: readonly HermesProjectionSkill[];
}

export interface HermesProjectionDiagnostic extends HermesProjectionSkill {
  origin: "published" | "local_override";
}

export interface ActivatedHermesProjection {
  externalSkillsDirectory: string;
  diagnostics: readonly HermesProjectionDiagnostic[];
}

export interface HermesProjectionManagerOptions {
  userDataPath: string;
  randomUUID?: () => string;
  rename?: (source: string, destination: string) => void;
  writeConfig?: (path: string, content: string) => void;
  modelMutationPort?: ManagedModelMutationPort;
}

let configuredModelMutationPort: ManagedModelMutationPort | null = null;

export function configureHermesProjectionMutationPort(
  modelMutationPort: ManagedModelMutationPort | null,
): void {
  configuredModelMutationPort = modelMutationPort;
}

interface ProjectionFile {
  relativePath: string;
  bytes: Buffer;
}

function contained(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new HermesProjectionError("invalid_projection");
  }
  return value.toLowerCase();
}

function validVersionNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function skillSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (!normalized) throw new HermesProjectionError("invalid_projection");
  return normalized;
}

function frontmatterSkillName(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(
    content.slice(0, 64 * 1024),
  );
  if (!match) return null;
  const names = match[1]
    .split(/\r?\n/)
    .map((line) => /^name\s*:\s*(.*?)\s*$/.exec(line))
    .filter((candidate): candidate is RegExpExecArray => candidate !== null);
  if (names.length !== 1 || unsafeYamlToken(names[0][1])) return null;
  const parsed = scalarValue(names[0][1]);
  if (parsed === null) return null;
  try {
    return skillSlug(parsed);
  } catch {
    return null;
  }
}

function originalSkillName(assetPath: string, content: string): string {
  const declared = frontmatterSkillName(content);
  if (declared !== null) return declared;
  const segments = assetPath.split("/");
  const skillsIndex = segments.lastIndexOf("skills");
  if (
    skillsIndex >= 0 &&
    skillsIndex + 1 < segments.length &&
    segments.at(-1)?.toLowerCase() === "skill.md"
  ) {
    return skillSlug(segments[skillsIndex + 1]);
  }
  const file = basename(assetPath, extname(assetPath));
  return skillSlug(file === "SKILL" ? basename(dirname(assetPath)) : file);
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return content;
  }
  const match = /^---\r?\n[\s\S]*?\r?\n---\s*\r?\n/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function wrapperBytes(
  scopedName: string,
  originalName: string,
  contentDigest: string,
  originalContent: string,
): Buffer {
  const body = stripFrontmatter(originalContent).replace(/^\s+/, "");
  return Buffer.from(
    [
      "---",
      `name: ${scopedName}`,
      `description: Published Aera skill ${originalName}`,
      "metadata:",
      "  agentera:",
      `    original_name: ${originalName}`,
      `    source_digest: ${contentDigest}`,
      "---",
      "",
      body,
    ].join("\n"),
    "utf8",
  );
}

function writeAndSync(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not permit directory fsync.
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function makeReadOnly(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new HermesProjectionError("projection_conflict");
  }
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) makeReadOnly(join(path, name));
    chmodSync(path, 0o500);
  } else if (stats.isFile()) {
    chmodSync(path, 0o400);
  } else {
    throw new HermesProjectionError("projection_conflict");
  }
}

function removeGeneratedTree(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    rmSync(path, { force: true });
    return;
  }
  if (!stats.isDirectory()) {
    chmodSync(path, 0o600);
    rmSync(path, { force: true });
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeGeneratedTree(join(path, name));
  rmSync(path, { recursive: true, force: true });
}

function copyProjectionTree(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) {
    throw new HermesProjectionError("projection_conflict");
  }
  if (stats.isDirectory()) {
    if (process.platform !== "win32" && (stats.mode & 0o222) !== 0) {
      throw new HermesProjectionError("projection_conflict");
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source).sort()) {
      copyProjectionTree(join(source, name), join(destination, name));
    }
    return;
  }
  if (
    !stats.isFile() ||
    (process.platform !== "win32" && (stats.mode & 0o222) !== 0)
  ) {
    throw new HermesProjectionError("projection_conflict");
  }
  writeAndSync(destination, readFileSync(source));
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new HermesProjectionError("projection_conflict");
    }
    if (process.platform !== "win32" && (stats.mode & 0o222) !== 0) {
      throw new HermesProjectionError("projection_conflict");
    }
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const child = lstatSync(path);
      if (child.isDirectory()) visit(path);
      else if (child.isFile() && !child.isSymbolicLink()) {
        if (process.platform !== "win32" && (child.mode & 0o222) !== 0) {
          throw new HermesProjectionError("projection_conflict");
        }
        files.push(relative(root, path));
      } else {
        throw new HermesProjectionError("projection_conflict");
      }
    }
  };
  visit(root);
  return files;
}

function verifyExistingTree(
  root: string,
  expected: readonly ProjectionFile[],
): void {
  const paths = expected.map((file) => file.relativePath).sort();
  if (collectFiles(root).sort().join("\0") !== paths.join("\0")) {
    throw new HermesProjectionError("projection_conflict");
  }
  for (const file of expected) {
    const path = join(root, file.relativePath);
    if (!contained(root, path) || !readFileSync(path).equals(file.bytes)) {
      throw new HermesProjectionError("projection_conflict");
    }
  }
}

function scalarValue(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  const comment = value.search(/\s+#/);
  return (comment < 0 ? value : value.slice(0, comment)).trim() || null;
}

function unsafeYamlToken(value: string): boolean {
  return /^(?:[&*!]|<<\s*:)/.test(value.trim());
}

function patchExternalSkillsDirectory(
  source: string,
  externalDirectory: string,
): string {
  if (/\0|\r(?!\n)/.test(source) || /[\r\n\0]/.test(externalDirectory)) {
    throw new HermesProjectionError("unsafe_external_dirs");
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const topLevelSkills = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^skills\s*:/.test(line));
  if (topLevelSkills.length > 1) {
    throw new HermesProjectionError("unsafe_external_dirs");
  }

  const quoted = JSON.stringify(externalDirectory);
  if (topLevelSkills.length === 0) {
    const prefix =
      source.length > 0 && !source.endsWith(newline) ? newline : "";
    return `${source}${prefix}skills:${newline}  external_dirs:${newline}    - ${quoted}${newline}`;
  }
  const skillsLine = topLevelSkills[0];
  if (!/^skills:\s*(?:#.*)?$/.test(skillsLine.line)) {
    throw new HermesProjectionError("unsafe_external_dirs");
  }
  let blockEnd = lines.length;
  for (let index = skillsLine.index + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      blockEnd = index;
      break;
    }
  }
  const fields: Array<{ index: number; indent: string; suffix: string }> = [];
  for (let index = skillsLine.index + 1; index < blockEnd; index += 1) {
    if (/^\s*<<\s*:/.test(lines[index])) {
      throw new HermesProjectionError("unsafe_external_dirs");
    }
    const match = /^(\s+)external_dirs\s*:(.*)$/.exec(lines[index]);
    if (match) fields.push({ index, indent: match[1], suffix: match[2] });
    else if (
      /external_dirs\s*:/.test(lines[index]) &&
      !/^\s*#/.test(lines[index])
    ) {
      throw new HermesProjectionError("unsafe_external_dirs");
    }
  }
  if (fields.length > 1) {
    throw new HermesProjectionError("unsafe_external_dirs");
  }
  if (fields.length === 0) {
    lines.splice(blockEnd, 0, "  external_dirs:", `    - ${quoted}`);
    return lines.join(newline);
  }

  const field = fields[0];
  if (field.indent.includes("\t") || unsafeYamlToken(field.suffix)) {
    throw new HermesProjectionError("unsafe_external_dirs");
  }
  const fieldIndent = field.indent.length;
  const suffix = field.suffix.trim();
  let fieldEnd = blockEnd;
  for (let index = field.index + 1; index < blockEnd; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indentation = /^\s*/.exec(line)?.[0] ?? "";
    if (indentation.includes("\t")) {
      throw new HermesProjectionError("unsafe_external_dirs");
    }
    if (indentation.length <= fieldIndent) {
      fieldEnd = index;
      break;
    }
  }

  const existing: string[] = [];
  let scalarFromSuffix: string | null = null;
  if (suffix !== "" && !suffix.startsWith("#")) {
    if (suffix === "[]" || suffix.startsWith("[] #")) {
      lines[field.index] = `${field.indent}external_dirs:${
        suffix.slice(2).trim() ? ` ${suffix.slice(2).trim()}` : ""
      }`;
    } else {
      if (unsafeYamlToken(suffix)) {
        throw new HermesProjectionError("unsafe_external_dirs");
      }
      const parsed = scalarValue(suffix);
      if (parsed === null) {
        throw new HermesProjectionError("unsafe_external_dirs");
      }
      scalarFromSuffix = parsed;
      existing.push(parsed);
      lines[field.index] = `${field.indent}external_dirs:`;
    }
  }

  for (let index = field.index + 1; index < fieldEnd; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (!item || unsafeYamlToken(item[1])) {
      throw new HermesProjectionError("unsafe_external_dirs");
    }
    const parsed = scalarValue(item[1]);
    if (parsed === null) {
      throw new HermesProjectionError("unsafe_external_dirs");
    }
    existing.push(parsed);
  }
  if (existing.includes(externalDirectory)) return source;
  const targetLine = `${field.indent}  - ${quoted}`;
  if (scalarFromSuffix !== null) {
    lines.splice(
      field.index + 1,
      0,
      `${field.indent}  - ${JSON.stringify(scalarFromSuffix)}`,
      targetLine,
    );
  } else {
    lines.splice(fieldEnd, 0, targetLine);
  }
  return lines.join(newline);
}

function localSkillNames(profilePath: string): Set<string> {
  const skillsRoot = join(profilePath, "skills");
  if (!existsSync(skillsRoot)) return new Set();
  const rootStats = lstatSync(skillsRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new HermesProjectionError("profile_invalid");
  }
  const names = new Set<string>();
  const excluded = new Set([
    ".git",
    ".github",
    ".archive",
    "node_modules",
    "__pycache__",
  ]);
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (excluded.has(name)) continue;
      const candidate = join(directory, name);
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        try {
          names.add(skillSlug(name));
        } catch {
          // A name outside the published slug vocabulary cannot collide.
        }
        continue;
      }
      if (!stats.isDirectory()) continue;
      const skillFile = join(candidate, "SKILL.md");
      if (existsSync(skillFile)) {
        try {
          names.add(skillSlug(name));
        } catch {
          // The frontmatter name below may still be usable.
        }
        const skillStats = lstatSync(skillFile);
        if (
          !skillStats.isSymbolicLink() &&
          skillStats.isFile() &&
          skillStats.size <= 64 * 1024
        ) {
          const declared = frontmatterSkillName(
            readFileSync(skillFile, "utf8"),
          );
          if (declared !== null) names.add(declared);
        }
      }
      visit(candidate);
    }
  };
  visit(skillsRoot);
  return names;
}

export class HermesProjectionManager {
  private readonly projectionsRoot: string;
  private readonly randomUUID: () => string;
  private readonly rename: (source: string, destination: string) => void;
  private readonly writeConfig: (path: string, content: string) => void;
  private readonly modelMutationPort: ManagedModelMutationPort | null;

  constructor(options: HermesProjectionManagerOptions) {
    this.projectionsRoot = resolveAgenteraControlPlanePaths(
      options.userDataPath,
    ).projectionsPath;
    mkdirSync(this.projectionsRoot, { recursive: true, mode: 0o700 });
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.rename = options.rename ?? renameSync;
    this.writeConfig = options.writeConfig ?? safeWriteFile;
    this.modelMutationPort = options.modelMutationPort ?? null;
  }

  materializeVersion(input: {
    agentInstallationId: string;
    version: AgentVersion;
  }): HermesVersionProjection {
    const agentInstallationId = requireUuid(input.agentInstallationId);
    const definitionId = requireUuid(input.version.definition_id);
    const versionId = requireUuid(input.version.id);
    if (
      !validVersionNumber(input.version.version_number) ||
      !DIGEST_PATTERN.test(input.version.content_digest)
    ) {
      throw new HermesProjectionError("invalid_projection");
    }
    let canonical;
    try {
      canonical = canonicalizeAgentVersionContent(input.version);
    } catch {
      throw new HermesProjectionError("invalid_projection");
    }
    if (canonical.contentDigest !== input.version.content_digest) {
      throw new HermesProjectionError("invalid_projection");
    }
    const bundle = new Map(
      input.version.bundle.assets.map((asset) => [asset.path, asset.content]),
    );
    const skills: HermesProjectionSkill[] = [];
    const expected: ProjectionFile[] = [];
    const scopedNames = new Set<string>();
    const definitionPrefix = definitionId.slice(0, 8);
    const skillAssets: Array<{ path: string; content: string }> = [];
    for (const asset of input.version.manifest.assets) {
      let path: string;
      try {
        path = normalizeAgentAssetPath(asset.path);
      } catch {
        throw new HermesProjectionError("invalid_projection");
      }
      const content = bundle.get(path);
      if (content === undefined) {
        throw new HermesProjectionError("invalid_projection");
      }
      expected.push({
        relativePath: join("assets", ...path.split("/")),
        bytes: Buffer.from(content, "utf8"),
      });
      if (asset.kind === "skill") skillAssets.push({ path, content });
    }

    const skillDescriptors = skillAssets
      .filter(({ path }) => path.split("/").at(-1) === "SKILL.md")
      .map(({ path, content }) => ({
        path,
        root: path.split("/").slice(0, -1).join("/"),
        content,
      }));
    if (skillAssets.length > 0 && skillDescriptors.length === 0) {
      throw new HermesProjectionError("invalid_projection");
    }
    const descriptorByRoot = new Map<
      string,
      { scopedName: string; originalName: string }
    >();
    for (const descriptor of skillDescriptors) {
      if (
        descriptor.root.length === 0 ||
        !descriptor.root.startsWith("skills/") ||
        descriptorByRoot.has(descriptor.root)
      ) {
        throw new HermesProjectionError("invalid_projection");
      }
      const originalName = originalSkillName(
        descriptor.path,
        descriptor.content,
      );
      const scopedName = `agentera.${definitionPrefix}.v${input.version.version_number}.${originalName}`;
      if (scopedNames.has(scopedName)) {
        throw new HermesProjectionError("invalid_projection");
      }
      scopedNames.add(scopedName);
      descriptorByRoot.set(descriptor.root, { originalName, scopedName });
      skills.push({ originalName, scopedName });
      expected.push({
        relativePath: join("skills", scopedName, "SKILL.md"),
        bytes: wrapperBytes(
          scopedName,
          originalName,
          input.version.content_digest,
          descriptor.content,
        ),
      });
    }
    for (const asset of skillAssets) {
      if (asset.path.split("/").at(-1) === "SKILL.md") continue;
      const root = [...descriptorByRoot.keys()]
        .filter((candidate) => asset.path.startsWith(`${candidate}/`))
        .sort((left, right) => right.length - left.length)[0];
      if (root === undefined) {
        throw new HermesProjectionError("invalid_projection");
      }
      const descriptor = descriptorByRoot.get(root);
      if (!descriptor) throw new HermesProjectionError("invalid_projection");
      const supportPath = asset.path.slice(root.length + 1);
      if (supportPath.length === 0 || supportPath === "SKILL.md") {
        throw new HermesProjectionError("invalid_projection");
      }
      expected.push({
        relativePath: join(
          "skills",
          descriptor.scopedName,
          ...supportPath.split("/"),
        ),
        bytes: Buffer.from(asset.content, "utf8"),
      });
    }
    expected.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.relativePath, "utf8"),
        Buffer.from(right.relativePath, "utf8"),
      ),
    );
    skills.sort((left, right) =>
      left.scopedName.localeCompare(right.scopedName),
    );

    const installationRoot = join(this.projectionsRoot, agentInstallationId);
    const versionParent = join(installationRoot, "versions", versionId);
    const versionRoot = join(versionParent, input.version.content_digest);
    const externalSkillsDirectory = join(installationRoot, "active", "skills");
    if (existsSync(versionRoot)) {
      verifyExistingTree(versionRoot, expected);
    } else {
      mkdirSync(versionParent, { recursive: true, mode: 0o700 });
      const stagingId = requireUuid(this.randomUUID());
      const staging = join(versionParent, `.staging-${stagingId}`);
      if (existsSync(staging)) {
        throw new HermesProjectionError("projection_conflict");
      }
      mkdirSync(staging, { mode: 0o700 });
      try {
        for (const file of expected) {
          const destination = join(staging, file.relativePath);
          if (!contained(staging, destination)) {
            throw new HermesProjectionError("invalid_projection");
          }
          writeAndSync(destination, file.bytes);
        }
        fsyncDirectory(staging);
        makeReadOnly(staging);
        verifyExistingTree(staging, expected);
        this.rename(staging, versionRoot);
        fsyncDirectory(versionParent);
      } catch (error) {
        removeGeneratedTree(staging);
        throw error;
      }
    }
    return {
      agentInstallationId,
      definitionId,
      versionId,
      versionNumber: input.version.version_number,
      contentDigest: input.version.content_digest,
      versionRoot,
      externalSkillsDirectory,
      skills,
    };
  }

  async activateForProfile(input: {
    projection: HermesVersionProjection;
    profileId: string;
    profilePath: string;
  }): Promise<ActivatedHermesProjection> {
    const profileId = input.profileId.trim();
    if (!profileId) throw new HermesProjectionError("profile_invalid");
    if (currentModelConfigurationWritePermit()) {
      return this.activateForProfileWithinManagedWrite({
        projection: input.projection,
        profilePath: input.profilePath,
      });
    }
    const modelMutationPort =
      this.modelMutationPort ?? configuredModelMutationPort;
    if (!modelMutationPort) {
      throw Object.assign(
        new Error("model_configuration_mutation_unavailable"),
        { code: "model_configuration_mutation_unavailable" },
      );
    }
    const result = await modelMutationPort.mutate({
      operation: "agent_hermes_projection_activation",
      globalCatalog: false,
      profileIds: [profileId],
      stage: "activation",
      prepare: () => ({
        write: () =>
          this.activateForProfileWithinManagedWrite({
            projection: input.projection,
            profilePath: input.profilePath,
          }),
      }),
    });
    return requireManagedModelMutationValue(result);
  }

  private activateForProfileWithinManagedWrite(input: {
    projection: HermesVersionProjection;
    profilePath: string;
  }): ActivatedHermesProjection {
    if (!isAbsolute(input.profilePath)) {
      throw new HermesProjectionError("profile_invalid");
    }
    let profilePath: string;
    try {
      profilePath = realpathSync.native(input.profilePath);
    } catch {
      throw new HermesProjectionError("profile_invalid");
    }
    if (!statSync(profilePath).isDirectory()) {
      throw new HermesProjectionError("profile_invalid");
    }
    const installationRoot = join(
      this.projectionsRoot,
      requireUuid(input.projection.agentInstallationId),
    );
    const expectedVersionRoot = join(
      installationRoot,
      "versions",
      requireUuid(input.projection.versionId),
      input.projection.contentDigest,
    );
    if (
      input.projection.versionRoot !== expectedVersionRoot ||
      !DIGEST_PATTERN.test(input.projection.contentDigest) ||
      !existsSync(expectedVersionRoot)
    ) {
      throw new HermesProjectionError("invalid_projection");
    }

    const local = localSkillNames(profilePath);
    const diagnostics: HermesProjectionDiagnostic[] =
      input.projection.skills.map((skill) => ({
        ...skill,
        origin: local.has(skill.originalName.normalize("NFKC").toLowerCase())
          ? "local_override"
          : "published",
      }));
    const configPath = join(profilePath, "config.yaml");
    const currentConfig = existsSync(configPath)
      ? readFileSync(configPath, "utf8")
      : "";
    const nextConfig = patchExternalSkillsDirectory(
      currentConfig,
      input.projection.externalSkillsDirectory,
    );

    const stagingId = requireUuid(this.randomUUID());
    const activeRoot = join(installationRoot, "active");
    const staging = join(installationRoot, `.active-staging-${stagingId}`);
    const backup = join(installationRoot, `.active-previous-${stagingId}`);
    if (existsSync(staging) || existsSync(backup)) {
      throw new HermesProjectionError("projection_conflict");
    }
    mkdirSync(join(staging, "skills"), { recursive: true, mode: 0o700 });
    try {
      for (const diagnostic of diagnostics) {
        if (diagnostic.origin !== "published") continue;
        const source = join(
          expectedVersionRoot,
          "skills",
          diagnostic.scopedName,
        );
        const destination = join(staging, "skills", diagnostic.scopedName);
        copyProjectionTree(source, destination);
      }
      writeAndSync(
        join(staging, "diagnostics.json"),
        Buffer.from(`${JSON.stringify(diagnostics, null, 2)}\n`, "utf8"),
      );
      makeReadOnly(staging);
      const hadActiveProjection = existsSync(activeRoot);
      if (hadActiveProjection) this.rename(activeRoot, backup);
      let activated = false;
      try {
        this.rename(staging, activeRoot);
        activated = true;
        if (nextConfig !== currentConfig) {
          this.writeConfig(configPath, nextConfig);
        }
      } catch (error) {
        if (activated && existsSync(activeRoot)) {
          removeGeneratedTree(activeRoot);
        }
        if (hadActiveProjection && existsSync(backup)) {
          this.rename(backup, activeRoot);
        }
        throw error;
      }
      try {
        removeGeneratedTree(backup);
      } catch {
        // A stale generated backup is safer than rolling back a committed
        // config switch or touching any Profile-local data.
      }
      fsyncDirectory(installationRoot);
    } catch (error) {
      removeGeneratedTree(staging);
      throw error;
    }
    return {
      externalSkillsDirectory: input.projection.externalSkillsDirectory,
      diagnostics,
    };
  }
}
