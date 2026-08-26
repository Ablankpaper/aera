import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/**
 * The two pieces of operating-system evidence needed to own a daemonized
 * Gateway process.  `identity` is a process-creation token (not a PID), while
 * `image` is the executable image name observed at the same instant.
 */
export interface ProcessIdentityEvidence {
  identity: string;
  image: string;
}

type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => string | Buffer;

function normalizeIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

/** Normalize an OS image to a stable, case-insensitive basename. */
export function normalizeProcessImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized) return null;
  return basename(normalized).toLowerCase();
}

/**
 * Parse the compact POSIX `ps` shape used by the runtime reader.  The first
 * 24 characters are the portable `lstart` creation timestamp; the remainder
 * is the command/image column.  Keeping this parser pure makes lifecycle
 * tests deterministic and avoids depending on the host process table.
 */
export function parsePosixProcessIdentity(
  raw: string,
): ProcessIdentityEvidence | null {
  const value = raw.trim();
  const match = value.match(/^(.{24})\s+(.+)$/s);
  if (!match) return null;
  const identity = normalizeIdentity(`posix:${match[1]}`);
  const image = normalizeProcessImage(match[2]);
  if (!identity || !image) return null;
  return { identity, image };
}

/** Parse the bounded JSON object returned by the Windows CIM query. */
export function parseWindowsProcessIdentity(
  raw: string,
): ProcessIdentityEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  const rawIdentity = normalizeIdentity(value.CreationFileTimeUtc);
  const identity = rawIdentity ? `windows:${rawIdentity}` : null;
  const image = normalizeProcessImage(value.Name ?? value.ExecutablePath);
  if (!identity || !image) return null;
  return { identity, image };
}

function defaultExecFileSync(
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
): string | Buffer {
  return execFileSync(file, [...args], options as never);
}

/**
 * Read one process's creation identity and executable image.  Every command
 * is bounded and failures return unavailable evidence; callers must fail
 * closed instead of treating an unverified PID as owned.
 */
export function readProcessIdentityEvidence(
  pid: number,
  options: {
    platform?: NodeJS.Platform;
    execFileSync?: ExecFileSyncLike;
  } = {},
): ProcessIdentityEvidence | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  const run = options.execFileSync ?? defaultExecFileSync;
  try {
    if (platform === "win32") {
      const script =
        "$ErrorActionPreference='Stop'; " +
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
        "if ($null -eq $p) { Write-Output '' } else { " +
        "$p | Select-Object " +
        "@{Name='CreationFileTimeUtc';Expression={" +
        "$_.CreationDate.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)}}," +
        "Name,ExecutablePath | ConvertTo-Json -Compress }";
      const output = run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          timeout: 1_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return parseWindowsProcessIdentity(String(output));
    }

    const command = platform === "darwin" ? "/bin/ps" : "ps";
    const output = run(
      command,
      ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
      {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parsePosixProcessIdentity(String(output));
  } catch {
    return null;
  }
}

/**
 * Compare an observed image with the executable selected for the Runtime.
 * Python may be exposed as `python`, `python3`, or `pythonw` depending on the
 * platform and launcher, so compatible Python basenames are accepted; all
 * later ownership checks compare the exact normalized stored image.
 */
export function processImageMatchesExecutable(
  observedImage: string,
  executablePath: string,
): boolean {
  const observed = normalizeProcessImage(observedImage);
  const expected = normalizeProcessImage(executablePath);
  if (!observed || !expected) return false;
  if (observed === expected) return true;
  const observedPython = /^python(?:w|\d(?:\.\d+)?)?$/i.test(observed);
  const expectedPython = /^python(?:w|\d(?:\.\d+)?)?$/i.test(expected);
  return observedPython && expectedPython;
}

/** Exact equality for persisted ownership evidence. */
export function processEvidenceMatches(
  actual: ProcessIdentityEvidence | null | undefined,
  expected: ProcessIdentityEvidence | null | undefined,
): boolean {
  if (!actual || !expected) return false;
  const actualImage = normalizeProcessImage(actual.image);
  const expectedImage = normalizeProcessImage(expected.image);
  const actualIdentity = normalizeIdentity(actual.identity);
  const expectedIdentity = normalizeIdentity(expected.identity);
  return (
    actualIdentity !== null &&
    expectedIdentity !== null &&
    actualImage !== null &&
    expectedImage !== null &&
    actualIdentity === expectedIdentity &&
    actualImage === expectedImage
  );
}
