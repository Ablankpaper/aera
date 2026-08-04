# Internal Beta Desktop packaging

This runbook creates one checksummed, internal-only Desktop candidate for trusted company testers and signs its dedicated update metadata. A separate manual promotion workflow can later publish only those verified bytes without rebuilding, resigning, creating a tag, or creating a GitHub Release.

## Boundary

The dedicated `internal-beta.yml` workflow builds Apple Silicon macOS and Windows x64 packages from one exact Desktop commit whose three-platform `CI` run already succeeded. It uploads an immutable candidate and has no update-server credential or publication step. `internal-beta-promote.yml` accepts only that exact successful candidate run, rechecks its source, manifest, checksums, and Desktop update signature, and then publishes without rebuilding or signing.

The Beta.23 macOS packages require Developer ID signing, accepted Apple notarization, application and DMG stapling, strict code-signature verification, and Gatekeeper acceptance. The Windows packages require Authenticode signing with a trusted timestamp, x64 verification, and Runtime Seed verification. The manifest and provenance are also keyless-signed by the GitHub Actions workflow through Sigstore, but those evidence signatures are separate from platform signing.

Beta.22 was canceled before publication. Its version identity, notarization records, and candidate bytes must never be reused or promoted; this runbook permits only the immutable Beta.23 identity.

The separate Desktop update manifest is signed with an offline Ed25519 key whose public half is pinned in the app. This authenticates the exact ZIP/NSIS bytes but likewise does not turn them into platform-signed packages.

## Required protected environment

Create a GitHub environment named `internal-beta`. It contains only these reviewed public variables:

- `AERA_INTERNAL_BETA_ORIGIN`: the exact canonical HTTPS IP Origin, with no path or trailing slash;
- `AERA_INTERNAL_BETA_OFFLINE_KEY_ID`: the stable Beta offline-entitlement key ID;
- `AERA_INTERNAL_BETA_OFFLINE_PUBLIC_KEY`: the canonical unpadded base64url 32-byte Ed25519 public key.
- `AERA_DESKTOP_UPDATE_PUBLISH_HOST`: the exact internal-Beta server IPv4 address, read only by the promotion workflow.

It also contains these protected secrets:

- `CSC_LINK`: the encrypted or base64-encoded Developer ID Application signing identity accepted by Electron Builder;
- `CSC_KEY_PASSWORD`: the password for that signing identity;
- `ASC_API_KEY`: the base64-encoded App Store Connect API private key used only by `notarytool`;
- `ASC_KEY_ID`: the App Store Connect API key ID;
- `ASC_ISSUER_ID`: the App Store Connect API issuer ID;
- `WIN_CSC_LINK`: the encrypted or base64-encoded Windows Authenticode identity accepted by Electron Builder;
- `WIN_CSC_KEY_PASSWORD`: the password for that Windows signing identity;
- `AERA_DESKTOP_UPDATE_SIGNING_PRIVATE_KEY`: the PEM Ed25519 key matching `build/desktop-update-signing-public.pem`;
- `AERA_DESKTOP_UPDATE_PUBLISH_SSH_PRIVATE_KEY`: the key for the forced-command-only `aera-updates` host principal, read only by the promotion workflow;
- `AERA_DESKTOP_UPDATE_PUBLISH_SSH_KNOWN_HOSTS`: the pinned SSH host key line, read only by the promotion workflow.

The Origin is injected as `MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL`. The workflow constructs `MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON` from the same Origin and public key. [[src/main/agentera-auth/config.ts#parseAgenteraOfflinePublicKeysBuildConfig]] rejects any difference.

The Cloud offline-entitlement private key is never a GitHub variable or secret. The workflow may use the existing read-only cross-repository token to download the locked private Runtime release; it never checks out Runtime source.

## Dispatch

Use the merged Desktop `main` SHA and its successful `CI` run ID:

```bash
gh workflow run internal-beta.yml \
  --repo bignormal/aera \
  --ref main \
  -f source_sha=0123456789abcdef0123456789abcdef01234567 \
  -f ci_run_id=30100000001
```

The workflow refuses a non-`main` workflow identity, a source mismatch, a failed or incomplete CI matrix, a version other than `0.7.4-internal-beta.23`, malformed public trust, missing protected macOS or Windows signing credentials, or an unapproved Runtime Seed lock.

This dispatch ends after uploading `desktop-internal-beta-SOURCE_SHA`; it cannot change the live update channel. After the exact candidate passes the authorized pre-promotion checks, promote only its recorded run ID and source SHA:

```bash
gh workflow run internal-beta-promote.yml \
  --repo bignormal/aera \
  --ref main \
  -f source_sha=0123456789abcdef0123456789abcdef01234567 \
  -f candidate_run_id=30100000002
```

The promotion workflow rejects a failed, incomplete, differently sourced, or differently named candidate run. It downloads the 30-day artifact by run ID, checks `SHA256SUMS`, validates the canonical candidate identity, and verifies the signed Desktop update metadata before accessing the publisher credential.

## Built bytes

The platform jobs prepare and independently verify Runtime Seed candidate `dcb0f0bc6a0e2d18c55beedc6517dbc41d8b01e0` (`runtime-v0.18.2-agentera.1-rc.4`), rebuild native modules for the target architecture, compile the baked Beta trust, and package:

- `Aera-Internal-Beta-0.7.4-internal-beta.23-macos-arm64.dmg`
- `Aera-Internal-Beta-0.7.4-internal-beta.23-macos-arm64.zip`
- `Aera-Internal-Beta-0.7.4-internal-beta.23-windows-x64-setup.exe`
- `Aera-Internal-Beta-0.7.4-internal-beta.23-windows-x64-portable.exe`

The macOS Electron Builder overlay requires code signing and keeps `notarize: false` only because the workflow performs an explicit two-round Apple ceremony: sign the application, submit and wait on one recorded application submission ID, staple the accepted application, package final containers from that prepackaged application, then submit and wait on the recorded final DMG and ZIP IDs. This prevents an unrecorded duplicate submission or ad-hoc fallback. Windows keeps identity discovery disabled and remains unsigned. Every packaging command passes `--publish never`; publication occurs only after evidence assembly.

## Evidence layout

The final 30-day Actions artifact is named `desktop-internal-beta-SOURCE_SHA` and contains:

```text
artifacts/
  four immutable packages
desktop-update/
  manifest.json
  manifest.sig
evidence/
  agentera-runtime-seed.lock.json
  macos-evidence.json
  windows-evidence.json
  internal-beta.spdx.json
  internal-beta.provenance.json
  internal-beta-provenance.cosign.bundle.json
  internal-beta-manifest.cosign.bundle.json
runtime-seed/
  exact Darwin and Windows Runtime manifests
internal-beta-manifest.json
SHA256SUMS
```

[[scripts/internal-beta/manifest.mjs#buildInternalBetaManifest]] binds the exact source and CI run, version, HTTPS IP Origin, offline public trust, Runtime lock and both target identities, all four package sizes and SHA-256 values, SBOM/provenance hashes, strict macOS Developer ID/notarization/stapling/Gatekeeper evidence, accepted final DMG and ZIP submission IDs, Windows Authenticode signer/timestamp/x64/Seed evidence, and expected Sigstore identity. [[scripts/internal-beta/manifest.mjs#verifyInternalBetaManifestFiles]] re-hashes every referenced byte before signing.

Cosign `v3.0.6` signs the canonical manifest and SLSA v1 provenance as blobs. Verification requires the GitHub OIDC issuer and exact `internal-beta.yml@refs/heads/main` workflow identity. Syft `v1.44.0` creates the SPDX document. GitHub Artifact Attestations are not used.

## Online publication

The candidate assembly job verifies the detached update signature locally and uploads the complete 30-day evidence artifact without publishing it. Only a later manual `internal-beta-promote.yml` run downloads that exact successful-run artifact, rechecks every recorded SHA-256 plus the canonical manifest and update signature, and streams the fixed four-file tar archive to `aera-updates@AERA_DESKTOP_UPDATE_PUBLISH_HOST`. The host key is pinned and the authorized key must force `scripts/internal-beta/publish-desktop-update.sh`, disable PTY/forwarding, and grant no shell.

The server command verifies canonical metadata, the pinned key ID and Ed25519 signature, both artifact digests and sizes, version monotonicity, and immutable version bytes. A channel-wide file lock serializes the monotonicity check and publish operation. It stores artifacts under `/var/lib/aera/desktop-updates/internal-beta/releases/VERSION`, metadata under `versions/VERSION`, and atomically replaces only the relative `current` symlink. Caddy serves the reviewed path. Promotion fails unless live metadata equals the candidate bytes and both versioned artifacts answer an HTTPS range probe.

## Operator verification

Download the final artifact without rebuilding:

```bash
gh run download RUN_ID \
  --repo bignormal/aera \
  --name desktop-internal-beta-SOURCE_SHA \
  --dir ./desktop-internal-beta
```

From the downloaded directory:

```bash
sha256sum --check SHA256SUMS

cosign verify-blob \
  --bundle evidence/internal-beta-provenance.cosign.bundle.json \
  --certificate-identity-regexp \
  '^https://github\.com/bignormal/aera/\.github/workflows/internal-beta\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  evidence/internal-beta.provenance.json

cosign verify-blob \
  --bundle evidence/internal-beta-manifest.cosign.bundle.json \
  --certificate-identity-regexp \
  '^https://github\.com/bignormal/aera/\.github/workflows/internal-beta\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  internal-beta-manifest.json
```

Windows testers verify `SHA256SUMS` with `Get-FileHash -Algorithm SHA256`, then require both `signtool verify /pa /all /v` and `signtool verify /pa /all /tw /v` to succeed for the setup executable. The tester handoff records each expected package digest explicitly.

## Handoff limit

Do not dispatch promotion until the candidate workflow completed every real step and the pre-promotion operator record binds the same manifest hash, source SHA, CI/build run URLs, Origin, deployed Cloud/Admin digests, and package hashes. Do not describe a successful candidate as live publication; only the separate promotion run can change `current`.

The Beta.23 macOS package must pass ordinary Gatekeeper assessment and must not require an unidentified-developer override. The Windows package must have valid Authenticode and trusted timestamp verification; an unknown-publisher result stops acceptance. SmartScreen reputation can remain independent of a valid signature, but testers must never disable Gatekeeper, SmartScreen, antivirus, or system-wide security controls. A failed or replaced package receives a higher reviewed Beta version and new hashes rather than swapped bytes under the same filename.

`0.7.4-internal-beta.6` does not contain the online-update client. Testers must install `0.7.4-internal-beta.7` once through the existing manual handoff; subsequent Internal Beta versions use the signed online channel.
