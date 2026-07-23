# Real-device acceptance matrix

This runbook turns one signed Desktop candidate into privacy-safe, hash-bound device evidence. It does not authorize a release and cannot be completed with simulated records.

## Gate and roles

All four roles are mandatory for the same candidate manifest:

| Evidence role      | Required environment                                                                                 | Required install artifact       |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| `macos_current`    | Physical Apple Silicon Mac on the current supported major macOS                                      | Candidate DMG                   |
| `macos_previous`   | Different physical Apple Silicon Mac on the immediately previous supported major macOS               | Same candidate DMG              |
| `windows_physical` | Physical Windows 11 x64 machine                                                                      | Candidate NSIS setup executable |
| `windows_second`   | Different physical Windows 11 x64 machine or an independently administered trusted Windows 11 x64 VM | Candidate portable executable   |

Use two dedicated QA account references and two independently backup-authorized device references throughout all four records. References such as `qa-account:alpha` are labels from the protected test register, not email addresses, account IDs, device IDs, serial numbers, or hostnames.

The candidate must already have state `release_candidate_signed`. Local builds, unsigned dry runs, package inspection, unit tests, and simulator-only results cannot satisfy this gate.

## Coordinator: acquire and bind the candidate

Run these commands from the exact reviewed Desktop source checkout. Replace the uppercase placeholders; do not use a branch name in place of the 40-character SHA.

```bash
export AERA_SOURCE_SHA="0123456789abcdef0123456789abcdef01234567"
export AERA_CANDIDATE_RUN_ID="12345678901"
test "$(git rev-parse HEAD)" = "$AERA_SOURCE_SHA"

gh run download "$AERA_CANDIDATE_RUN_ID" \
  --repo bignormal/aera \
  --name "desktop-candidate-$AERA_SOURCE_SHA" \
  --dir "$PWD/.device-evidence-candidate"

cd "$PWD/.device-evidence-candidate"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check evidence/SHA256SUMS
else
  shasum -a 256 --check evidence/SHA256SUMS
fi
find artifacts -type f -print0 |
  while IFS= read -r -d '' artifact; do
    gh attestation verify "$artifact" \
      --repo bignormal/aera \
      --signer-workflow \
      github.com/bignormal/aera/.github/workflows/release-candidate.yml
  done
gh attestation verify candidate-manifest.json \
  --repo bignormal/aera \
  --signer-workflow \
  github.com/bignormal/aera/.github/workflows/release-candidate.yml

node ../scripts/release/verify-candidate.mjs candidate-manifest.json \
  --artifacts-dir artifacts \
  --runtime-lock evidence/agentera-runtime-seed.lock.json \
  --sbom evidence/sbom.spdx.json \
  --provenance evidence/provenance.json \
  --expected-source-sha "$AERA_SOURCE_SHA" \
  --expected-version "$(node -p "require('../package.json').version")"
```

Copy each platform artifact to the target through an approved integrity-preserving channel. On the device, compare its SHA-256 with `candidate-manifest.json` before installation. Preserve only the protected evidence URL and SHA-256 of the redacted verification log in the final JSON.

## macOS signature and platform proof

Run on each Mac before installing. Replace `CANDIDATE.dmg` with the downloaded DMG path.

```bash
set -euo pipefail
DMG_PATH="/approved/staging/CANDIDATE.dmg"
shasum -a 256 "$DMG_PATH"
hdiutil verify "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

MOUNT_ROOT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_ROOT" "$DMG_PATH"
trap 'hdiutil detach "$MOUNT_ROOT" || true; rmdir "$MOUNT_ROOT" || true' EXIT
APP_PATH=$(find "$MOUNT_ROOT" -maxdepth 2 -type d -name 'AgentEra Studio.app' -print)
test -n "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dv --verbose=4 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
test "$(uname -m)" = "arm64"
sw_vers
```

The redacted log may retain the Developer ID team identifier, command outcomes, coarse macOS version/build, architecture, artifact name, and artifact hash. Remove usernames, volumes, local paths, hostnames, serial numbers, account details, and any app data before upload.

## Windows signature and platform proof

Run in PowerShell on each Windows machine before installing or launching. Use the NSIS file for `windows_physical` and the portable file for `windows_second`.

```powershell
$ErrorActionPreference = "Stop"
$Artifact = "C:\ApprovedStaging\CANDIDATE.exe"
$ExpectedSha256 = "REPLACE_WITH_CANDIDATE_MANIFEST_SHA256"

$ActualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact).Hash.ToLowerInvariant()
if ($ActualSha256 -ne $ExpectedSha256) { throw "Candidate artifact hash differs" }

$Signature = Get-AuthenticodeSignature -LiteralPath $Artifact
if ($Signature.Status -ne "Valid") { throw "Authenticode is not valid" }
if (-not $Signature.SignerCertificate) { throw "Signer certificate is missing" }
if (-not $Signature.TimeStamperCertificate) { throw "Trusted timestamp is missing" }

signtool verify /pa /all /v $Artifact
if ($LASTEXITCODE -ne 0) { throw "signtool rejected the candidate" }
signtool verify /pa /all /tw /v $Artifact
if ($LASTEXITCODE -ne 0) { throw "signtool rejected the timestamp" }

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { throw "Device is not x64" }
Get-ComputerInfo |
  Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
```

The redacted log may retain the certificate thumbprint, verification outcomes, coarse Windows version/build, architecture, artifact name, and artifact hash. Remove usernames, drive paths, hostnames, serial numbers, account details, and application data.

## Privacy-safe device fingerprint

The evidence fingerprint distinguishes devices without retaining the hardware identifier. The release coordinator supplies a fresh random campaign salt through the protected QA channel. Never write the raw hardware identifier or salt to the evidence file or verification log.

On macOS:

```bash
read -r -s AERA_EVIDENCE_SALT
DEVICE_FINGERPRINT=$(
  {
    printf '%s:' "$AERA_EVIDENCE_SALT"
    ioreg -rd1 -c IOPlatformExpertDevice |
      awk -F'\"' '/IOPlatformUUID/{print $(NF-1)}'
  } | shasum -a 256 | awk '{print "sha256:" $1}'
)
unset AERA_EVIDENCE_SALT
printf '%s\n' "$DEVICE_FINGERPRINT"
```

On Windows PowerShell:

```powershell
$Salt = Read-Host "Evidence campaign salt" -AsSecureString
$SaltText = [System.Net.NetworkCredential]::new("", $Salt).Password
$HardwareId = (Get-CimInstance Win32_ComputerSystemProduct).UUID
$Bytes = [Text.Encoding]::UTF8.GetBytes("$SaltText`:$HardwareId")
$Fingerprint = "sha256:" + [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData($Bytes)
).ToLowerInvariant()
Remove-Variable Salt, SaltText, HardwareId, Bytes
$Fingerprint
```

Treat the resulting salted digest as protected QA metadata even though it is not a raw identifier. Every entry must have a different digest and UUIDv7 evidence ID.

## Scenario matrix

Run every scenario on every role. Set a schema field to `true` only after the expected result was observed on the exact installed artifact.

### Install, identity, and lifecycle

- `cleanInstall`: install or launch into a fresh application state without using an existing test result.
- `upgradeFromPriorStable`: upgrade a supported prior stable installation and preserve intended local state.
- `loginOnline`: authenticate the dedicated QA account and verify the registered device.
- `validOfflineEntitlement`: disconnect after a valid entitlement refresh, restart, and complete allowed official use without a Cloud fallback.
- `appRestart` and `osRestart`: verify state and Runtime selection after both application and OS restart.
- `uninstallReinstallPreservesProfile`: uninstall and reinstall without unintended deletion or rewriting of the user-owned Hermes Profile.

### Official Agent and RuntimeBinding

- `officialAgentInstall` and `officialAgentRun`: install the approved PLATFORM Agent and complete a real bound turn.
- `officialAgentUpdate`: activate the next immutable official release for later work.
- `officialAgentRollback`: apply append-only rollback selection.
- `existingRuntimeBindingStable`: prove the already-started conversation retains its original immutable binding through update/rollback.
- `newRuntimeBindingUsesSelectedRelease`: prove a later conversation receives the selected update or rollback release.

No scenario may move, rewrite, enumerate, or upload Profile Memory, private Skills, sessions, Curator state, credentials, or local learning.

### Quality privacy

- `qualityConsentOffNoUpload`: default-off consent produces no quality request.
- `qualityConsentOnFixedCodeOnly`: opt-in sends only the closed minimized envelope and fixed-code feedback.
- `qualityConsentRevocationStopsUpload`: revocation removes unsent rows for that purpose and prevents later upload.
- `noPrivateDataUploadCanary`: unique test canaries in prompt, response, Memory, private Skill, session, path, and attachment never appear in captured requests, headers, logs, Cloud data, or Admin data.

Store only the pass boolean and a redacted evidence link. Do not copy packet bodies containing account tokens or private test content into the final evidence.

### Encrypted backup and migration

- `encryptedBackupCreate`: create and seal a manual encrypted backup only while the Profile is idle.
- `backupInterruptedResume`: interrupt an upload and prove resumable completion.
- `backupDiskExhaustionFailsClosed`: force bounded staging/storage exhaustion and prove no incomplete restore replaces a Profile.
- `backupCiphertextCorruptionRejected`: tamper with ciphertext and prove restore rejection without Profile mutation.
- `backupWrongPhraseRejected`: use a deliberately wrong test phrase and prove rejection; never record either phrase.
- `backupRevokedDeviceRejected`: revoke an authorized test device and prove it cannot restore.
- `authorizedDeviceRestore`: restore through a separately authorized device into a fresh USER-owned Installation and Profile.
- `recoveryPhraseRestore`: restore on a third clean device using the test recovery phrase, without recording words or screenshots.
- `restoredSessionRules`: verify only the designed allowlisted session state is restored and no live RuntimeBinding is overwritten.

Use disposable QA Profiles and test accounts. Recovery words, Backup Root Keys, Data Encryption Keys, device private keys, credentials, environment files, local paths, filenames from encrypted manifests, and plaintext canaries must never enter evidence.

## Build the evidence record

Create one canonical JSON document conforming to `release/evidence.schema.json`. The `candidate` block must repeat the repository, exact source SHA, package version, and SHA-256 of the canonical `candidate-manifest.json`.

For each entry:

- use the role and exact artifact mandated above;
- repeat the candidate manifest digest and installed artifact SHA-256;
- bind the Developer ID team or Authenticode certificate thumbprint already recorded in the candidate;
- set `verificationLogSha256` to the SHA-256 of the redacted log;
- use only coarse OS version/build and `physical` or `trusted_vm`;
- include the same two opaque account and backup-device references;
- use HTTPS evidence links without credentials, query strings, fragments, raw IPs, or local addresses;
- include no free-form notes or extra fields.

Canonicalize with the same recursive key sorting as `candidate-manifest.mjs`, then run:

```bash
node scripts/release/verify-device-evidence.mjs \
  /protected/evidence/device-evidence.json \
  --candidate-manifest \
  /protected/candidate/candidate-manifest.json \
  --schema release/evidence.schema.json
```

Archive the evidence JSON, redacted logs, and immutable link targets in the protected release record. Do not commit real device evidence to the source repository.

## Stop conditions and current state

Stop immediately on a hash, attestation, signature, notarization, timestamp, architecture, Runtime Seed, privacy-canary, RuntimeBinding, backup, or restore discrepancy. A corrected source change requires a new candidate and a completely new four-device record; evidence from older bytes cannot be reused.

Until a remotely signed candidate, two physical Macs, one physical Windows machine, a second trusted Windows environment, two QA accounts, two authorized backup devices, and identified testers are available, this gate is `external_blocked`. Passing local verifier tests defines the gate but is not real-device acceptance.
