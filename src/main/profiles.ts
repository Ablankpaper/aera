import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { homedir } from "os";
import { promises as fs } from "fs";
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { HERMES_HOME, getEnhancedPath } from "./installer";
import { getRuntimeInvocation } from "./agentera-runtime-distribution/invocation";
import {
  getActiveProfileNameSync,
  isValidNamedProfileName,
  isValidProfileName,
  pidIsAliveAs,
  profileHome,
  PROFILE_NAME_ERROR,
} from "./utils";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import { readProfileMeta, defaultColorForName } from "./profile-meta";
import {
  createStagedProfileCandidate,
  StagedProfileError,
  type StagedProfileCandidate,
  type StagedProfileSourceKind,
} from "./model-configuration-staged-profile";
import { defaultModelConfigurationWriteAuthority } from "./model-configuration-write-authority";

const PROFILES_DIR = join(HERMES_HOME, "profiles");

function commandErrorMessage(err: unknown): string {
  const e = err as {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    message?: string;
  };
  const stdout = e.stdout?.toString().trim();
  const stderr = e.stderr?.toString().trim();
  return stdout || stderr || e.message || "Command failed";
}

export interface ProfileInfo {
  /** Stable internal profile id used for CLI, paths, routing, and persistence. */
  id: string;
  /** Compatibility name used by existing Profile management surfaces. */
  name: string;
  /** Explicit metadata display name, or null when the Profile is unnamed. */
  displayName: string | null;
  path: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  provider: string;
  hasEnv: boolean;
  hasSoul: boolean;
  skillCount: number;
  gatewayRunning: boolean;
  /** Resolved accent colour (stored override, else a stable default). */
  color: string;
  /** Avatar image as a data URL, or null when none is set. */
  avatar: string | null;
  /** Safe local link to an Agent installation; paths and owner data stay hidden. */
  agentInstallationId?: string | null;
  /** Opaque Runtime Profile identity used only to correlate local state. */
  runtimeProfileId?: string | null;
}

export interface CreateProfileResult {
  success: boolean;
  error?: string;
  id?: string;
}

export interface ProfileActivationGuard {
  authorize(): boolean | Promise<boolean>;
}

export interface PreparedProfileResult extends CreateProfileResult {
  candidate?: StagedProfileCandidate;
}

export interface LocalProfileLocation {
  id: string;
  path: string;
  isActive: boolean;
}

const MAX_PROFILE_NAME_LENGTH = 80;

function normalizeAgentName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MAX_PROFILE_NAME_LENGTH);
}

function slugBaseForAgentName(name: string): string {
  const slug = normalizeAgentName(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (!slug || slug === "default" || !isValidNamedProfileName(slug)) {
    return "agent";
  }
  return slug;
}

function profileIdExists(id: string): boolean {
  return id === "default" || existsSync(join(PROFILES_DIR, id));
}

export function profileIdForAgentName(agentName: string): string {
  const base = slugBaseForAgentName(agentName);
  if (!profileIdExists(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!profileIdExists(candidate)) return candidate;
  }
  return `${base.slice(0, 55)}-${Date.now().toString(36)}`;
}

const CLONE_SOURCE_FILES = [
  "config.yaml",
  ".env",
  "providers.json",
  "SOUL.md",
] as const;
const CLONE_SOURCE_SUBDIR_FILES = [
  "memories/MEMORY.md",
  "memories/USER.md",
] as const;

const STAGED_GLOBAL_FILES = ["models.json", "model-definitions.json"] as const;

function stageGlobalCatalog(stagingHome: string): void {
  for (const filename of STAGED_GLOBAL_FILES) {
    const sourcePath = join(HERMES_HOME, filename);
    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, join(stagingHome, filename));
    }
  }
}

function stageCloneSource(sourceProfileId: string, stagingHome: string): void {
  const source = profileHome(sourceProfileId);
  const destination =
    sourceProfileId === "default"
      ? stagingHome
      : join(stagingHome, "profiles", sourceProfileId);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const filename of CLONE_SOURCE_FILES) {
    const sourcePath = join(source, filename);
    if (!existsSync(sourcePath)) continue;
    copyFileSync(sourcePath, join(destination, filename));
  }
  const sourceSkills = join(source, "skills");
  if (existsSync(sourceSkills)) {
    cpSync(sourceSkills, join(destination, "skills"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  for (const relativePath of CLONE_SOURCE_SUBDIR_FILES) {
    const sourcePath = join(source, relativePath);
    if (!existsSync(sourcePath)) continue;
    const destinationPath = join(destination, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, destinationPath);
  }
}

async function readProfileConfig(profilePath: string): Promise<{
  model: string;
  provider: string;
}> {
  const configFile = join(profilePath, "config.yaml");
  try {
    const content = await fs.readFile(configFile, "utf-8");
    const modelMatch = content.match(/^\s*default:\s*["']?([^"'\n#]+)["']?/m);
    const providerMatch = content.match(
      /^\s*provider:\s*["']?([^"'\n#]+)["']?/m,
    );
    return {
      model: modelMatch ? modelMatch[1].trim() : "",
      provider: providerMatch ? providerMatch[1].trim() : "auto",
    };
  } catch {
    return { model: "", provider: "" };
  }
}

async function countSkills(profilePath: string): Promise<number> {
  const skillsDir = join(profilePath, "skills");
  try {
    const dirs = await fs.readdir(skillsDir);
    let count = 0;
    for (const d of dirs) {
      const sub = join(skillsDir, d);
      const stat = await fs.stat(sub);
      if (stat.isDirectory()) {
        const inner = await fs.readdir(sub);
        for (const f of inner) {
          try {
            await fs.access(join(sub, f, "SKILL.md"));
            count++;
          } catch {
            // not a skill
          }
        }
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function isGatewayRunning(profilePath: string): Promise<boolean> {
  const pidFile = join(profilePath, "gateway.pid");
  try {
    const raw = (await fs.readFile(pidFile, "utf-8")).trim();
    // The Python hermes CLI writes JSON: {"pid": <n>, "kind": ..., ...}.
    // Older builds wrote a bare integer, so fall back to parseInt.
    const parsed = raw.startsWith("{")
      ? (JSON.parse(raw) as { pid?: unknown }).pid
      : parseInt(raw, 10);
    const pid =
      typeof parsed === "number" && Number.isFinite(parsed) ? parsed : NaN;
    if (isNaN(pid)) return false;
    return pidIsAliveAs(pid, ["python", "pythonw"]);
  } catch {
    return false;
  }
}

async function getActiveProfileName(): Promise<string> {
  return getActiveProfileNameSync();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function listProfiles(
  allowedProfileIds?: ReadonlySet<string>,
): Promise<ProfileInfo[]> {
  const activeName = await getActiveProfileName();
  const profiles: ProfileInfo[] = [];

  // Default profile is HERMES_HOME itself
  if (!allowedProfileIds || allowedProfileIds.has("default")) {
    const [
      defaultConfig,
      defaultHasEnv,
      defaultHasSoul,
      defaultSkills,
      defaultGw,
      defaultMeta,
    ] = await Promise.all([
      readProfileConfig(HERMES_HOME),
      fileExists(join(HERMES_HOME, ".env")),
      fileExists(join(HERMES_HOME, "SOUL.md")),
      countSkills(HERMES_HOME),
      isGatewayRunning(HERMES_HOME),
      readProfileMeta("default"),
    ]);

    profiles.push({
      id: "default",
      name: defaultMeta.name || "default",
      displayName: defaultMeta.name || null,
      path: HERMES_HOME,
      isDefault: true,
      isActive: activeName === "default",
      model: defaultConfig.model,
      provider: defaultConfig.provider,
      hasEnv: defaultHasEnv,
      hasSoul: defaultHasSoul,
      skillCount: defaultSkills,
      gatewayRunning: defaultGw,
      color: defaultMeta.color || defaultColorForName("default"),
      avatar: defaultMeta.avatar || null,
    });
  }

  // Named profiles under ~/.hermes/profiles/
  if (existsSync(PROFILES_DIR)) {
    try {
      const dirs = await fs.readdir(PROFILES_DIR);
      const profilePromises = dirs.map(async (name) => {
        if (allowedProfileIds && !allowedProfileIds.has(name)) return null;
        // Skip dotfiles like .DS_Store so they don't get mistaken for profiles.
        if (name.startsWith(".")) return null;
        if (!isValidNamedProfileName(name)) return null;

        const profilePath = join(PROFILES_DIR, name);
        const stat = await fs.stat(profilePath);
        if (!stat.isDirectory()) return null;

        // Any subdirectory of ~/.hermes/profiles/ is treated as a profile.
        // We deliberately do NOT require config.yaml or .env to exist —
        // a freshly created profile may have neither yet, and filtering on
        // them silently hides it from the UI (issue #19).
        const [config, hasEnvFile, hasSoul, skillCount, gwRunning, meta] =
          await Promise.all([
            readProfileConfig(profilePath),
            fileExists(join(profilePath, ".env")),
            fileExists(join(profilePath, "SOUL.md")),
            countSkills(profilePath),
            isGatewayRunning(profilePath),
            readProfileMeta(name),
          ]);

        return {
          id: name,
          name: meta.name || name,
          displayName: meta.name || null,
          path: profilePath,
          isDefault: false,
          isActive: activeName === name,
          model: config.model,
          provider: config.provider,
          hasEnv: hasEnvFile,
          hasSoul: hasSoul,
          skillCount,
          gatewayRunning: gwRunning,
          color: meta.color || defaultColorForName(name),
          avatar: meta.avatar || null,
        } as ProfileInfo;
      });

      const resolved = await Promise.all(profilePromises);
      for (const p of resolved) {
        if (p) profiles.push(p);
      }
    } catch {
      // ignore
    }
  }

  return profiles;
}

/**
 * Metadata-only inventory for Aera ownership claims. It intentionally does
 * not open Profile config, Memory, USER, sessions, skills, or Curator files.
 */
export async function listLocalProfileLocations(): Promise<
  LocalProfileLocation[]
> {
  const activeName = await getActiveProfileName();
  const profiles: LocalProfileLocation[] = [
    {
      id: "default",
      path: HERMES_HOME,
      isActive: activeName === "default",
    },
  ];
  if (!existsSync(PROFILES_DIR)) return profiles;
  let names: string[];
  try {
    names = await fs.readdir(PROFILES_DIR);
  } catch {
    return profiles;
  }
  for (const id of names.sort()) {
    if (id.startsWith(".") || !isValidNamedProfileName(id)) continue;
    const path = join(PROFILES_DIR, id);
    try {
      if (!(await fs.stat(path)).isDirectory()) continue;
    } catch {
      continue;
    }
    profiles.push({ id, path, isActive: activeName === id });
  }
  return profiles;
}

function stagedProfileFailure(error: unknown): CreateProfileResult {
  if (
    error instanceof StagedProfileError &&
    error.code === "staged_profile_invalid"
  ) {
    return { success: false, error: "Staged Profile validation failed." };
  }
  if (
    error instanceof StagedProfileError &&
    error.code === "staged_profile_owner_changed"
  ) {
    return {
      success: false,
      error: "Staged Profile owner changed before activation.",
    };
  }
  return { success: false, error: commandErrorMessage(error) };
}

export async function prepareProfile(
  name: string,
  cloneFrom: string | null,
  reservedProfileId?: string,
  sourceKind: StagedProfileSourceKind = cloneFrom ? "clone" : "import",
): Promise<PreparedProfileResult> {
  const agentName = normalizeAgentName(name);
  if (!agentName) {
    return { success: false, error: "Agent name is required" };
  }
  const availableProfileId = profileIdForAgentName(agentName);
  if (
    reservedProfileId !== undefined &&
    (reservedProfileId !== availableProfileId ||
      !isValidNamedProfileName(reservedProfileId))
  ) {
    return { success: false, error: "Reserved Profile ID is unavailable." };
  }
  const id = reservedProfileId ?? availableProfileId;
  // `cloneFrom` may be "default" (not a "named" profile) or any valid named
  // profile; reject anything else so it can't reach the CLI as an argument.
  if (
    cloneFrom &&
    cloneFrom !== "default" &&
    !isValidNamedProfileName(cloneFrom)
  ) {
    return { success: false, error: PROFILE_NAME_ERROR };
  }

  // `--clone-from <source>` copies that profile's config/keys/skills and
  // implies `--clone`; omitting it creates a fresh profile.
  const args = cloneFrom
    ? ["profile", "create", id, "--clone-from", cloneFrom]
    : ["profile", "create", id];
  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    return { success: false, error: "Aera Runtime is not prepared." };
  }

  try {
    // Hermes does not create the named-profile parent when the first Profile
    // is created. The staged activation path renames into this directory, so
    // create it before preparing the candidate. This is also required for a
    // fresh installation whose HERMES_HOME only contains the default Profile.
    mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
    const candidate = await createStagedProfileCandidate({
      profilesRoot: PROFILES_DIR,
      destinationProfileId: id,
      sourceKind,
      materialize: async ({ stagingHome, stagingPath }) => {
        await defaultModelConfigurationWriteAuthority.run(
          {
            globalCatalog: true,
            profileIds: cloneFrom ? [cloneFrom] : [],
          },
          () => {
            stageGlobalCatalog(stagingHome);
            if (cloneFrom) stageCloneSource(cloneFrom, stagingHome);
          },
        );
        execFileSync(invocation.python, invocation.cliArgs(args), {
          cwd: invocation.workingDirectory,
          env: invocation.environment({
            ...process.env,
            PATH: getEnhancedPath(),
            HOME: homedir(),
            HERMES_HOME: stagingHome,
          }),
          stdio: "pipe",
          timeout: 30000,
          ...HIDDEN_SUBPROCESS_OPTIONS,
        });
        try {
          writeFileSync(
            join(stagingPath, "profile-meta.json"),
            JSON.stringify({ name: agentName }, null, 2),
            "utf-8",
          );
        } catch (err) {
          console.warn(
            `Created profile "${id}" but failed to write profile metadata:`,
            err,
          );
        }
      },
    });
    return { success: true, id, candidate };
  } catch (err) {
    return stagedProfileFailure(err);
  }
}

export async function createProfile(
  name: string,
  cloneFrom: string | null,
  reservedProfileId?: string,
  activation?: ProfileActivationGuard,
): Promise<CreateProfileResult> {
  const prepared = await prepareProfile(name, cloneFrom, reservedProfileId);
  if (!prepared.success || !prepared.id || !prepared.candidate) {
    return prepared;
  }
  try {
    await prepared.candidate.activate(activation);
    return { success: true, id: prepared.id };
  } catch (error) {
    return stagedProfileFailure(error);
  }
}

export async function deleteProfile(name: string): Promise<{
  success: boolean;
  error?: string;
}> {
  if (name === "default")
    return { success: false, error: "Cannot delete the default profile" };
  if (!isValidNamedProfileName(name)) {
    return { success: false, error: PROFILE_NAME_ERROR };
  }
  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    return { success: false, error: "Aera Runtime is not prepared." };
  }

  try {
    return await defaultModelConfigurationWriteAuthority.run(
      { globalCatalog: false, profileIds: [name] },
      () => {
        execFileSync(
          invocation.python,
          invocation.cliArgs(["profile", "delete", name, "--yes"]),
          {
            cwd: invocation.workingDirectory,
            env: invocation.environment({
              ...process.env,
              PATH: getEnhancedPath(),
              HOME: homedir(),
              HERMES_HOME,
            }),
            stdio: "pipe",
            timeout: 30000,
            ...HIDDEN_SUBPROCESS_OPTIONS,
          },
        );
        return { success: true };
      },
    );
  } catch (err) {
    return { success: false, error: commandErrorMessage(err) };
  }
}

export function setActiveProfile(name: string): void {
  if (!isValidProfileName(name)) {
    throw new Error(PROFILE_NAME_ERROR);
  }

  const invocation = getRuntimeInvocation();
  try {
    if (invocation === null) throw new Error("Runtime not prepared");
    execFileSync(
      invocation.python,
      invocation.cliArgs(["profile", "use", name]),
      {
        cwd: invocation.workingDirectory,
        env: invocation.environment({
          ...process.env,
          PATH: getEnhancedPath(),
          HOME: homedir(),
          HERMES_HOME,
        }),
        stdio: "pipe",
        timeout: 10000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
    );
  } catch {
    // ignore — verified and repaired below
  }

  // The CLI validates against LOCAL profiles and raises when the name exists
  // only on the SSH/remote host (or when there is no local install at all).
  // That failure is swallowed above, so before this fallback the selection
  // silently never persisted: ~/.hermes/active_profile kept its old value,
  // every relaunch reset the UI to `default`, and activeSshProfile() scoped
  // the unified SSH dashboard's data to the wrong profile. The desktop's
  // source of truth is the local active_profile file (getActiveProfileNameSync),
  // so when the CLI didn't move it, write it directly — `name` is already
  // validated, and "default" is a plain value here (readers treat a missing
  // file and the literal "default" identically).
  if (getActiveProfileNameSync() !== name) {
    try {
      mkdirSync(HERMES_HOME, { recursive: true });
      writeFileSync(join(HERMES_HOME, "active_profile"), `${name}\n`);
    } catch {
      // Filesystem write failed — nothing else to fall back to; the CLI
      // attempt above already didn't persist it either.
    }
  }
}
